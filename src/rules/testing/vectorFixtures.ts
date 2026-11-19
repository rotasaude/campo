// Test support: the data of the dashboard's vector rule tests (apps/dashboard/src/test/vectorControlFixtures.ts,
// dashboard commit dc6c0e0), copied so the ported cases run with the same values. The domains are not typed in:
// they come from the v1.3.0 reference example (contracts/field-sync/examples/reference-vector-control.json)
// through parseVectorDomains, as the app reads them. Its focal larvicide and its perifocal adulticide play the
// dashboard's pr1 and pr2; the inactive product (pr3 there) is the larvicide under another id, marked inactive.
import type { ReferenceResponse, VectorDeposit } from "../../contract";
import { example } from "../../contract/fixtures";
import { parseVectorDomains, type VectorControlDomains, type VectorProduct } from "../vectorDomains";
import type { VectorInspectionInput } from "../vectorInspection";

export const NOW35 = new Date("2026-11-16T10:00:00-03:00");
export const TODAY35 = "2026-11-16";

export const VC_DOMAINS: VectorControlDomains = parseVectorDomains(example<ReferenceResponse>("reference-vector-control.json").vector_control_domains)!;
// The reference's focal larvicide (the dashboard's pr1) and its perifocal adulticide (pr2).
export const LARVICIDE: VectorProduct = VC_DOMAINS.products.find((p) => p.uses.includes("focal"))!;
export const ADULTICIDE: VectorProduct = VC_DOMAINS.products.find((p) => p.uses.includes("perifocal"))!;
// An inactive product (the dashboard's pr3): the reference sends only the active ones, so it is synthesized.
export const INACTIVE_PRODUCT: VectorProduct = { ...LARVICIDE, id: "c0ffee35-0000-4000-8000-000000000035", code: "TEM", name: "Temefós 1% G" };

// ── Boletim (§3) ──
const A2 = (o: Partial<Record<"existing" | "with_water" | "with_larvae" | "eliminated" | "treated", number>> = {}): VectorDeposit =>
  ({ group: "A2", existing: 3, with_water: 2, with_larvae: 1, eliminated: 1, treated: 1, ...o });
// O boletim completo: LI+T de rotina, trabalhado, A2 com foco tratado, focal com 2 cargas do larvicida, uma amostra, ação educativa.
export const inspectionInput = (o: Partial<VectorInspectionInput> = {}): VectorInspectionInput => ({
  activity: "li_t", work_type: "routine", situation: "worked", educational_action: true,
  entered_at: "2026-11-16T09:40:00-03:00", left_at: "2026-11-16T10:20:00-03:00",
  deposits: [ A2() ], measures: [ { method: "focal", vector_product_id: LARVICIDE.id, charges: 2 } ],
  samples: [ { number: 1, deposit_group: "A2", larvae_collected: 8 } ], ...o
});
