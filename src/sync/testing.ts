// Test support for the sync modules: contract examples as queue items, a fake client and row helpers.
import { domains, type ItemType, type ReferenceResponse, type UploadItem, type UploadRequest, type UploadResponse, type UploadResult } from "../contract";
import { example } from "../contract/fixtures";
import { expectValid } from "../contract/validate";
import type { Db } from "../db/types";
import type { OutboxItem } from "./outbox";

let counter = 0;
// Valid lowercase UUIDs, different on every call.
export const newUuid = (): string => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

// The items of a contract example. The stored body never carries `version`: it is filled at send time.
export function exampleItems(file: string): { client_uuid: string; type: ItemType; body: Record<string, unknown> }[] {
  return example<UploadRequest>(file).items.map((item) => {
    const { version: _version, ...body } = item.body as Record<string, unknown>;
    return { client_uuid: item.client_uuid, type: item.type, body };
  });
}

export const SERVER_ID = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";

export const accepted = (item: Pick<OutboxItem, "client_uuid" | "type">, extra: Partial<UploadResult> = {}): UploadResult =>
  ({ client_uuid: item.client_uuid, status: "accepted", type: item.type, id: SERVER_ID, ...extra });
export const rejected = (item: Pick<OutboxItem, "client_uuid" | "type">, error: string, extra: Partial<UploadResult> = {}): UploadResult =>
  ({ client_uuid: item.client_uuid, status: "rejected", type: item.type, error, ...extra });

// A client whose answers come from `answer`; every request and every answer is checked against the contract.
export function fakeClient(answer: (items: UploadItem[], call: number) => UploadResult[]) {
  const batches: UploadItem[][] = [];
  const uploads = jest.fn(async (items: UploadItem[]): Promise<UploadResponse> => {
    expectValid("upload-request", { items });
    batches.push(items);
    const response = { results: answer(items, batches.length) } as UploadResponse;
    expectValid("upload-response", response);
    return response;
  });
  return { client: { uploads }, batches, uploads };
}

export async function insertHousehold(db: Db, key: string, o: { id?: string | null; baseVersion?: number | null } = {}): Promise<void> {
  await db.run(
    "INSERT INTO households (key, id, micro_area_id, version, body, base_version, street_norm, number) VALUES (?, ?, 'ma1', ?, '{}', ?, 'flores', '120')",
    [key, o.id === undefined ? key : o.id, o.baseVersion ?? null, o.baseVersion ?? null]);
}
export async function insertRegistration(db: Db, key: string, o: { id?: string | null; baseVersion?: number | null } = {}): Promise<void> {
  await db.run("INSERT INTO registrations (key, id, version, body, base_version, name_norm) VALUES (?, ?, ?, '{}', ?, 'maria')",
    [key, o.id === undefined ? key : o.id, o.baseVersion ?? null, o.baseVersion ?? null]);
}

// A reference with real content: the contract's example (dictionaries, neighbourhood, units) plus the visit and
// activity domains written from domains-v1.json the way the api builds them (HomeVisits::Json.domains).
export function referenceFixture(): ReferenceResponse {
  const base = example<ReferenceResponse>("reference.json");
  const hv = domains.home_visit;
  const ca = domains.collective_activity;
  const ranges = Object.fromEntries(Object.entries(hv.rules.measurements)
    .filter(([, row]) => "min" in row)
    .map(([key, row]) => [key, { min: (row as { min: number }).min, max: (row as { max: number }).max, decimals: (row as { decimals: number }).decimals }]));
  const [professional] = base.team_professionals;
  return {
    ...base,
    team_professionals: [
      professional,
      { ...professional, professional_id: "c0ffee50-0000-4000-8000-000000000050", name: "Bruno Lima", cbo: "223505" },
      { ...professional, team_id: "c0ffee51-0000-4000-8000-000000000051", professional_id: "c0ffee52-0000-4000-8000-000000000052", name: "Dalva Reis", has_cns: false },
    ],
    home_visit_domains: {
      motivo_visita: hv.motivo_visita.flatMap((group) => group.items.map((item) => ({ ...item, group: group.group, group_label: group.label }))),
      desfecho: hv.desfecho, turno: hv.turno, tipo_glicemia: hv.tipo_glicemia, tipo_de_imovel: hv.tipo_de_imovel,
      non_residential_property_types: hv.rules.non_residential_property_types, non_residential_reasons: hv.rules.non_residential_reasons,
      male_forbidden_reasons: hv.rules.male_forbidden_reasons, without_person_allowed_reasons: hv.rules.without_person_allowed_reasons,
      responsible_document_reasons: hv.rules.responsible_document_reasons, reasons_max: hv.rules.reasons_max, measurement_ranges: ranges,
    },
    collective_activity_domains: {
      activity_types: ca.tipo_atividade_coletiva, meeting_topics: ca.temas_para_reuniao, target_audience: ca.publico_alvo,
      health_topics: ca.temas_para_saude, health_practices: ca.praticas_em_saude, procedures: ca.outro_procedimento_coletivo, rules: {},
    },
  } as unknown as ReferenceResponse;
}
