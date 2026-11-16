// The only place that talks to the api (/field/v1). The city is the host of
// the QR; the token goes in the Authorization header and nowhere else — never
// in a URL, a log or a screen. Failures come back as a small closed set, so
// the round (Task 13) decides by kind, not by status code.
import type { ChangesResponse, ReferenceResponse, SessionResponse, UploadItem, UploadResponse } from "../contract";

// The contract this version of the app speaks. The session says which one the server speaks: with another one the
// app neither pairs nor syncs until it is updated (Q82, Q83).
export const FIELD_CONTRACT = "field-sync-v1";
export const speaksOurContract = (session: { contract: string }): boolean => session.contract === FIELD_CONTRACT;

export type HttpFailure =
  | { kind: "revoked" } // 401 device_revoked: manual revocation, the tablet is wiped
  | { kind: "suspended" } // 401 device_suspended or invalid_token: access suspended, the queue is kept
  | { kind: "feature_disabled" } // 403 feature_disabled
  | { kind: "rate_limited" } // 429
  | { kind: "not_found"; code: string } // 404 (map_not_found, unknown_city)
  | { kind: "range" } // 416 range_not_satisfiable: the map download starts over (Q34)
  | { kind: "server"; status: number; code: string | null } // 5xx, the city edge's 403/503, unreadable answers
  | { kind: "network" } // no answer, or the 20 s timeout
  | { kind: "invalid"; status: number; code: string | null }; // the remaining 4xx (422 invalid_request …)

export class FieldHttpError extends Error {
  constructor(public failure: HttpFailure) {
    // Kind and code only: never the body, the URL or a header.
    super(`field http ${failure.kind}${"code" in failure && failure.code ? ` ${failure.code}` : ""}`);
  }
}

export interface FieldClient {
  session(): Promise<SessionResponse>;
  uploads(items: UploadItem[]): Promise<UploadResponse>;
  changes(cursor: string | null, limit?: number): Promise<ChangesResponse>;
  reference(): Promise<ReferenceResponse>;
  // The map is downloaded by the file system module, not by fetch: this only says where and with which headers.
  // With `resume`: If-Range carries the SHA-256 of the session's map (Q34).
  mapRequest(resume?: { ifRange: string }): Promise<{ url: string; headers: Record<string, string> }>;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_CHANGES_LIMIT = 200;

const NOT_FOUND_CODES = new Set(["map_not_found", "unknown_city"]);

export function failureFor(status: number, code: string | null): HttpFailure {
  if (status === 401) return code === "device_revoked" ? { kind: "revoked" } : { kind: "suspended" };
  if (status === 403 && code === "feature_disabled") return { kind: "feature_disabled" };
  if (status === 429) return { kind: "rate_limited" };
  if (status === 404 && code !== null && NOT_FOUND_CODES.has(code)) return { kind: "not_found", code };
  if (status === 416) return { kind: "range" };
  if (status >= 500 || status === 403 || status === 404) return { kind: "server", status, code };
  return { kind: "invalid", status, code };
}

export function createFieldClient(o: {
  host: string;
  getToken: () => Promise<string | null>;
  // Tests inject one; the app uses the platform's. This file and src/map/download.ts are the only places allowed to reach the network (lint).
  fetch?: typeof fetch;
  // Dev and e2e builds only: the request goes to this origin with the QR's host in the Host header (the api resolves the city by host).
  devOrigin?: string;
  timeoutMs?: number;
}): FieldClient {
  const origin = o.devOrigin ?? `https://${o.host}`;
  const send = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function headers(write: boolean): Promise<Record<string, string>> {
    const token = await o.getToken();
    // Without a token there is nothing to send: the same as an answer saying the access is suspended.
    if (!token) throw new FieldHttpError({ kind: "suspended" });
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(write ? { "Content-Type": "application/json" } : {}),
      ...(o.devOrigin ? { Host: o.host } : {}),
    };
  }

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers: await headers(body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response: Response;
    try {
      response = await send(`${origin}${path}`, { ...init, signal: abort.signal });
    } catch {
      throw new FieldHttpError({ kind: "network" });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new FieldHttpError(failureFor(response.status, typeof payload?.error === "string" ? payload.error : null));
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new FieldHttpError({ kind: "server", status: response.status, code: null });
    }
  }

  return {
    session: () => request<SessionResponse>("/field/v1/session"),
    uploads: (items) => request<UploadResponse>("/field/v1/uploads", { items }),
    changes: (cursor, limit = DEFAULT_CHANGES_LIMIT) => {
      // The cursor is opaque and carries no personal data; nothing else ever goes in a query string.
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== null) query.set("cursor", cursor);
      return request<ChangesResponse>(`/field/v1/changes?${query.toString()}`);
    },
    reference: () => request<ReferenceResponse>("/field/v1/reference"),
    mapRequest: async (resume) => {
      const { Accept: _accept, ...auth } = await headers(false);
      return { url: `${origin}/field/v1/map`, headers: { ...auth, ...(resume ? { "If-Range": `"${resume.ifRange}"` } : {}) } };
    },
  };
}
