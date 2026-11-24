import type { ChangesResponse, ReferenceResponse, SessionResponse, UploadItem, UploadResult } from "../contract";
import { example } from "../contract/fixtures";
import { createTestDb } from "../db/testing/sqljsDb";
import { FieldHttpError, type FieldClient } from "../sync/http";
import { enqueue } from "../sync/outbox";
import { runRound, type RoundDeps } from "../sync/round";
import { accepted, exampleItems, newUuid, rejected } from "../sync/testing";

// What must never reach a log line: the token, a CPF, a CNS, a coordinate, a name, or the keys that carry them.
const LEAK = /rsf_|\b\d{11}\b|\b\d{15}\b|-25\.\d{3,}|-49\.\d{3,}|Rosângela|Joana|Maria|full_name|latitude|longitude/;

const SESSION = example<SessionResponse>("session-acs.json");
const NOW = Date.parse("2026-11-12T12:00:00Z");

async function roundWith(o: { results?: (items: UploadItem[]) => UploadResult[]; failAt?: "session" | "changes"; files?: string[] } = {}) {
  const db = await createTestDb();
  // A person with CPF and name, a household with its point, a visit with the GPS reading.
  for (const item of (o.files ?? ["upload-registration-same-batch.json", "upload-home-visit-location.json", "upload-household-location.json"]).flatMap(exampleItems)) {
    await enqueue(db, { type: item.type, body: item.body }, newUuid);
  }
  const pages = [example<ChangesResponse>("changes-first-page.json"), example<ChangesResponse>("changes-last-page.json")];
  const client: FieldClient = {
    session: async () => { if (o.failAt === "session") throw new FieldHttpError({ kind: "server", status: 503, code: "city_schema_behind" }); return SESSION; },
    uploads: async (items) => ({ results: (o.results ?? ((list) => list.map((i) => accepted(i))))(items) }) as never,
    changes: async () => { if (o.failAt === "changes") throw new FieldHttpError({ kind: "network" }); return pages.shift()!; },
    reference: async () => example<ReferenceResponse>("reference.json"),
    mapRequest: async () => ({ url: "https://curitiba.rotasaude.example/field/v1/map", headers: { Authorization: "Bearer rsf_" + "A".repeat(43) } }),
  };
  const deps: RoundDeps = {
    db, client, now: () => NOW, wipeAll: async () => undefined, isLocked: () => false,
    net: { isOnline: async () => true, isWifi: async () => true },
    syncMap: async () => { throw new Error("ENOSPC at -25.42847123, -49.27325411"); },
  };
  return runRound(deps, "button");
}

let captured: string[] = [];
beforeEach(() => {
  captured = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); });
  }
});
afterEach(() => jest.restoreAllMocks());

test("no log line contains names, CPF, CNS, coordinates or the token", async () => {
  expect(await roundWith()).toEqual({ kind: "ok", downloaded: true });
  // Refusals carry a path and, for a suspected duplicate, candidates with names: none of it is logged.
  await roundWith({
    results: (items) => items.map((i) => (i.type === "patient"
      ? rejected(i, "duplicate_suspected", { path: "new_patient.full_name", confirmable: true, candidates: [] })
      : i.type === "household" ? rejected(i, "invalid_location", { path: "location.latitude" }) : accepted(i))),
  });
  await roundWith({ failAt: "session" });
  await roundWith({ failAt: "changes" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // the map sync fails behind the round

  expect(captured.length).toBeGreaterThan(0);
  for (const line of captured) expect(line).not.toMatch(LEAK);
});

// 35b (§16): the number of the microchip goes in the animal's creation and nowhere else — not when it is accepted, not
// when the api refuses it as taken (the path names the field, never the value).
test("a round with an animal carrying a microchip logs no 15-digit number", async () => {
  const files = ["upload-animal-new.json", "upload-zoonoses-same-batch.json"];
  const chip = (exampleItems("upload-animal-new.json")[0].body as { microchip: string }).microchip;
  expect(chip).toMatch(/^\d{15}$/);
  expect(await roundWith({ files })).toEqual({ kind: "ok", downloaded: true });
  await roundWith({ files, results: (items) => items.map((i) => (i.type === "animal" ? rejected(i, "microchip_taken", { path: "microchip" }) : accepted(i))) });
  expect(captured.length).toBeGreaterThan(0);
  for (const line of captured) {
    expect(line).not.toMatch(LEAK);
    expect(line).not.toContain(chip);
  }
});

test("what is logged is enough to follow a round: its start, each item's verdict and how it ended", async () => {
  await roundWith({ results: (items) => items.map((i) => (i.type === "patient" ? rejected(i, "invalid_cpf", { path: "new_patient.cpf" }) : accepted(i))) });
  const lines = captured.map((line) => JSON.parse(line) as { event: string; code?: string; type?: string; client_uuid?: string });
  expect(lines[0]).toEqual({ event: "sync.round.start", code: "button" });
  expect(lines[lines.length - 1]).toEqual({ event: "sync.round.end", code: "ok" });
  const verdicts = lines.filter((l) => l.event === "sync.item.result");
  expect(verdicts.find((l) => l.type === "patient")).toMatchObject({ code: "invalid_cpf" });
  expect(verdicts.some((l) => l.code === "accepted" && /^[0-9a-f-]{36}$/.test(l.client_uuid ?? ""))).toBe(true);
  // Only the allowed fields exist on a line.
  for (const line of lines) expect(Object.keys(line).filter((k) => !["event", "client_uuid", "type", "code", "seq", "status"].includes(k))).toEqual([]);
});
