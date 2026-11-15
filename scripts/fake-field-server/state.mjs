// State and rules of the fake field-sync server (module 24c, Task 24). It answers from the
// examples of the pinned contract (contracts/field-sync, tag field-sync-v1.2.0) and keeps just
// enough state for the Maestro flows: the idempotency book, the version of each target and a
// one-shot script. It is a test double: the api decides for real, this only keeps the shapes.
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const SCHEMAS = ["session-response", "upload-request", "upload-response", "changes-response", "reference-response"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = ["home_visit", "home_visit_withdrawal", "collective_activity", "patient", "household", "family", "individual_registration"];
const VERSIONED = ["household", "family", "individual_registration"];
// Which accepted items a citation may point to (Q26, Q27).
const CITES = {
  patient_client_uuid: (receipt) => receipt.type === "patient" || receipt.createsPatient,
  household_client_uuid: (receipt) => receipt.type === "household",
  family_client_uuid: (receipt) => receipt.type === "family",
  visit_client_uuid: (receipt) => receipt.type === "home_visit",
};
const NAMESPACE = Buffer.from("5f1e1d5c0de04a7e9c0dfa4ef1e1d5c0", "hex");
const DEVICE_ERRORS = ["device_revoked", "device_suspended"];

export class ScriptError extends Error {}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const range = ({ min, max, decimals }) => ({ min, max, decimals });

// The offline reference a real city serves. The contract's example carries only an excerpt (two
// registration domains, empty visit and activity domains), and with it the forms open with no
// options. The visit and activity blocks are written from the contract's domains-v1.json the way
// the api builds them (HomeVisits::Json.domains, CollectiveActivities::Json.domains); the
// registration dictionaries are a copy of the api's config/ledi/registration_dictionaries.yml.
function fullReference(example, domains, dictionaries) {
  const visit = domains.home_visit;
  const activity = domains.collective_activity;
  const byType = Object.entries(activity.rules.by_activity_type);
  // "with_meeting_topic_6" is the contract's wording for: forbidden, unless that meeting topic is marked.
  const withTopic = /^with_meeting_topic_(\d+)$/;
  const topics = new Set(byType.flatMap(([, fields]) => Object.values(fields)).flatMap((rule) => (withTopic.test(rule) ? [Number(withTopic.exec(rule)[1])] : [])));
  return {
    ...example,
    registration_dictionaries: { version: dictionaries.ledi_version, ...dictionaries.registration_dictionaries },
    string_domains: dictionaries.string_domains,
    home_visit_domains: {
      motivo_visita: visit.motivo_visita.flatMap((group) => group.items.map((item) => ({ ...item, group: group.group, group_label: group.label }))),
      desfecho: visit.desfecho,
      turno: visit.turno,
      tipo_glicemia: visit.tipo_glicemia,
      tipo_de_imovel: visit.tipo_de_imovel,
      non_residential_property_types: visit.rules.non_residential_property_types,
      non_residential_reasons: visit.rules.non_residential_reasons,
      male_forbidden_reasons: visit.rules.male_forbidden_reasons,
      without_person_allowed_reasons: visit.rules.without_person_allowed_reasons,
      responsible_document_reasons: visit.rules.responsible_document_reasons,
      reasons_max: visit.rules.reasons_max,
      measurement_ranges: Object.fromEntries(Object.entries(visit.rules.measurements).filter(([, row]) => "min" in row).map(([key, row]) => [key, range(row)])),
    },
    collective_activity_domains: {
      activity_types: activity.tipo_atividade_coletiva,
      meeting_topics: activity.temas_para_reuniao,
      target_audience: activity.publico_alvo,
      health_topics: activity.temas_para_saude,
      health_practices: activity.praticas_em_saude,
      procedures: activity.outro_procedimento_coletivo,
      rules: {
        list_max: activity.rules.list_max,
        by_type: Object.fromEntries(byType.map(([type, fields]) => [type, Object.fromEntries(Object.entries(fields).map(([field, rule]) => [field, withTopic.test(rule) ? "forbidden" : rule]))])),
        health_topics_with_meeting_topic: [...topics].sort((a, b) => a - b),
        practices_only_in_type: Object.entries(activity.rules.practices_only_in_activity_type).map(([type, practices]) => ({ type: Number(type), practices })),
        procedure_practices: [activity.rules.procedure_code_with_practice],
        smoking_practices: activity.rules.smoking_with_practices,
        participant_measurements: Object.fromEntries(Object.entries(activity.rules.participant_measurements).map(([key, row]) => [key, range(row)])),
      },
    },
  };
}

// UUID v5 of the client_uuid: the same item always gets the same id.
function uuidV5(name) {
  const hash = createHash("sha1").update(NAMESPACE).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// JSON merge patch (RFC 7396).
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

// "/body/participants/1/new_patient" → "participants[1].new_patient" (Q32).
function contractPath(pointer) {
  return pointer
    .split("/")
    .filter(Boolean)
    .map((segment, index) => (/^\d+$/.test(segment) ? `[${segment}]` : (index ? "." : "") + segment))
    .join("");
}

function citations(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((entry, index) => citations(entry, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const at = path ? `${path}.${key}` : key;
    return key in CITES && typeof entry === "string" ? [{ key, path: at, client_uuid: entry }] : citations(entry, at);
  });
}

export function createState({ contractDir, mapFile }) {
  const read = (name) => JSON.parse(readFileSync(join(contractDir, name), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true, multipleOfPrecision: 8 });
  const validators = {};
  for (const name of SCHEMAS) {
    const schema = read(`${name}-v1.json`);
    ajv.addSchema(schema);
    validators[name] = ajv.getSchema(schema.$id);
  }

  const map = readFileSync(mapFile);
  const mapSha = createHash("sha256").update(map).digest("hex");
  const reference = fullReference(read("examples/reference.json"), read("domains-v1.json"), JSON.parse(readFileSync(join(FIXTURES, "registration-dictionaries.json"), "utf8")));
  if (!validators["reference-response"](reference)) throw new Error(`referência do servidor falso fora do esquema: ${ajv.errorsText(validators["reference-response"].errors)}`);
  const sessionExample = read("examples/session-acs.json");
  const firstPage = read("examples/changes-first-page.json");
  const lastPage = read("examples/changes-last-page.json");
  // Opaque cursors of the fake: after the first page, and after the last one.
  const CURSOR_FIRST = Buffer.from(JSON.stringify({ v: 1, fake: "after-first-page" })).toString("base64url");
  const CURSOR_END = Buffer.from(JSON.stringify({ v: 1, fake: "end" })).toString("base64url");
  const fixtures = new Map([...firstPage.items, ...lastPage.items].map((item) => [item.id, item]));

  let receipts;
  let versions;
  let script;
  let deadTokens;
  let mapAnswers;

  function reset() {
    receipts = new Map();
    versions = new Map();
    script = { nextUpload: null, currentPatch: null, nextStatus: null, nextMapCut: null };
    mapAnswers = { whole: 0, partial: 0, cut: 0 };
    deadTokens = new Map();
    for (const item of fixtures.values()) {
      if (Number.isInteger(item.body?.version)) versions.set(item.id, item.body.version);
    }
  }
  reset();

  // Problems of a value against a schema, as "<pointer> <keyword>" (never the values).
  function problems(schema, value) {
    const validate = validators[schema];
    return validate(value) ? [] : validate.errors.map((error) => `${error.instancePath || "/"} ${error.keyword}`);
  }

  function setScript(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ScriptError("script precisa ser um objeto");
    const { next_upload: nextUpload = null, current_patch: currentPatch = null, next_status: nextStatus = null, error = null, next_map: nextMap = null, ...rest } = body;
    if (Object.keys(rest).length) throw new ScriptError(`chave desconhecida: ${Object.keys(rest).join(", ")}`);
    if (nextUpload !== null && nextUpload !== "stale_version" && !/^rejected:[a-z_]+$/.test(nextUpload)) {
      throw new ScriptError('next_upload aceita "stale_version" ou "rejected:<code>"');
    }
    if (currentPatch !== null && (nextUpload !== "stale_version" || typeof currentPatch !== "object" || Array.isArray(currentPatch))) {
      throw new ScriptError("current_patch é um objeto e só vale com stale_version");
    }
    if (nextStatus !== null && (nextStatus !== 401 || !DEVICE_ERRORS.includes(error))) {
      throw new ScriptError("next_status aceita 401 com error device_revoked ou device_suspended");
    }
    if (nextStatus === null && error !== null) throw new ScriptError("error só vale com next_status");
    const cut = nextMap === null ? null : Number(/^cut:(\d+)$/.exec(nextMap)?.[1]);
    if (cut !== null && !(cut >= 1 && cut < map.length)) throw new ScriptError('next_map aceita "cut:<bytes>", com o corte dentro do arquivo');
    if (cut !== null) script.nextMapCut = cut;
    if (nextUpload !== null) Object.assign(script, { nextUpload, currentPatch });
    if (nextStatus !== null) script.nextStatus = error;
  }

  // The 401 a token gets, or null. A scripted revocation sticks to the token that met it.
  function deviceError(token) {
    if (deadTokens.has(token)) return deadTokens.get(token);
    if (script.nextStatus === null) return null;
    deadTokens.set(token, script.nextStatus);
    script.nextStatus = null;
    return deadTokens.get(token);
  }

  function session() {
    return {
      ...sessionExample,
      server_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      map: { version: sessionExample.map?.version ?? "2026-11-01", size_bytes: map.length, sha256: mapSha },
      reference_version: reference.reference_version,
    };
  }

  // { page } or { error } for GET /changes.
  function changes(cursor, limit) {
    if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)) return { error: "invalid_limit" };
    if (cursor === null) return { page: { ...firstPage, next_cursor: CURSOR_FIRST, has_more: true } };
    if (cursor === CURSOR_FIRST) return { page: { ...lastPage, next_cursor: CURSOR_END, has_more: false } };
    if (cursor === CURSOR_END) return { page: { ...lastPage, reset: false, items: [], removals: [], next_cursor: CURSOR_END, has_more: false } };
    return { error: "invalid_cursor" };
  }

  // The first schema error of an item, as the contract's `rejected` (Q31, Q32, Q2).
  function shapeError(item) {
    const validate = validators["upload-request"];
    if (validate({ items: [item] })) return null;
    const errors = validate.errors.filter((error) => error.keyword !== "if" && error.instancePath.startsWith("/items/0"));
    // A problem with the item's own keys (client_uuid, type) comes before any problem in the body.
    const ownKeys = errors.filter((error) => !error.instancePath.startsWith("/items/0/body"));
    const pool = ownKeys.length ? ownKeys : errors;
    const deepest = pool.reduce((a, b) => (b.instancePath.length > a.instancePath.length ? b : a), pool[0] ?? { instancePath: "/items/0", keyword: "type", params: {} });
    let pointer = deepest.instancePath.slice("/items/0".length);
    if (deepest.keyword === "required") pointer += `/${deepest.params.missingProperty}`;
    if (deepest.keyword === "additionalProperties") pointer += `/${deepest.params.additionalProperty}`;
    const inBody = pointer.startsWith("/body/");
    const path = inBody ? contractPath(pointer.slice("/body".length)) : contractPath(pointer) || "body";
    return { error: inBody && /^location\b/.test(path) ? "invalid_location" : "invalid_request", path };
  }

  // What the item changes: the row whose version it carries, and the id the result reports.
  function target(item, id) {
    const { body } = item;
    const cited = (clientUuid) => receipts.get(clientUuid)?.id;
    if (item.type === "household") return { row: body.household_id ?? id, id: body.household_id ?? id, isNew: !body.household_id };
    if (item.type === "family") {
      const household = body.household_id ?? cited(body.household_client_uuid);
      return { row: household, id: body.family_id ?? id, staleId: household, isNew: false };
    }
    return { row: body.registration_id ?? id, id: body.registration_id ?? id, isNew: !body.registration_id };
  }

  function processItem(item) {
    const head = {
      ...(item && typeof item === "object" && typeof item.client_uuid === "string" && UUID.test(item.client_uuid) ? { client_uuid: item.client_uuid } : {}),
      status: "rejected",
      ...(item && typeof item === "object" && TYPES.includes(item.type) ? { type: item.type } : {}),
    };
    const shape = shapeError(item);
    if (shape) return { ...head, ...shape };

    const known = receipts.get(item.client_uuid);
    if (known) {
      if (known.type !== item.type) return { ...head, error: "client_uuid_conflict" };
      return { ...head, status: "duplicate", id: known.id, ...(known.version === undefined ? {} : { version: known.version }) };
    }

    if (script.nextUpload?.startsWith("rejected:")) {
      const error = script.nextUpload.slice("rejected:".length);
      script.nextUpload = null;
      return { ...head, error };
    }

    for (const cite of citations(item.body)) {
      const receipt = receipts.get(cite.client_uuid);
      if (!receipt || !CITES[cite.key](receipt)) return { ...head, error: "not_found", path: cite.path };
    }

    const id = uuidV5(item.client_uuid);
    if (!VERSIONED.includes(item.type)) {
      receipts.set(item.client_uuid, { type: item.type, id });
      return { ...head, status: "accepted", id };
    }

    const where = target(item, id);
    const fixture = fixtures.get(where.row);
    if (script.nextUpload === "stale_version" && fixture && !where.isNew) {
      const currentVersion = Math.max(versions.get(where.row) ?? 0, item.body.version ?? 0) + 1;
      const current = { ...mergePatch(fixture.body, script.currentPatch ?? {}), version: currentVersion };
      Object.assign(script, { nextUpload: null, currentPatch: null });
      versions.set(where.row, currentVersion);
      fixtures.set(where.row, { ...fixture, body: current });
      return { ...head, status: "stale_version", id: where.staleId ?? where.id, current_version: currentVersion, current };
    }

    const version = where.isNew ? 1 : Math.max(versions.get(where.row) ?? 0, item.body.version ?? 0) + 1;
    versions.set(where.row, version);
    receipts.set(item.client_uuid, { type: item.type, id: where.id, version, createsPatient: item.type === "individual_registration" && "new_patient" in item.body });
    return { ...head, status: "accepted", id: where.id, version };
  }

  // { status, body } for POST /uploads (the envelope rule of Q31, then one result per item).
  function upload(body) {
    const envelope = body !== null && typeof body === "object" && !Array.isArray(body);
    const extra = envelope ? Object.keys(body).filter((key) => key !== "items") : [];
    if (!envelope) return { status: 422, body: { error: "invalid_request", path: "body" } };
    if (extra.length) return { status: 422, body: { error: "invalid_request", path: extra[0] } };
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
      return { status: 422, body: { error: "invalid_request", path: "items" } };
    }
    return { status: 200, body: { results: body.items.map(processItem) } };
  }

  // Where to cut the next whole download of the map, or null. One shot.
  function mapCut() {
    const cut = script.nextMapCut;
    script.nextMapCut = null;
    return cut;
  }

  function countMap(kind) {
    mapAnswers[kind] += 1;
  }

  function snapshot() {
    const accepted = {};
    for (const receipt of receipts.values()) accepted[receipt.type] = (accepted[receipt.type] ?? 0) + 1;
    return { accepted, script: { next_upload: script.nextUpload, next_status: script.nextStatus }, dead_tokens: deadTokens.size, map: { ...mapAnswers } };
  }

  return { map, mapSha, reference, problems, reset, setScript, deviceError, session, changes, upload, snapshot, mapCut, countMap };
}

export function newToken() {
  return `rsf_${randomBytes(32).toString("base64url")}`;
}
