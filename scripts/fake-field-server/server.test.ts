/**
 * @jest-environment node
 */
// Black-box test of the fake field-sync server the Maestro flows talk to (module 24c, Task 24).
// The server runs as a child process, as in CI; every 200 is checked against the contract.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

const ROOT = join(__dirname, "../..");
const CONTRACT = join(ROOT, "contracts/field-sync");
const SERVER = join(__dirname, "server.mjs");
const MAP = readFileSync(join(__dirname, "fixtures/sample.pmtiles"));
const MAP_SHA = createHash("sha256").update(MAP).digest("hex");
const TOKEN = "rsf_" + "Ab3_-".repeat(8) + "xyz";
const OTHER_TOKEN = "rsf_" + "Zz9_-".repeat(8) + "abc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, any>;
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; json: () => Json };

const ajv = new Ajv2020({ strict: false, allErrors: true, multipleOfPrecision: 8 });
const schemaIds = new Map<string, string>();
for (const name of ["session-response", "upload-request", "upload-response", "changes-response", "reference-response"]) {
  const schema = JSON.parse(readFileSync(join(CONTRACT, `${name}-v1.json`), "utf8")) as { $id: string };
  ajv.addSchema(schema);
  schemaIds.set(name, schema.$id);
}

function expectValid(schema: string, value: unknown): void {
  const validate = ajv.getSchema(schemaIds.get(schema) ?? "");
  if (!validate) throw new Error(`unknown schema ${schema}`);
  if (!validate(value)) {
    throw new Error(`${schema}: ${(validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.keyword}`).join("; ")}`);
  }
}

const example = (name: string): Json => JSON.parse(readFileSync(join(CONTRACT, "examples", name), "utf8"));

let server: ChildProcess;
let port = 0;

function call(method: string, path: string, options: { token?: string | null; headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Reply> {
  const token = options.token === undefined ? TOKEN : options.token;
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body.toString("utf8")) as Json });
      });
      // A reply the server cut half-way never ends: say how much arrived.
      res.on("close", () => { if (!res.complete) reject(new Error(`truncated:${Buffer.concat(chunks).length}`)); });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const upload = (items: unknown[], token?: string) => call("POST", "/field/v1/uploads", { body: { items }, token });
const script = (body: Json) => call("POST", "/__script", { body, token: null });

beforeAll(async () => {
  server = spawn(process.execPath, [SERVER, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    let err = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match) resolve(Number(match[1]));
    });
    server.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    server.on("exit", (code) => reject(new Error(`fake server exited (${code}): ${err.slice(-400)}`)));
  });
});

afterAll(() => {
  server.kill();
});

beforeEach(async () => {
  expect((await call("POST", "/__reset", { token: null })).status).toBe(204);
});

describe("authentication", () => {
  test("without a well-formed bearer token every field route answers 401 invalid_token", async () => {
    for (const token of [null, "rsf_short"]) {
      for (const path of ["/field/v1/session", "/field/v1/reference", "/field/v1/changes", "/field/v1/map"]) {
        const reply = await call("GET", path, { token });
        expect([path, reply.status, reply.json()]).toEqual([path, 401, { error: "invalid_token" }]);
      }
    }
  });

  test("the token is never accepted in the URL", async () => {
    expect((await call("GET", `/field/v1/session?token=${TOKEN}`, { token: null })).status).toBe(401);
  });
});

describe("session, reference and changes", () => {
  test("session follows the schema and describes the fixture map", async () => {
    const reply = await call("GET", "/field/v1/session");
    expect(reply.status).toBe(200);
    const session = reply.json();
    expectValid("session-response", session);
    expect(session.contract).toBe("field-sync-v1");
    expect(session.map).toEqual({ version: expect.any(String), size_bytes: MAP.length, sha256: MAP_SHA });
    expect(Math.abs(Date.parse(session.server_time) - Date.now())).toBeLessThan(60_000);
  });

  test("reference follows the schema and its version is the one the session announces", async () => {
    const reference = (await call("GET", "/field/v1/reference")).json();
    expectValid("reference-response", reference);
    expect((await call("GET", "/field/v1/session")).json().reference_version).toBe(reference.reference_version);
  });

  // The contract's example carries only an excerpt: with it the forms open with no options and the activity form breaks.
  test("reference carries what the forms need: the whole registration dictionaries and the visit and activity domains", async () => {
    const reference = (await call("GET", "/field/v1/reference")).json();
    const domains = JSON.parse(readFileSync(join(CONTRACT, "domains-v1.json"), "utf8"));

    const dictionaries = reference.registration_dictionaries;
    expect(dictionaries.version).toBe("8.7.0");
    expect(Object.keys(dictionaries.domains).length).toBeGreaterThanOrEqual(39);
    expect(Object.keys(dictionaries.sections).sort()).toEqual(["health_conditions", "identification", "living_conditions", "sociodemographic", "street_situation"]);
    for (const [section, fields] of Object.entries<unknown[]>(dictionaries.sections)) expect([section, fields.length > 0]).toEqual([section, true]);
    expect(reference.string_domains.uf).toHaveLength(27);
    expect(reference.string_domains.tipo_logradouro.length).toBeGreaterThan(100);

    const visit = reference.home_visit_domains;
    const reasons = domains.home_visit.motivo_visita.flatMap((group: Json) => group.items);
    expect(visit.motivo_visita.map((row: Json) => row.code)).toEqual(reasons.map((row: Json) => row.code));
    expect(visit.motivo_visita[0]).toEqual({ code: 1, label: "Cadastramento / Atualização", group: "TIPO_VISITA", group_label: "Tipo de visita" });
    expect(visit.desfecho).toEqual(domains.home_visit.desfecho);
    expect(visit.tipo_de_imovel).toEqual(domains.home_visit.tipo_de_imovel);
    expect(visit.reasons_max).toBe(domains.home_visit.rules.reasons_max);
    expect(visit.measurement_ranges.weight_kg).toEqual({ min: 0.5, max: 500, decimals: 3 });
    expect(Object.keys(visit.measurement_ranges).sort()).toEqual(["diastolic", "glucose_mg_dl", "height_cm", "systolic", "temperature_c", "weight_kg"]);

    const activity = reference.collective_activity_domains;
    expect(activity.activity_types).toEqual(domains.collective_activity.tipo_atividade_coletiva);
    expect(activity.health_topics).toEqual(domains.collective_activity.temas_para_saude);
    expect(activity.procedures).toEqual(domains.collective_activity.outro_procedimento_coletivo);
    // The rules in the shape the api serves them (CollectiveActivities::Json.domains), not the contract's prose.
    expect(Object.keys(activity.rules).sort()).toEqual([
      "by_type", "health_topics_with_meeting_topic", "list_max", "participant_measurements", "practices_only_in_type", "procedure_practices", "smoking_practices",
    ]);
    expect(Object.keys(activity.rules.by_type)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(activity.rules.by_type["1"]).toEqual({ meeting_topics: "required", target_audience: "forbidden", health_topics: "forbidden", health_practices: "forbidden", participants: "optional" });
    expect(activity.rules.by_type["6"]).toEqual({ meeting_topics: "forbidden", target_audience: "required", health_topics: "optional", health_practices: "required", participants: "required" });
    expect(activity.rules.health_topics_with_meeting_topic).toEqual([6]);
    expect(activity.rules.practices_only_in_type).toEqual([{ type: 6, practices: [2, 9, 33] }]);
    expect(activity.rules.procedure_practices).toEqual([30]);
    expect(activity.rules.smoking_practices).toEqual([25, 26, 27, 28]);
    expect(activity.rules.list_max).toEqual(domains.collective_activity.rules.list_max);
    expect(activity.rules.participant_measurements).toEqual({ weight_kg: { min: 0.5, max: 500, decimals: 3 }, height_cm: { min: 20, max: 250, decimals: 1 } });
  });

  // The api stores the street type as the dictionary's code ("081"); the contract's examples carry its label ("RUA"),
  // and a household served that way cannot be saved again on the tablet.
  test("households come with the street type as a code of the reference, the way the api stores it", async () => {
    const codes = (await call("GET", "/field/v1/reference")).json().string_domains.tipo_logradouro.map((row: Json) => row.code);
    const first = (await call("GET", "/field/v1/changes?limit=200")).json();
    const households = first.items.filter((item: Json) => item.type === "household");
    expect(households.length).toBeGreaterThan(0);
    for (const household of households) expect(codes).toContain(household.body.address.street_type);
    expectValid("changes-response", first);
  });

  test("changes serves the first page, then the last one with who-to-visit, then nothing new", async () => {
    const first = (await call("GET", "/field/v1/changes?limit=200")).json();
    expectValid("changes-response", first);
    expect(first.has_more).toBe(true);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.who_to_visit).toBeNull();

    const last = (await call("GET", `/field/v1/changes?limit=200&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
    expectValid("changes-response", last);
    expect(last.has_more).toBe(false);
    expect(last.who_to_visit).not.toBeNull();
    expect(last.next_cursor).not.toBe(first.next_cursor);

    const again = (await call("GET", `/field/v1/changes?cursor=${encodeURIComponent(last.next_cursor)}`)).json();
    expectValid("changes-response", again);
    expect(again).toMatchObject({ reset: false, items: [], removals: [], has_more: false });
  });

  test("an unknown cursor and a bad limit are refused with the codes of the contract", async () => {
    expect((await call("GET", "/field/v1/changes?cursor=nope")).json()).toEqual({ error: "invalid_cursor" });
    expect((await call("GET", "/field/v1/changes?limit=501")).json()).toEqual({ error: "invalid_limit" });
    expect((await call("GET", "/field/v1/changes?limit=0")).status).toBe(422);
  });
});

describe("uploads", () => {
  test("every valid example of the contract is answered within the response schema", async () => {
    const suite = (example("manifest.json").suites as Json[]).find((s) => s.schema === "upload-request-v1.json");
    const valid = (suite?.cases as Json[]).filter((c) => c.expect === "valid");
    expect(valid.length).toBeGreaterThan(10);
    for (const { file } of valid) {
      const reply = await call("POST", "/field/v1/uploads", { body: example(file) });
      expect([file, reply.status]).toEqual([file, 200]);
      expectValid("upload-response", reply.json());
    }
  });

  test("accepted carries a stable id; the same client_uuid again is a duplicate with the same id", async () => {
    const items = example("upload-patient.json").items as Json[];
    const first = (await upload(items)).json().results[0];
    expect(first).toMatchObject({ client_uuid: items[0].client_uuid, status: "accepted", type: "patient" });
    expect(first.id).toMatch(UUID);
    expect(first.version).toBeUndefined();
    expect((await upload(items)).json().results[0]).toEqual({ ...first, status: "duplicate" });
  });

  test("the same client_uuid with another type is rejected", async () => {
    const [patient] = example("upload-patient.json").items as Json[];
    const [visit] = example("upload-home-visit-resident.json").items as Json[];
    await upload([patient]);
    expect((await upload([{ ...visit, client_uuid: patient.client_uuid }])).json().results[0]).toMatchObject({
      status: "rejected",
      error: "client_uuid_conflict",
    });
  });

  test("household, family and registration answer with the next version of their target (Q5)", async () => {
    const [household] = example("upload-household-update.json").items as Json[];
    const accepted = (await upload([household])).json().results[0];
    expect(accepted).toMatchObject({ status: "accepted", id: household.body.household_id, version: household.body.version + 1 });
    expect((await upload([household])).json().results[0]).toMatchObject({ status: "duplicate", version: accepted.version });

    const again = { ...household, client_uuid: "c0ffee99-0000-4000-8000-000000000099", body: { ...household.body, version: accepted.version } };
    expect((await upload([again])).json().results[0]).toMatchObject({ status: "accepted", version: accepted.version + 1 });
  });

  test("a registration that created the person can be cited by its client_uuid (Q26)", async () => {
    const batch = example("upload-registration-same-batch.json").items as Json[];
    const results = (await upload(batch)).json().results as Json[];
    expect(results.map((r) => r.status)).toEqual(batch.map(() => "accepted"));
  });

  test("citing a client_uuid that was never accepted is rejected not_found with the path", async () => {
    const [visit] = example("upload-home-visit-resident.json").items as Json[];
    const body = { ...visit.body };
    delete body.patient_id;
    body.patient_client_uuid = "c0ffee77-0000-4000-8000-000000000077";
    const result = (await upload([{ ...visit, body }])).json().results[0];
    expect(result).toMatchObject({ status: "rejected", error: "not_found", path: "patient_client_uuid" });
    expect(result.id).toBeUndefined();
  });

  test("an invalid envelope is a 422 for the whole batch (Q31)", async () => {
    for (const body of [{}, { items: [] }, { items: "x" }, { items: [{}], extra: 1 }, []]) {
      const reply = await call("POST", "/field/v1/uploads", { body });
      expect([reply.status, reply.json().error]).toEqual([422, "invalid_request"]);
    }
    const reply = await call("POST", "/field/v1/uploads", { raw: "{not json" });
    expect([reply.status, reply.json().error]).toEqual([422, "invalid_request"]);
  });

  test("an item outside the schema is rejected alone, with its path, and the batch goes on", async () => {
    const [visit] = example("upload-home-visit-resident.json").items as Json[];
    const [patient] = example("upload-patient.json").items as Json[];
    const results = (await upload([{ ...visit, body: { ...visit.body, surprise: true } }, { type: "home_visit", body: {} }, patient])).json()
      .results as Json[];
    expect(results[0]).toEqual({ client_uuid: visit.client_uuid, status: "rejected", type: "home_visit", error: "invalid_request", path: "surprise" });
    expect(results[1]).toMatchObject({ status: "rejected", error: "invalid_request", path: "client_uuid" });
    expect(results[1].client_uuid).toBeUndefined();
    expect(results[2].status).toBe("accepted");
  });

  test("a schema error under location is invalid_location (Q2)", async () => {
    const [visit] = example("upload-home-visit-location.json").items as Json[];
    const body = { ...visit.body, location: { ...visit.body.location, latitude: 91 } };
    expect((await upload([{ ...visit, body }])).json().results[0]).toMatchObject({
      status: "rejected",
      error: "invalid_location",
      path: "location.latitude",
    });
  });

  test("only JSON is accepted", async () => {
    const reply = await call("POST", "/field/v1/uploads", { raw: "items=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect([reply.status, reply.json()]).toEqual([415, { error: "json_required" }]);
  });
});

describe("script", () => {
  test("stale_version answers the next update with the current row, patched as the flow asks", async () => {
    const [household] = example("upload-household-update.json").items as Json[];
    expect((await script({ next_upload: "stale_version", current_patch: { contact_phone: "41988887777" } })).status).toBe(204);
    const reply = (await upload([household])).json();
    expectValid("upload-response", reply);
    expect(reply.results[0]).toMatchObject({
      status: "stale_version",
      type: "household",
      id: household.body.household_id,
      current_version: household.body.version + 1,
      current: { id: household.body.household_id, version: household.body.version + 1, contact_phone: "41988887777" },
    });
    // One shot, and nothing went to the idempotency book: the resend with the new version is processed.
    const resend = { ...household, body: { ...household.body, version: household.body.version + 1 } };
    expect((await upload([resend])).json().results[0]).toMatchObject({ status: "accepted", version: household.body.version + 2 });
  });

  test("rejected:<code> refuses the next item once", async () => {
    const [visit] = example("upload-home-visit-resident.json").items as Json[];
    await script({ next_upload: "rejected:day_closed" });
    expect((await upload([visit])).json().results[0]).toEqual({ client_uuid: visit.client_uuid, status: "rejected", type: "home_visit", error: "day_closed" });
    expect((await upload([visit])).json().results[0].status).toBe("accepted");
  });

  test.each(["device_revoked", "device_suspended"])("401 %s kills that token; a new QR works again", async (error) => {
    await script({ next_status: 401, error });
    expect((await call("GET", "/field/v1/session")).json()).toEqual({ error });
    expect((await call("GET", "/field/v1/changes")).status).toBe(401);
    expect((await call("GET", "/field/v1/session", { token: OTHER_TOKEN })).status).toBe(200);
  });

  test("a script outside the list is refused", async () => {
    expect((await script({ next_upload: "explode" })).status).toBe(422);
    expect((await script({ next_status: 500 })).status).toBe(422);
  });
});

// Module 35a: the endemic agent's profile, scripted once and kept until /__reset. Without it every answer is the ACS's.
describe("the endemic agent profile (35a)", () => {
  const ace = () => script({ profile: "ace" });
  const state = async () => (await call("GET", "/__state", { token: null })).json();
  const pages = async (): Promise<Json[]> => {
    const first = (await call("GET", "/field/v1/changes?limit=200")).json();
    const last = (await call("GET", `/field/v1/changes?limit=200&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
    return [first, last];
  };
  // The fake's server_time is in UTC (Z): the tablet's city day is the UTC day.
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  test("the session is the contract's endemic agent, with the switch on", async () => {
    expect((await ace()).status).toBe(204);
    const session = (await call("GET", "/field/v1/session")).json();
    expectValid("session-response", session);
    const { server_time: _time, map: _map, reference_version: _version, ...rest } = example("session-endemic-agent.json");
    expect(session).toMatchObject(rest);
    expect(session.professional.cbo).toBe("515140");
    expect(session.features.vector_control).toBe(true);
    expect(session.map).toEqual({ version: expect.any(String), size_bytes: MAP.length, sha256: MAP_SHA });
  });

  test("the reference carries the vector domains of domains-v1.json and the products of the fixture, within the schema", async () => {
    const acs = (await call("GET", "/field/v1/reference")).json();
    await ace();
    const reference = (await call("GET", "/field/v1/reference")).json();
    expectValid("reference-response", reference);
    const vector = JSON.parse(readFileSync(join(CONTRACT, "domains-v1.json"), "utf8")).vector_control;
    const products = JSON.parse(readFileSync(join(__dirname, "fixtures/vector-products.json"), "utf8")).products;
    const domains = reference.vector_control_domains;
    for (const key of ["activities", "work_types", "situations", "deposit_groups", "measure_methods", "risk_classes", "limits"]) {
      expect([key, domains[key]]).toEqual([key, vector[key]]);
    }
    expect(domains.products).toEqual(products);
    for (const method of ["focal", "perifocal", "spatial"]) expect([method, products.some((p: Json) => p.uses.includes(method))]).toEqual([method, true]);
    expect(domains.parameters).toEqual(example("reference-vector-control.json").vector_control_domains.parameters);
    // The rest is the ACS's reference; another version, so a tablet that changes profile downloads it again.
    const { vector_control_domains: _domains, reference_version: version, ...rest } = reference;
    const { reference_version: acsVersion, ...acsRest } = acs;
    expect(rest).toEqual(acsRest);
    expect(version).not.toBe(acsVersion);
    expect((await call("GET", "/field/v1/session")).json().reference_version).toBe(version);
  });

  test("changes serve the vector page: the four new entities, the households with their profile, the open paddle 5 days old", async () => {
    await ace();
    const [first, last] = await pages();
    expectValid("changes-response", first);
    expectValid("changes-response", last);
    expect([first.has_more, last.has_more]).toEqual([true, false]);
    expect(last.who_to_visit).not.toBeNull();
    const items = [...first.items, ...last.items] as Json[];
    const types = new Set(items.map((item) => item.type));
    for (const type of ["micro_area", "household", "city_block", "ovitrap", "liraa_item", "transmission_block"]) expect([type, types.has(type)]).toEqual([type, true]);

    const vectorPage = example("changes-vector-page.json").items as Json[];
    for (const entity of vectorPage.filter((item) => !["ovitrap", "household"].includes(item.type))) expect(items).toContainEqual(entity);
    // The vector page's household, moved to the agent's micro-area (I1) and otherwise as the contract wrote it.
    const vectorHousehold = vectorPage.find((item) => item.type === "household") as Json;
    const served = items.find((item) => item.id === vectorHousehold.id) as Json;
    expect({ ...served.body, micro_area: null }).toEqual({ ...vectorHousehold.body, micro_area: null });
    const ovitrap = items.find((item) => item.type === "ovitrap") as Json;
    expect(ovitrap.id).toBe(vectorPage.find((item) => item.type === "ovitrap")?.id);
    expect(ovitrap.body.open_reading).toEqual({ installed_on: daysAgo(5) });
    expect(ovitrap.body.last_reading.collected_on).toBe(daysAgo(5));

    // Gate on: every household carries the key (null = no profile yet, Q6); one of them is in the agent's own micro-area.
    const households = items.filter((item) => item.type === "household");
    for (const household of households) expect([household.id, "vector" in household.body]).toEqual([household.id, true]);
    expect(households.some((h) => h.body.vector === null && h.body.families.length === 0)).toBe(true);
  });

  // The api serves the agent only the micro-areas assigned to him (FieldSync::Changes, Scope.for) and refuses out_of_scope
  // elsewhere: a flow must not prove accepted what the api would never serve (review I1).
  test("everything of the territory is inside the session's micro-areas: micro-areas, households, residents, ovitraps, who to visit", async () => {
    await ace();
    const session = (await call("GET", "/field/v1/session")).json();
    const areas = new Set((session.teams as Json[]).flatMap((team) => (team.micro_areas as Json[]).map((area) => area.id)));
    const [first, last] = await pages();
    const items = [...first.items, ...last.items] as Json[];
    const of = (type: string) => items.filter((item) => item.type === type);
    expect(of("micro_area").map((area) => area.id)).toEqual([...areas]);
    const households = new Set(of("household").map((household) => household.id));
    for (const household of of("household")) expect([household.id, areas.has(household.body.micro_area.id)]).toEqual([household.id, true]);
    expect(of("registration").length).toBeGreaterThan(0);
    for (const registration of of("registration")) {
      expect([registration.id, areas.has(registration.body.micro_area.id), households.has(registration.body.household_id)]).toEqual([registration.id, true, true]);
    }
    expect(of("ovitrap").length).toBeGreaterThan(0);
    for (const ovitrap of of("ovitrap")) expect([ovitrap.id, households.has(ovitrap.body.household_id)]).toEqual([ovitrap.id, true]);
    for (const item of of("liraa_item")) expect([item.id, households.has(item.body.household_id)]).toEqual([item.id, true]);
    const who = last.who_to_visit.micro_areas as Json[];
    expect(who.flatMap((area) => area.people as Json[]).length).toBeGreaterThan(0);
    for (const area of who) {
      expect(areas.has(area.micro_area_id)).toBe(true);
      for (const person of area.people as Json[]) {
        expect([person.patient_id, areas.has(person.micro_area.id), households.has(person.household.id)]).toEqual([person.patient_id, true, true]);
      }
    }
  });

  test("the ACS profile has none of it: no vector key, no vector domains, no switch", async () => {
    const session = (await call("GET", "/field/v1/session")).json();
    expect(session.professional.cbo).toBe("515105");
    expect(session.features.vector_control).toBeUndefined();
    expect((await call("GET", "/field/v1/reference")).json().vector_control_domains).toBeUndefined();
    const items = (await pages()).flatMap((page) => page.items as Json[]);
    expect(items.filter((item) => item.type === "household").length).toBeGreaterThan(0);
    for (const item of items) {
      expect(["micro_area", "household", "registration"]).toContain(item.type);
      if (item.type === "household") expect("vector" in item.body).toBe(false);
    }
  });

  test("/__reset brings the ACS profile back", async () => {
    await ace();
    expect((await state()).profile).toBe("ace");
    await call("POST", "/__reset", { token: null });
    expect((await state()).profile).toBe("acs");
    expect((await call("GET", "/field/v1/session")).json().professional.cbo).toBe("515105");
  });

  test("a profile outside the list is refused", async () => {
    for (const profile of ["acE", "agent", 1]) {
      const reply = await script({ profile });
      expect([profile, reply.status, reply.json().error]).toEqual([profile, 422, "invalid_script"]);
    }
  });
});

describe("ovitraps and the bulletin (35a)", () => {
  const state = async () => (await call("GET", "/__state", { token: null })).json();

  test("an installation and the collection that cites it in the same batch answer with the same id, the ovitrap's (Q7(2))", async () => {
    const items = example("upload-ovitrap-same-batch.json").items as Json[];
    const reply = (await upload(items)).json();
    expectValid("upload-response", reply);
    const [installation, collection] = reply.results;
    expect(installation).toMatchObject({ client_uuid: items[0].client_uuid, status: "accepted", type: "ovitrap_installation" });
    expect(collection).toMatchObject({ client_uuid: items[1].client_uuid, status: "accepted", type: "ovitrap_collection", id: installation.id });
    expect(installation.id).toMatch(UUID);
    expect((await state()).accepted).toEqual({ ovitrap_installation: 1, ovitrap_collection: 1 });
  });

  test("a collection of a downloaded ovitrap answers with the ovitrap's id", async () => {
    const [collection] = example("upload-ovitrap-collection.json").items as Json[];
    const result = (await upload([collection])).json().results[0];
    expect(result).toMatchObject({ status: "accepted", type: "ovitrap_collection", id: collection.body.ovitrap_id });
    expect((await upload([collection])).json().results[0]).toEqual({ ...result, status: "duplicate" });
  });

  test("a collection of an ovitrap the server never had is rejected not_found at ovitrap_id", async () => {
    const [, unknown] = example("upload-ovitrap-collection.json").items as Json[];
    expect((await upload([unknown])).json().results[0]).toEqual({
      client_uuid: unknown.client_uuid, status: "rejected", type: "ovitrap_collection", error: "not_found", path: "ovitrap_id",
    });
  });

  // Q33: the collection reinstalls unless it removes; reinstall false without remove is the api's invalid_request.
  test("a collection with reinstall false and no remove is rejected invalid_request at reinstall", async () => {
    const [collection] = example("upload-ovitrap-collection.json").items as Json[];
    for (const body of [{ ...collection.body, reinstall: false, remove: false }, (({ remove: _r, ...rest }) => ({ ...rest, reinstall: false }))(collection.body)]) {
      const result = (await upload([{ ...collection, body }])).json().results[0];
      expect(result).toEqual({ client_uuid: collection.client_uuid, status: "rejected", type: "ovitrap_collection", error: "invalid_request", path: "reinstall" });
    }
    expect((await upload([{ ...collection, body: { ...collection.body, reinstall: false, remove: true } }])).json().results[0].status).toBe("accepted");
  });

  test("an installation without the consent is rejected consent_required at consent", async () => {
    const [installation] = example("upload-ovitrap-installation.json").items as Json[];
    const result = (await upload([{ ...installation, body: { ...installation.body, consent: false } }])).json().results[0];
    expect(result).toEqual({ client_uuid: installation.client_uuid, status: "rejected", type: "ovitrap_installation", error: "consent_required", path: "consent" });
    expect((await upload([installation])).json().results[0].status).toBe("accepted");
  });

  test("a collection citing an installation never accepted is rejected not_found at ovitrap_client_uuid", async () => {
    const [, collection] = example("upload-ovitrap-same-batch.json").items as Json[];
    const result = (await upload([collection])).json().results[0];
    expect(result).toEqual({ client_uuid: collection.client_uuid, status: "rejected", type: "ovitrap_collection", error: "not_found", path: "ovitrap_client_uuid" });
  });

  test("a visit with the bulletin is accepted with the inspection's id, and the state counts inspections, samples and derived reasons", async () => {
    const [visit] = example("upload-home-visit-vector-inspection.json").items as Json[];
    const [plain] = example("upload-home-visit-resident.json").items as Json[];
    const reply = (await upload([visit, plain])).json();
    expectValid("upload-response", reply);
    expect(reply.results[0]).toEqual({ client_uuid: visit.client_uuid, status: "accepted", type: "home_visit", id: expect.stringMatching(UUID), vector_inspection_id: expect.stringMatching(UUID) });
    expect(reply.results[1].vector_inspection_id).toBeUndefined();
    expect((await state()).vector).toEqual({ inspections: 1, samples: 2, bodies_with_derived_reasons: 0, activities: ["li_t"] });
    // The duplicate brings the inspection's id too, as the api's ledger does (Upload.ledger).
    const again = (await upload([visit])).json();
    expectValid("upload-response", again);
    expect(again.results[0]).toEqual({ ...reply.results[0], status: "duplicate" });

    // The api derives 34–37 and refuses them in the body (reason_derived); the fake takes them and counts the body, so a flow sees the leak.
    const leaked = { ...visit, client_uuid: "c0ffee35-0000-4000-8000-000000000001", body: { ...visit.body, reasons: [35] } };
    expect((await upload([leaked])).json().results[0].status).toBe("accepted");
    expect((await state()).vector).toEqual({ inspections: 2, samples: 4, bodies_with_derived_reasons: 1, activities: ["li_t", "li_t"] });
  });

  test("a visit at a household of the same batch cites it by household_client_uuid", async () => {
    const household = (example("upload-home-visit-new-household.json").items as Json[]).find((item) => item.type === "household") as Json;
    const [visit] = example("upload-home-visit-vector-inspection-pe.json").items as Json[];
    const body = { ...visit.body, household_client_uuid: household.client_uuid };
    delete body.household_id;
    const results = (await upload([household, { ...visit, body }])).json().results as Json[];
    expect(results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect((await state()).vector).toMatchObject({ inspections: 1, activities: ["pe"] });
  });

  // CV-4: a schema error under /body/vector_inspection is vector_inspection_invalid, at the deepest path there.
  test("a bulletin outside the schema is rejected vector_inspection_invalid with the path of the contract's cases", async () => {
    const suite = (example("manifest.json").suites as Json[]).find((s) => s.schema === "upload-request-v1.json");
    const cases = (suite?.cases as Json[]).filter((c) => c.file.startsWith("invalid-vector-inspection-"));
    expect(cases.length).toBeGreaterThan(10);
    for (const { file, expect: wanted } of cases) {
      const pointer = (wanted as string).split(" ")[0].slice("/items/0/body/".length);
      const path = pointer.split("/").map((part, i) => (/^\d+$/.test(part) ? `[${part}]` : (i ? "." : "") + part)).join("");
      const result = (await upload(example(file).items)).json().results[0];
      expect([file, result.error, result.path]).toEqual([file, "vector_inspection_invalid", path]);
    }
  });

  test("rejected:sample_label_taken refuses the next visit with samples at its first sample, once", async () => {
    const [household] = example("upload-household-update.json").items as Json[];
    const [visit] = example("upload-home-visit-vector-inspection.json").items as Json[];
    await script({ next_upload: "rejected:sample_label_taken" });
    const results = (await upload([household, visit])).json().results as Json[];
    expect(results[0].status).toBe("accepted");
    expect(results[1]).toEqual({ client_uuid: visit.client_uuid, status: "rejected", type: "home_visit", error: "sample_label_taken", path: "vector_inspection.samples[0]" });
    expect((await upload([visit])).json().results[0].status).toBe("accepted");
  });
});

describe("map", () => {
  const etag = `"${MAP_SHA}"`;

  test("the whole file, with its SHA-256 as ETag", async () => {
    const reply = await call("GET", "/field/v1/map");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/vnd.pmtiles");
    expect(reply.headers.etag).toBe(etag);
    expect(reply.headers["accept-ranges"]).toBe("bytes");
    expect(reply.body.equals(MAP)).toBe(true);
  });

  test("Range: bytes=0-99 answers 206 with 100 bytes", async () => {
    const reply = await call("GET", "/field/v1/map", { headers: { Range: "bytes=0-99" } });
    expect(reply.status).toBe(206);
    expect(reply.headers["content-range"]).toBe(`bytes 0-99/${MAP.length}`);
    expect(reply.body.equals(MAP.subarray(0, 100))).toBe(true);
  });

  test("an open range resumes to the end when If-Range is the SHA of the session (Q34)", async () => {
    const reply = await call("GET", "/field/v1/map", { headers: { Range: "bytes=500000-", "If-Range": etag } });
    expect(reply.status).toBe(206);
    expect(reply.headers["content-range"]).toBe(`bytes 500000-${MAP.length - 1}/${MAP.length}`);
    expect(reply.body.equals(MAP.subarray(500000))).toBe(true);
  });

  test("If-Range of another SHA answers 200 with the whole file", async () => {
    const reply = await call("GET", "/field/v1/map", { headers: { Range: "bytes=100-199", "If-Range": `"${"0".repeat(64)}"` } });
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBe(MAP.length);
  });

  test("a range past the end answers 416 range_not_satisfiable", async () => {
    const reply = await call("GET", "/field/v1/map", { headers: { Range: `bytes=${MAP.length}-` } });
    expect(reply.status).toBe(416);
    expect(reply.headers["content-range"]).toBe(`bytes */${MAP.length}`);
    expect(reply.json()).toEqual({ error: "range_not_satisfiable" });
  });

  test("If-None-Match of the same SHA answers 304", async () => {
    expect((await call("GET", "/field/v1/map", { headers: { "If-None-Match": etag } })).status).toBe(304);
  });
});

describe("reset", () => {
  // A scripted conflict rewrites the row the server holds; the next flow must not inherit it.
  test("forgets what a scripted stale_version changed in a row", async () => {
    const [household] = example("upload-household-update.json").items as Json[];
    const street = example("changes-first-page.json").items.find((item: Json) => item.id === household.body.household_id).body.address.street;
    const stale = async (clientUuid: string, patch: Json) => {
      await script({ next_upload: "stale_version", current_patch: patch });
      return (await upload([{ ...household, client_uuid: clientUuid }])).json().results[0];
    };

    await call("POST", "/__reset", { token: null });
    const first = await stale("7f3c1a52-9b1e-4c6d-8a2f-0d4e5f6a7b01", { address: { street: "das Palmeiras" } });
    expect([first.status, first.current.address.street]).toEqual(["stale_version", "das Palmeiras"]);

    await call("POST", "/__reset", { token: null });
    const second = await stale("7f3c1a52-9b1e-4c6d-8a2f-0d4e5f6a7b02", { contact_phone: "41933334444" });
    expect([second.status, second.current.contact_phone]).toEqual(["stale_version", "41933334444"]);
    expect(second.current.address.street).toBe(street);
    expect(second.current_version).toBe(first.current_version);
  });
});

describe("a map download cut half-way (the resume of Q34 on a real device)", () => {
  const etag = `"${MAP_SHA}"`;

  test("the scripted cut drops the connection once, a Range resumes it, and the state counts each answer", async () => {
    await call("POST", "/__reset", { token: null });
    expect((await script({ next_map: "cut:300000" })).status).toBe(204);

    const cut = await call("GET", "/field/v1/map").then(() => "whole", (error: Error) => error.message);
    expect(cut).toMatch(/^truncated:\d+$/);
    const arrived = Number(cut.split(":")[1]);
    expect(arrived).toBeGreaterThan(0);
    expect(arrived).toBeLessThanOrEqual(300000);

    const rest = await call("GET", "/field/v1/map", { headers: { Range: `bytes=${arrived}-`, "If-Range": etag } });
    expect(rest.status).toBe(206);
    expect(rest.body.equals(MAP.subarray(arrived))).toBe(true);

    // One shot: the next whole download is complete.
    expect((await call("GET", "/field/v1/map")).body.equals(MAP)).toBe(true);
    expect((await call("GET", "/__state", { token: null })).json().map).toEqual({ whole: 1, partial: 1, cut: 1 });
  });

  test("the cut point has to fall inside the file", async () => {
    for (const next_map of ["cut:0", "cut:abc", `cut:${MAP.length}`, "slow"]) {
      const reply = await script({ next_map });
      expect([next_map, reply.status, reply.json().error]).toEqual([next_map, 422, "invalid_script"]);
    }
  });
});

describe("qr.mjs", () => {
  test("prints a payload the app reads: prefix, host and a token of the right shape", () => {
    const out = execFileSync(process.execPath, [join(__dirname, "qr.mjs"), "curitiba.localhost"], { encoding: "utf8" }).trim();
    expect(out).toMatch(/^rotasaude-field:v1:[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(out.slice("rotasaude-field:v1:".length), "base64url").toString("utf8")) as Json;
    expect(Object.keys(payload).sort()).toEqual(["host", "token"]);
    expect(payload.host).toBe("curitiba.localhost");
    expect(payload.token).toMatch(/^rsf_[A-Za-z0-9_-]{43}$/);
  });

  test("refuses a host with scheme, port or path", () => {
    for (const host of ["http://curitiba.localhost", "curitiba.localhost:8787", "localhost", ""]) {
      expect(() => execFileSync(process.execPath, [join(__dirname, "qr.mjs"), host], { stdio: "pipe" })).toThrow();
    }
  });
});
