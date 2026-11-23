import { collectionProblems, installProblems, numberTaken, paddleWindowText } from "./ovitrap";
import { VECTOR_ERRORS } from "./vectorErrors";

const P = { ovitrap_collection_days_min: 3, ovitrap_collection_days_max: 10 };
const TODAY = "2026-11-14";
const install = (o: Partial<Parameters<typeof installProblems>[0]> = {}) =>
  installProblems({ number: "OV-12", consent: true, installedOn: TODAY, householdHasBlock: true, ...o }, TODAY);

test.each([["2026-11-02", "2026-11-04", true], ["2026-11-02", "2026-11-05", false], ["2026-11-02", "2026-11-12", false], ["2026-11-02", "2026-11-13", true]])(
  "collection installed %s, collected %s → out of range = %s (2 and 11 days)", (installedOn, collectedOn, out) => {
    const found = collectionProblems({ installedOn, collectedOn, condition: "ok" }, P, collectedOn);
    expect(found).toEqual(out ? [{ code: "collection_out_of_range", path: "collected_on", text: VECTOR_ERRORS.collection_out_of_range }] : []);
  });

test("collection: a future date and a missing condition are refused before the window", () => {
  expect(collectionProblems({ installedOn: "2026-11-02", collectedOn: "2026-11-15", condition: null }, P, TODAY).map((p) => [p.code, p.path]))
    .toEqual([[null, "collected_on"], [null, "condition"]]);
  expect(collectionProblems({ installedOn: "2026-11-02", collectedOn: "2026-02-30", condition: "dry" }, P, TODAY).map((p) => p.path)).toEqual(["collected_on"]);
});

test("number OV-12 ok; 'OV 12' and 13 characters refused (Q7(6))", () => {
  expect(install()).toEqual([]);
  expect(install({ number: "123456789012" })).toEqual([]);
  for (const number of ["OV 12", "1234567890123", "", "OV_12"]) {
    expect([number, install({ number }).map((p) => [p.code, p.path])]).toEqual([number, [[null, "number"]]]);
  }
});

test("installation in the api's order: number, date, block, consent", () => {
  const found = install({ number: "OV 1", installedOn: "2026-11-15", householdHasBlock: false, consent: false });
  expect(found.map((p) => [p.code, p.path])).toEqual([[null, "number"], [null, "installed_on"], ["household_without_block", "household_id"], ["consent_required", "consent"]]);
  expect(found[2].text).toBe(VECTOR_ERRORS.household_without_block);
  expect(found[3].text).toBe(VECTOR_ERRORS.consent_required);
  // The profile not read yet is not checked.
  expect(install({ householdHasBlock: null })).toEqual([]);
});

test("number taken by an active ovitrap or a queued installation, case-insensitive → ovitrap_number_taken", () => {
  expect(numberTaken("ovt-014", ["OVT-014", "OV-2"])).toBe(true);
  expect(numberTaken("OV-2", ["OVT-014", "ov-2"])).toBe(true);
  expect(numberTaken("OV-3", ["OVT-014", "OV-2"])).toBe(false);
  expect(numberTaken("OV-3", [])).toBe(false);
});

test("the paddle's window: since, min, max and the 5-day target (the dashboard's text)", () => {
  expect(paddleWindowText("2026-11-10", P)).toBe("palheta desde 10/11/2026 — colete entre 13/11 e 20/11 (ideal 15/11)");
  expect(paddleWindowText("2026-11-10", { ovitrap_collection_days_min: 6, ovitrap_collection_days_max: 8 })).toBe("palheta desde 10/11/2026 — colete entre 16/11 e 18/11 (ideal 16/11)");
  expect(paddleWindowText("2026-11-10", null)).toBe("palheta desde 10/11/2026");
});
