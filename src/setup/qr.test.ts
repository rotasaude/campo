import { QR_PREFIX, parseQrPayload } from "./qr";

const TOKEN = "rsf_" + "Ab3_-".repeat(8) + "xyz";
const SUFFIXES = [".rotasaude.example"];
const b64url = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
const qr = (value: unknown) => QR_PREFIX + b64url(value);

test("valid payload", () => {
  expect(TOKEN).toHaveLength(47);
  expect(parseQrPayload(qr({ host: "curitiba.rotasaude.example", token: TOKEN }), SUFFIXES))
    .toEqual({ ok: true, host: "curitiba.rotasaude.example", token: TOKEN });
});

test("the payload the api writes (unpadded base64url of compact JSON) is read whatever its length", () => {
  for (const host of ["a.rotasaude.example", "ab.rotasaude.example", "abc.rotasaude.example", "abcd.rotasaude.example"]) {
    expect(parseQrPayload(qr({ host, token: TOKEN }), SUFFIXES)).toEqual({ ok: true, host, token: TOKEN });
  }
});

test.each(["", "http://x", "https://curitiba.rotasaude.example/field", "rotasaude-field:v2:" + b64url({ host: "curitiba.rotasaude.example", token: TOKEN })])(
  "not a Rota Saúde QR: %s", (text) => {
    expect(parseQrPayload(text, SUFFIXES)).toEqual({ ok: false, reason: "not_rotasaude" });
  });

test.each([
  ["empty", QR_PREFIX],
  ["not base64url", QR_PREFIX + "%%%"],
  ["padded", qr({ host: "a.rotasaude.example", token: TOKEN }) + "="],
  ["not JSON", qr("not json")],
  ["an array", qr("[]")],
  ["null", qr("null")],
  ["without token", qr({ host: "curitiba.rotasaude.example" })],
  ["without host", qr({ token: TOKEN })],
  ["token of another shape", qr({ host: "curitiba.rotasaude.example", token: "rsf_short" })],
  ["token with a line break", qr({ host: "curitiba.rotasaude.example", token: TOKEN.slice(0, 46) + "\n" })],
  ["host that is not text", qr({ host: 42, token: TOKEN })],
  ["non-ASCII bytes", qr({ host: "curitibá.rotasaude.example", token: TOKEN })],
])("malformed: %s", (_name, text) => {
  expect(parseQrPayload(text, SUFFIXES)).toEqual({ ok: false, reason: "malformed" });
});

test.each([
  "https://curitiba.rotasaude.example", "curitiba.rotasaude.example:8443", "curitiba.rotasaude.example/x", "user@curitiba.rotasaude.example",
  "Curitiba.rotasaude.example", "curitiba.rotasaude.example.", "localhost", "curitiba..rotasaude.example", " curitiba.rotasaude.example",
])("host with scheme, port, path, capitals or odd shape refused: %s", (host) => {
  expect(parseQrPayload(qr({ host, token: TOKEN }), SUFFIXES)).toEqual({ ok: false, reason: "malformed" });
});

test.each([
  "curitiba.rotasaude.example.evil.test", "evilrotasaude.example", "curitiba.evil.test", "rotasaude.example.evil.test",
])("foreign host refused: %s", (host) => {
  expect(parseQrPayload(qr({ host, token: TOKEN }), SUFFIXES)).toEqual({ ok: false, reason: "host_not_allowed" });
});

test("the suffix list: with or without the leading dot, several entries, and an empty list allows nothing", () => {
  const text = qr({ host: "curitiba.rotasaude.example", token: TOKEN });
  expect(parseQrPayload(text, ["rotasaude.example"]).ok).toBe(true);
  expect(parseQrPayload(text, [".outra.example", " .ROTASAUDE.example "]).ok).toBe(true);
  expect(parseQrPayload(text, [])).toEqual({ ok: false, reason: "host_not_allowed" });
  expect(parseQrPayload(text, ["", "."])).toEqual({ ok: false, reason: "host_not_allowed" });
  // Without the dot the suffix itself is a host; with it, only what is under it.
  expect(parseQrPayload(qr({ host: "rotasaude.example", token: TOKEN }), ["rotasaude.example"]).ok).toBe(true);
  expect(parseQrPayload(qr({ host: "rotasaude.example", token: TOKEN }), [".rotasaude.example"])).toEqual({ ok: false, reason: "host_not_allowed" });
});

test("a refusal never carries the token or the host", () => {
  const refused = parseQrPayload(qr({ host: "curitiba.evil.test", token: TOKEN }), SUFFIXES);
  expect(JSON.stringify(refused)).not.toMatch(/rsf_|evil/);
});
