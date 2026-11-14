import type { ChangesResponse, SessionResponse, UploadRequest } from "../contract";
import { example } from "../contract/fixtures";
import { FieldHttpError, createFieldClient, type HttpFailure } from "./http";

const TOKEN = "rsf_" + "A".repeat(43);
type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function recordFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}
const clientWith = (fetchFn: typeof fetch, over: Partial<Parameters<typeof createFieldClient>[0]> = {}) =>
  createFieldClient({ host: "curitiba.rotasaude.example", getToken: async () => TOKEN, fetch: fetchFn, ...over });
const failureOf = async (run: () => Promise<unknown>): Promise<HttpFailure> => {
  try { await run(); } catch (err) { expect(err).toBeInstanceOf(FieldHttpError); return (err as FieldHttpError).failure; }
  throw new Error("expected a FieldHttpError");
};

test("token only in the Authorization header, never in the URL", async () => {
  const { calls, fetchFn } = recordFetch(200, example("session-acs.json"));
  const client = clientWith(fetchFn);
  await client.session();
  await client.changes("abc", 200);
  await client.reference();
  expect(calls.map((c) => c.url)).toEqual([
    "https://curitiba.rotasaude.example/field/v1/session",
    "https://curitiba.rotasaude.example/field/v1/changes?limit=200&cursor=abc",
    "https://curitiba.rotasaude.example/field/v1/reference",
  ]);
  for (const c of calls) {
    expect(c.url).not.toContain("rsf_");
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers.Accept).toBe("application/json");
    expect(c.headers["Content-Type"]).toBeUndefined();
    expect(c.headers.Host).toBeUndefined();
    expect(c.method).toBe("GET");
  }
});

test("session answers the contract's body", async () => {
  const body = example<SessionResponse>("session-acs.json");
  const { fetchFn } = recordFetch(200, body);
  expect(await clientWith(fetchFn).session()).toEqual(body);
});

test("changes: first page without cursor, default limit 200", async () => {
  const { calls, fetchFn } = recordFetch(200, example<ChangesResponse>("changes-last-page.json"));
  await clientWith(fetchFn).changes(null);
  expect(calls[0].url).toBe("https://curitiba.rotasaude.example/field/v1/changes?limit=200");
});

test("uploads posts { items } as JSON", async () => {
  const request = example<UploadRequest>("upload-household-location.json");
  const { calls, fetchFn } = recordFetch(200, { results: [] });
  await clientWith(fetchFn).uploads(request.items);
  expect(calls[0].method).toBe("POST");
  expect(calls[0].url).toBe("https://curitiba.rotasaude.example/field/v1/uploads");
  expect(calls[0].headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(calls[0].body!)).toEqual({ items: request.items });
});

test.each<[number, unknown, HttpFailure]>([
  [401, { error: "device_revoked" }, { kind: "revoked" }],
  [401, { error: "device_suspended" }, { kind: "suspended" }],
  [401, { error: "invalid_token" }, { kind: "suspended" }],
  [401, "", { kind: "suspended" }],
  [403, { error: "feature_disabled" }, { kind: "feature_disabled" }],
  [403, { error: "city_suspended" }, { kind: "server", status: 403, code: "city_suspended" }],
  [429, { error: "too_many_requests" }, { kind: "rate_limited" }],
  [503, { error: "city_schema_behind" }, { kind: "server", status: 503, code: "city_schema_behind" }],
  [500, "<html>erro</html>", { kind: "server", status: 500, code: null }],
  [404, { error: "map_not_found" }, { kind: "not_found", code: "map_not_found" }],
  [404, { error: "unknown_city" }, { kind: "not_found", code: "unknown_city" }],
  [404, "", { kind: "server", status: 404, code: null }],
  [416, { error: "range_not_satisfiable" }, { kind: "range" }],
  [422, { error: "invalid_request" }, { kind: "invalid", status: 422, code: "invalid_request" }],
  [413, { error: "payload_too_large" }, { kind: "invalid", status: 413, code: "payload_too_large" }],
  [415, { error: 42 }, { kind: "invalid", status: 415, code: null }],
])("maps %s %j", async (status, body, failure) => {
  const { fetchFn } = recordFetch(status, body);
  expect(await failureOf(() => clientWith(fetchFn).session())).toEqual(failure);
});

test("a 200 that is not JSON is a server failure, not a crash", async () => {
  const { fetchFn } = recordFetch(200, "<html>proxy</html>");
  expect(await failureOf(() => clientWith(fetchFn).session())).toEqual({ kind: "server", status: 200, code: null });
});

test("network failure and 20 s timeout → network", async () => {
  const down = jest.fn(async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch;
  expect(await failureOf(() => clientWith(down).session())).toEqual({ kind: "network" });

  jest.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const hang = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const pending = failureOf(() => clientWith(hang).session());
    await jest.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network" });
  } finally {
    jest.useRealTimers();
  }
});

test("devOrigin sends Host header with the QR host", async () => {
  const { calls, fetchFn } = recordFetch(200, example("session-acs.json"));
  await clientWith(fetchFn, { devOrigin: "http://10.0.2.2:3058" }).session();
  expect(calls[0].url).toBe("http://10.0.2.2:3058/field/v1/session");
  expect(calls[0].headers.Host).toBe("curitiba.rotasaude.example");
});

test("without a token nothing is sent: suspended", async () => {
  const { calls, fetchFn } = recordFetch(200, {});
  expect(await failureOf(() => clientWith(fetchFn, { getToken: async () => null }).session())).toEqual({ kind: "suspended" });
  expect(calls).toHaveLength(0);
});

test("mapRequest: where and with which headers; If-Range quotes the session's SHA-256 (Q34)", async () => {
  const { calls, fetchFn } = recordFetch(200, {});
  const client = clientWith(fetchFn);
  expect(await client.mapRequest()).toEqual({ url: "https://curitiba.rotasaude.example/field/v1/map", headers: { Authorization: `Bearer ${TOKEN}` } });
  const sha = "ab".repeat(32);
  expect((await client.mapRequest({ ifRange: sha })).headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "If-Range": `"${sha}"` });
  expect(calls).toHaveLength(0);
});

test("the error message carries kind and code, never the token or the body", async () => {
  const { fetchFn } = recordFetch(422, { error: "invalid_request", detail: "Maria das Dores" });
  try {
    await clientWith(fetchFn).session();
    throw new Error("expected a FieldHttpError");
  } catch (err) {
    expect((err as Error).message).toBe("field http invalid invalid_request");
    expect(JSON.stringify(err)).not.toMatch(/rsf_|Maria/);
  }
});

test("without an injected fetch the client uses the platform's, and nothing else in the app may", async () => {
  const body = example("session-acs.json");
  const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  try {
    const client = createFieldClient({ host: "curitiba.rotasaude.example", getToken: async () => TOKEN });
    expect(await client.session()).toEqual(body);
    expect(String(spy.mock.calls[0][0])).toBe("https://curitiba.rotasaude.example/field/v1/session");
  } finally {
    spy.mockRestore();
  }
});
