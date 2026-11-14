import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { HouseholdBody, ItemType, Location, RegistrationBody, UploadItem, UploadResult, WhoItem } from "./index";

const root = join(__dirname, "../..");

// The generator is the judge: it recompiles every schema in memory and compares with what is committed.
test("src/contract/generated is what scripts/contract-types.mjs produces", () => {
  const out = execFileSync("node", ["scripts/contract-types.mjs", "--check"], { cwd: root, encoding: "utf8" });
  expect(out).toMatch(/6 files up to date/);
});

// Compile-time checks: these only need to typecheck (tsc runs in CI and at the end of every task).
test("the aliases the app uses exist with the contract's shapes", () => {
  const type: ItemType = "family";
  const location: Location = { latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" };
  const item: Pick<UploadItem, "client_uuid" | "type"> = { client_uuid: "0b9f6c1e-5d1a-4c1e-9a54-3f3f8f0f6a11", type };
  const result: Pick<UploadResult, "client_uuid" | "status"> = { client_uuid: item.client_uuid, status: "accepted" };
  const household: Pick<HouseholdBody, "id" | "version"> | null = null;
  const registration: Pick<RegistrationBody, "id" | "version"> | null = null;
  const who: Pick<WhoItem, "patient_id"> | null = null;
  expect([location.source, result.status, household, registration, who]).toEqual(["gps", "accepted", null, null, null]);
});
