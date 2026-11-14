// The dashboard's QR: "rotasaude-field:v1:" + base64url(JSON { host, token }).
// It carries the city (the host) and the device token. A production build only
// accepts hosts that end in one of the suffixes fixed at build time (Q44): a
// forged QR never makes the app talk to someone else's server.
export const QR_PREFIX = "rotasaude-field:v1:";

export type QrPayload =
  | { ok: true; host: string; token: string }
  | { ok: false; reason: "not_rotasaude" | "malformed" | "host_not_allowed" };

const TOKEN = /^rsf_[A-Za-z0-9_-]{43}$/;
// Lowercase labels separated by dots: no scheme, no port, no path, no user info.
const HOST = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Decodes to text only when every byte is printable ASCII (the payload is a host and a token); otherwise null.
function decodeBase64Url(text: string): string | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (buffer >> bits) & 0xff;
      if (byte < 0x20 || byte > 0x7e) return null;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

function allowed(host: string, suffixes: string[]): boolean {
  return suffixes.some((raw) => {
    const suffix = raw.trim().toLowerCase();
    if (suffix === "" || suffix === ".") return false;
    // A suffix always ends at a label boundary: ".rotasaude.app" never matches "evilrotasaude.app".
    return suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix || host.endsWith(`.${suffix}`);
  });
}

// Never throws and never echoes the text: the caller only gets the reason.
export function parseQrPayload(text: string, allowedHostSuffixes: string[]): QrPayload {
  if (typeof text !== "string" || !text.startsWith(QR_PREFIX)) return { ok: false, reason: "not_rotasaude" };
  const json = decodeBase64Url(text.slice(QR_PREFIX.length));
  if (json === null) return { ok: false, reason: "malformed" };
  let data: unknown;
  try { data = JSON.parse(json); } catch { return { ok: false, reason: "malformed" }; }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "malformed" };
  const { host, token } = data as { host?: unknown; token?: unknown };
  if (typeof host !== "string" || typeof token !== "string" || !TOKEN.test(token) || !HOST.test(host)) return { ok: false, reason: "malformed" };
  if (!allowed(host, allowedHostSuffixes)) return { ok: false, reason: "host_not_allowed" };
  return { ok: true, host, token };
}
