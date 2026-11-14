#!/usr/bin/env node
// Fake field-sync server for the Maestro flows (module 24c, Task 24). Test double only.
//
//   node scripts/fake-field-server/server.mjs [--port 8787] [--host 127.0.0.1] [--contract <dir>]
//
// Routes of the contract (Bearer rsf_… on all of them):
//   GET  /field/v1/session    GET /field/v1/reference    GET /field/v1/changes?cursor=&limit=
//   POST /field/v1/uploads    GET /field/v1/map  (Range, If-Range, If-None-Match; Q34)
// Control, only here:
//   POST /__script  { "next_upload": "stale_version" | "rejected:<code>", "current_patch": {…} }
//                   { "next_status": 401, "error": "device_revoked" | "device_suspended" }
//   POST /__reset   GET /__state
// Every 200 of the contract is validated against its schema before it leaves.
// The emulator reaches the host's loopback at 10.0.2.2, so the default bind is 127.0.0.1.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptError, createState } from "./state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = /^Bearer (rsf_[A-Za-z0-9_-]{43})$/;
const MAX_BODY = 2 * 1024 * 1024;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const port = Number(option("port", "8787"));
const host = option("host", "127.0.0.1");
const state = createState({
  contractDir: resolve(option("contract", join(here, "../../contracts/field-sync"))),
  mapFile: join(here, "fixtures/sample.pmtiles"),
});

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...(payload && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
    ...(payload ? { "Content-Length": payload.length } : {}),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload ?? undefined);
}

// A contract answer: refused here if it is outside its schema, so a drifted fixture is loud.
function sendContract(res, schema, body) {
  const problems = state.problems(schema, body);
  if (problems.length) {
    process.stderr.write(`fake-field-server: resposta fora do esquema ${schema}: ${[...new Set(problems)].join("; ")}\n`);
    return send(res, 500, { error: "fake_server_invalid_response", schema });
  }
  send(res, 200, body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => (size > MAX_BODY ? reject(new HttpError(413, "payload_too_large")) : resolveBody(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "json_required");
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, "invalid_request");
  }
}

function sendMap(req, res) {
  const { map, mapSha } = state;
  const etag = `"${mapSha}"`;
  const headers = { "Content-Type": "application/vnd.pmtiles", ETag: etag, "Accept-Ranges": "bytes", "Cache-Control": "no-cache, private" };
  if (req.headers["if-none-match"] === etag) return send(res, 304, undefined, headers);

  const range = req.headers.range;
  const ifRange = req.headers["if-range"];
  const single = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range);
  // Another unit or several ranges, or an If-Range of another file: the whole file (Q34).
  if (!single || (ifRange !== undefined && ifRange !== etag)) return send(res, 200, map, headers);

  const [, from, to] = single;
  const start = from === "" ? map.length - Number(to) : Number(from);
  const end = from === "" || to === "" ? map.length - 1 : Math.min(Number(to), map.length - 1);
  if ((from === "" && to === "") || start < 0 || start >= map.length || end < start) {
    return send(res, 416, { error: "range_not_satisfiable" }, { "Content-Range": `bytes */${map.length}`, "Cache-Control": "no-store" });
  }
  send(res, 206, map.subarray(start, end + 1), { ...headers, "Content-Range": `bytes ${start}-${end}/${map.length}` });
}

async function control(req, res, path) {
  if (req.method === "POST" && path === "/__reset") {
    state.reset();
    return send(res, 204);
  }
  if (req.method === "GET" && path === "/__state") return send(res, 200, state.snapshot());
  if (req.method === "POST" && path === "/__script") {
    try {
      state.setScript(await readJson(req));
    } catch (error) {
      if (!(error instanceof ScriptError)) throw error;
      return send(res, 422, { error: "invalid_script", detail: error.message });
    }
    return send(res, 204);
  }
  send(res, 404, { error: "not_found" });
}

async function field(req, res, url) {
  const token = TOKEN.exec(req.headers.authorization ?? "")?.[1];
  if (!token) return send(res, 401, { error: "invalid_token" });
  const dead = state.deviceError(token);
  if (dead) return send(res, 401, { error: dead });

  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /field/v1/session") return sendContract(res, "session-response", state.session());
  if (route === "GET /field/v1/reference") return sendContract(res, "reference-response", state.reference);
  if (route === "GET /field/v1/map") return sendMap(req, res);
  if (route === "GET /field/v1/changes") {
    const { page, error } = state.changes(url.searchParams.get("cursor"), url.searchParams.get("limit"));
    return error ? send(res, 422, { error }) : sendContract(res, "changes-response", page);
  }
  if (route === "POST /field/v1/uploads") {
    const { status, body } = state.upload(await readJson(req));
    return status === 200 ? sendContract(res, "upload-response", body) : send(res, status, body);
  }
  send(res, 404, { error: "not_found" });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const handler = url.pathname.startsWith("/__") ? control(req, res, url.pathname) : field(req, res, url);
  handler
    .catch((error) => {
      if (error instanceof HttpError) return send(res, error.status, { error: error.code });
      process.stderr.write(`fake-field-server: ${error.stack ?? error}\n`);
      if (!res.headersSent) send(res, 500, { error: "fake_server_error" });
    })
    // One line per request: method, path and status. Never a body, a query or a header.
    .finally(() => process.stderr.write(`${req.method} ${url.pathname} ${res.statusCode}\n`));
});

server.listen(port, host, () => {
  process.stdout.write(`listening on http://${host}:${server.address().port}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
