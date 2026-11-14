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
