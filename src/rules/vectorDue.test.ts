import { cadenceDays, dueList, startFor, type DueInput, type DueItem } from "./vectorDue";
import type { Cadence, VectorSituation } from "./vectorDomains";

// The cases of apps/api spec/services/vector_control/{cadence,due}_spec.rb (Q11), with the (city, any) step of Q10.
const NB = "nb-1";
const P = { default_days: 60, strategic_point_days: 15 };
const TABLE: Cadence[] = [
  { neighborhood_id: NB, risk_class: null, strategic_point: true, days: 10 },
  { neighborhood_id: null, risk_class: null, strategic_point: true, days: 12 },
  { neighborhood_id: NB, risk_class: "red", strategic_point: false, days: 30 },
  { neighborhood_id: NB, risk_class: null, strategic_point: false, days: 45 },
  { neighborhood_id: null, risk_class: "red", strategic_point: false, days: 50 },
  { neighborhood_id: null, risk_class: null, strategic_point: false, days: 55 },
];

// Each case drops the steps more specific than the one it expects (they are the rows with fewer days).
test.each([
  ["PE with (neighbourhood, PE) 10", "4", 10], ["PE falls back to (city, PE) 12", "4", 12], ["PE falls back to strategic_point_days 15", "4", 15],
  ["(neighbourhood, red) 30", "1", 30], ["(neighbourhood, any) 45", "1", 45], ["(city, red) 50", "1", 50], ["(city, any) 55 (Q10)", "1", 55], ["default_days 60", "1", 60],
] as const)("cadenceDays: %s", (_name, propertyType, expected) => {
  const cadences = TABLE.filter((c) => c.days >= expected);
  expect(cadenceDays({ propertyType, neighborhoodId: NB, riskClass: "red" }, cadences, P)).toBe(expected);
});

test("cadenceDays: a PE ignores the risk; without risk or neighbourhood only the any-risk and city steps count", () => {
  expect(cadenceDays({ propertyType: "4", neighborhoodId: NB, riskClass: "red" }, [], P)).toBe(15);
  const noPe = TABLE.filter((c) => !c.strategic_point);
  expect(cadenceDays({ propertyType: "1", neighborhoodId: NB, riskClass: null }, noPe, P)).toBe(45);
  expect(cadenceDays({ propertyType: "1", neighborhoodId: null, riskClass: "red" }, noPe, P)).toBe(50);
  expect(cadenceDays({ propertyType: "1", neighborhoodId: null, riskClass: null }, noPe, P)).toBe(55);
  // The parameters are read, never fixed.
  expect(cadenceDays({ propertyType: "1", neighborhoodId: NB, riskClass: null }, [], { default_days: 90, strategic_point_days: 20 })).toBe(90);
  expect(cadenceDays({ propertyType: "4", neighborhoodId: NB, riskClass: null }, [], { default_days: 90, strategic_point_days: 20 })).toBe(20);
});

const row = (key: string, o: Partial<DueInput> & { worked?: string | null; situation?: VectorSituation } = {}): DueInput => {
  const { worked, situation, ...rest } = o;
  return {
    householdKey: key, householdId: key, status: "active", propertyType: "1", neighborhoodId: NB,
    profile: worked === undefined && situation === undefined ? null
      : { city_block_id: null, risk_class: null, last_worked_on: worked ?? null, last_situation: situation ?? (worked ? "worked" : null) },
    liraaItemId: null, transmissionBlockId: null, ...rest,
  };
};

test("worked on 2026-09-17 with 60 days is due on 2026-11-16; on 2026-09-18 it is not", () => {
  const items = dueList([row("a", { worked: "2026-09-17" }), row("b", { worked: "2026-09-18" })], "2026-11-16", [], P);
  expect(items).toEqual<DueItem[]>([{
    householdKey: "a", reason: "due", dueSince: "2026-11-16", lastWorkedOn: "2026-09-17", riskClass: null, liraaDrawItemId: null, transmissionBlockId: null,
  }]);
});

test("never worked is due with dueSince null and comes first", () => {
  const items = dueList([row("a", { worked: "2026-01-01" }), row("z"), row("m", { situation: "vacant" })], "2026-11-16", [], P);
  expect(items.map((i) => [i.householdKey, i.reason, i.dueSince])).toEqual([["m", "due", null], ["z", "due", null], ["a", "due", "2026-03-02"]]);
});

test("one reason per household: block wins over LIRAa, LIRAa over pending, pending over due", () => {
  const items = dueList([
    row("due", { worked: "2026-01-01" }),
    row("pending", { worked: "2026-11-10", situation: "closed" }),
    row("refused", { situation: "refused" }),
    row("liraa", { worked: "2026-11-10", situation: "closed", liraaItemId: "item-1" }),
    row("block", { worked: "2026-11-15", liraaItemId: "item-2", transmissionBlockId: "tb-1" }),
    row("fresh", { worked: "2026-11-15" }),
  ], "2026-11-16", [], P);
  expect(items.map((i) => [i.householdKey, i.reason, i.dueSince])).toEqual([
    ["block", "transmission_block", "2027-01-14"], ["liraa", "liraa", "2027-01-09"],
    ["refused", "pending", null], ["pending", "pending", "2027-01-09"], ["due", "due", "2026-03-02"],
  ]);
  // One link per item: the reason's, the other null.
  expect(items[0]).toMatchObject({ transmissionBlockId: "tb-1", liraaDrawItemId: null });
  expect(items[1]).toMatchObject({ transmissionBlockId: null, liraaDrawItemId: "item-1" });
});

test("within a reason: dueSince ascending, then the key", () => {
  const items = dueList([row("b", { worked: "2026-01-01" }), row("a", { worked: "2026-01-01" }), row("c", { worked: "2025-12-01" })], "2026-11-16", [], P);
  expect(items.map((i) => i.householdKey)).toEqual(["c", "a", "b"]);
});

test("startFor: block, LIRAa, pending and PE", () => {
  const item = (o: Partial<DueItem>): DueItem => ({
    householdKey: "a", reason: "due", dueSince: null, lastWorkedOn: null, riskClass: null, liraaDrawItemId: null, transmissionBlockId: null, ...o,
  });
  expect(startFor(item({ reason: "transmission_block", transmissionBlockId: "tb-1" }), "4")).toEqual({ activity: "transmission_block", transmissionBlockId: "tb-1" });
  expect(startFor(item({ reason: "liraa", liraaDrawItemId: "item-1" }), "1")).toEqual({ activity: "liraa", liraaDrawItemId: "item-1" });
  expect(startFor(item({ reason: "pending" }), "1")).toEqual({ workType: "pending" });
  // The dashboard's startFor: a pending strategic point is a PE of recovery.
  expect(startFor(item({ reason: "pending" }), "4")).toEqual({ activity: "pe", workType: "pending" });
  expect(startFor(item({ reason: "due" }), "4")).toEqual({ activity: "pe" });
  expect(startFor(item({ reason: "due" }), "1")).toEqual({});
});

test("inactive households never appear", () => {
  const items = dueList([row("gone", { status: "inactive", transmissionBlockId: "tb-1" }), row("kept")], "2026-11-16", [], P);
  expect(items.map((i) => i.householdKey)).toEqual(["kept"]);
});

test("the cadence of each household is its own (PE, neighbourhood, risk)", () => {
  const items = dueList([
    row("pe", { propertyType: "4", worked: "2026-11-01" }),
    { ...row("red", { worked: "2026-10-17" }), profile: { city_block_id: null, risk_class: "red", last_worked_on: "2026-10-17", last_situation: "worked" } },
    row("plain", { worked: "2026-10-17" }),
  ], "2026-11-16", TABLE.filter((c) => c.days !== 10 && c.days !== 12), P);
  expect(items.map((i) => [i.householdKey, i.dueSince])).toEqual([["pe", "2026-11-16"], ["red", "2026-11-16"]]);
});
