import { outboxRepo } from "../db/repos/outboxRepo";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { enqueue } from "./outbox";
import { TERRITORY_MAX_DAYS, TERRITORY_WARN_DAY, enforceTerritoryAge, purgeAccepted, territoryAge, validityBand } from "./retention";
import { newUuid } from "./testing";

const DAY = 86_400_000;
const LAST = "2026-10-01T12:00:00.000Z";
const at = (days: number) => Date.parse(LAST) + days * DAY;
const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

test("day 24 no warn, day 25 warn, day 30 wipes territory but not the outbox", async () => {
  expect([TERRITORY_WARN_DAY, TERRITORY_MAX_DAYS]).toEqual([25, 30]);
  expect(territoryAge(LAST, at(24))).toEqual({ days: 24, warn: false, expired: false });
  expect(territoryAge(LAST, at(25))).toEqual({ days: 25, warn: true, expired: false });
  expect(territoryAge(LAST, at(29) + DAY - 1)).toEqual({ days: 29, warn: true, expired: false });
  expect(territoryAge(LAST, at(30))).toEqual({ days: 30, warn: true, expired: true });
  expect(territoryAge(null, at(99))).toEqual({ days: null, warn: false, expired: false });

  const db = await createTestDb();
  await db.run("INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('h', 'm', '{}', 'x', '1')");
  await db.run("INSERT INTO meta (key, value) VALUES ('last_download_ok_at', ?), ('cursor', 'c')", [LAST]);
  const pending = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  expect(await enforceTerritoryAge(db, at(29))).toBe(false);
  expect(await count(db, "households")).toBe(1);
  expect(await enforceTerritoryAge(db, at(30))).toBe(true);
  expect(await count(db, "households")).toBe(0);
  expect((await outboxRepo.all(db)).map((i) => i.client_uuid)).toEqual([pending.client_uuid]);
  // Wiped once: without a full download there is nothing left to expire.
  expect(await enforceTerritoryAge(db, at(31))).toBe(false);
});

test("a tablet that never completed a download has nothing to expire", async () => {
  const db = await createTestDb();
  await db.run("INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('h', 'm', '{}', 'x', '1')");
  expect(await enforceTerritoryAge(db, at(400))).toBe(false);
  expect(await count(db, "households")).toBe(1);
});

test("validityBand: 2024-02-29 + 24 months = 2026-02-28", () => {
  const leap = "2024-02-29T10:00:00-03:00";
  expect(validityBand(leap, "2026-02-27")).toBe("due_soon");
  expect(validityBand(leap, "2026-02-28")).toBe("expired"); // the due day itself is already expired
  expect(validityBand(leap, "2026-03-01")).toBe("expired");
});

test("validityBand: valid until 61 days before the due day, due soon from 60, by the day written in registered_at", () => {
  const registered = "2024-11-14T23:30:00-03:00"; // due 2026-11-14, whatever the hour or the device's zone
  expect(validityBand(registered, "2026-09-14")).toBe("valid"); // 61 days before
  expect(validityBand(registered, "2026-09-15")).toBe("due_soon"); // 60 days before
  expect(validityBand(registered, "2026-11-13")).toBe("due_soon");
  expect(validityBand(registered, "2026-11-14")).toBe("expired");
  expect(validityBand("2026-11-14T08:00:00-03:00", "2026-11-14")).toBe("valid");
});

test("accepted visits from yesterday are purged, today's stay", async () => {
  const db = await createTestDb();
  const visit = (uuid: string, day: string, state: string) =>
    db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, ?, 't', '{}', ?)", [uuid, day, state]);
  await visit("y-accepted", "2026-11-13", "accepted");
  await visit("y-pending", "2026-11-13", "pending"); // not sent yet: it is the only record the person has of it
  await visit("y-withdrawn", "2026-11-13", "withdrawn");
  await visit("t-accepted", "2026-11-14", "accepted");
  const activity = (uuid: string, day: string, state: string) =>
    db.run("INSERT INTO local_activities (client_uuid, held_on, summary, state) VALUES (?, ?, '{}', ?)", [uuid, day, state]);
  await activity("a-old", "2026-11-10", "accepted");
  await activity("a-today", "2026-11-14", "accepted");
  await activity("a-old-pending", "2026-11-10", "pending");

  await purgeAccepted(db, "2026-11-14");
  expect((await db.all<{ client_uuid: string }>("SELECT client_uuid FROM local_visits ORDER BY client_uuid")).map((r) => r.client_uuid))
    .toEqual(["t-accepted", "y-pending"]);
  expect((await db.all<{ client_uuid: string }>("SELECT client_uuid FROM local_activities ORDER BY client_uuid")).map((r) => r.client_uuid))
    .toEqual(["a-old-pending", "a-today"]);
});
