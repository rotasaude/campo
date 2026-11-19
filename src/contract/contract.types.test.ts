import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type {
  ChangeType, CityBlockBody, HouseholdBody, HouseholdVector, ItemType, LiraaItemBody, Location, OvitrapBody,
  OvitrapCollectionItemBody, OvitrapInstallationItemBody, RegistrationBody, TransmissionBlockBody, UploadItem,
  UploadResult, VectorControlDomainsRaw, VectorInspectionBody, WhoItem,
} from "./index";

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

// field-sync-v1.3.0 (35a): the names Tasks 3+ use.
test("the 35a aliases exist with the contract's shapes", () => {
  const types: ItemType[] = ["ovitrap_installation", "ovitrap_collection"];
  const changes: ChangeType[] = ["city_block", "ovitrap", "liraa_item", "transmission_block"];
  const inspection: Pick<VectorInspectionBody, "activity" | "situation"> | null = null;
  const installation: Pick<OvitrapInstallationItemBody, "number"> | null = null;
  const collection: Pick<OvitrapCollectionItemBody, "condition"> | null = null;
  const block: Pick<CityBlockBody, "id" | "number"> | null = null;
  const ovitrap: Pick<OvitrapBody, "id" | "number"> | null = null;
  const liraa: Pick<LiraaItemBody, "id"> | null = null;
  const transmission: Pick<TransmissionBlockBody, "id" | "status"> | null = null;
  const vector: HouseholdVector = null;
  const domains: Pick<VectorControlDomainsRaw, "limits"> | null = null;
  expect([types.length, changes.length, inspection, installation, collection, block, ovitrap, liraa, transmission, vector, domains])
    .toEqual([2, 4, null, null, null, null, null, null, null, null, null]);
});
