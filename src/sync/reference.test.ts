import { domains, type ReferenceResponse } from "../contract";
import { example } from "../contract/fixtures";
import { expectValid } from "../contract/validate";
import { createTestDb } from "../db/testing/sqljsDb";
import { FieldHttpError } from "./http";
import { healthUnitOptions, loadReference, parseReference, professionalOptions, refreshReference } from "./reference";
import { referenceFixture } from "./testing";

const EXAMPLE = example<ReferenceResponse>("reference.json");
const clientOf = (body: unknown) => ({ reference: jest.fn(async () => body as ReferenceResponse) });

test("reference example validates against reference-response-v1.json", () => {
  expect(() => expectValid("reference-response", EXAMPLE)).not.toThrow();
  expect(() => expectValid("reference-response", referenceFixture())).not.toThrow();
  expect(parseReference(EXAMPLE).version).toBe(EXAMPLE.reference_version);
});

test("downloads only when reference_version changes", async () => {
  const db = await createTestDb();
  const client = clientOf(EXAMPLE);
  expect(await loadReference(db)).toBeNull();
  expect(await refreshReference(db, client, EXAMPLE.reference_version)).toBe("updated");
  expect(await refreshReference(db, client, EXAMPLE.reference_version)).toBe("unchanged");
  expect(client.reference).toHaveBeenCalledTimes(1);
  expect((await loadReference(db))!.version).toBe(EXAMPLE.reference_version);

  const newer = { ...referenceFixture(), reference_version: "ab".repeat(32) };
  const second = clientOf(newer);
  expect(await refreshReference(db, second, newer.reference_version)).toBe("updated");
  expect(second.reference).toHaveBeenCalledTimes(1);
  const stored = (await loadReference(db))!;
  expect(stored.version).toBe(newer.reference_version);
  expect(stored.neighborhoods).toEqual(newer.neighborhoods);
});

test("invalid shape keeps the previous reference", async () => {
  const db = await createTestDb();
  await refreshReference(db, clientOf(EXAMPLE), EXAMPLE.reference_version);
  const broken = { ...EXAMPLE, reference_version: "ef".repeat(32), health_units: "nenhuma" };
  expect(await refreshReference(db, clientOf(broken), broken.reference_version)).toBe("kept_previous");
  expect((await loadReference(db))!.version).toBe(EXAMPLE.reference_version);
  // Without a previous one there is still none: the forms say the reference is missing, they do not guess.
  const empty = await createTestDb();
  expect(await refreshReference(empty, clientOf(broken), broken.reference_version)).toBe("kept_previous");
  expect(await loadReference(empty)).toBeNull();
});

test("a domain sent as an object is refused and the previous reference stays (Q27)", async () => {
  const db = await createTestDb();
  await refreshReference(db, clientOf(EXAMPLE), EXAMPLE.reference_version);
  const asObject = example<ReferenceResponse>("invalid-reference-domain-as-object.json");
  expect(await refreshReference(db, clientOf(asObject), "01".repeat(32))).toBe("kept_previous");
  expect((await loadReference(db))!.version).toBe(EXAMPLE.reference_version);
});

test("an HTTP failure goes up to the round and the stored reference stays", async () => {
  const db = await createTestDb();
  await refreshReference(db, clientOf(EXAMPLE), EXAMPLE.reference_version);
  const down = { reference: jest.fn(async () => { throw new FieldHttpError({ kind: "network" }); }) };
  await expect(refreshReference(db, down, "23".repeat(32))).rejects.toBeInstanceOf(FieldHttpError);
  expect((await loadReference(db))!.version).toBe(EXAMPLE.reference_version);
});

test("professionalOptions keeps has_cns and filters by team; unit without CNES has has_cnes false (Q6)", () => {
  const body = referenceFixture();
  const ref = parseReference(body);
  const [first, , otherTeam] = body.team_professionals; // two in the first team, one in another
  expect(professionalOptions(ref, first.team_id)).toEqual(
    body.team_professionals.filter((p) => p.team_id === first.team_id).map((p) => ({ id: p.professional_id, name: p.name, cbo: p.cbo, has_cns: p.has_cns })));
  expect(professionalOptions(ref, first.team_id)).toHaveLength(2);
  expect(professionalOptions(ref, otherTeam.team_id).map((p) => p.has_cns)).toEqual([false]);
  expect(professionalOptions(ref, "00000000-0000-4000-8000-000000000000")).toEqual([]);
  expect(healthUnitOptions(ref).map((u) => [u.name, u.cnes, u.has_cnes])).toEqual([
    ["UBS Vila Nova", "2384299", true], ["Ponto de apoio Jardim Esperança", null, false],
  ]);
});

test("home visit and activity codes in the reference equal those of domains-v1.json", () => {
  const ref = parseReference(referenceFixture());
  const codes = (list: readonly { code: number | string }[]) => list.map((entry) => entry.code);
  expect(codes(ref.homeVisitDomains.motivo_visita)).toEqual(domains.home_visit.motivo_visita.flatMap((group) => codes(group.items)));
  expect(new Set(ref.homeVisitDomains.motivo_visita.map((m) => m.group))).toEqual(new Set(domains.home_visit.motivo_visita.map((g) => g.group)));
  expect(codes(ref.homeVisitDomains.desfecho)).toEqual(codes(domains.home_visit.desfecho));
  expect(codes(ref.homeVisitDomains.turno)).toEqual(codes(domains.home_visit.turno));
  expect(codes(ref.homeVisitDomains.tipo_glicemia)).toEqual(codes(domains.home_visit.tipo_glicemia));
  expect(codes(ref.homeVisitDomains.tipo_de_imovel)).toEqual(codes(domains.home_visit.tipo_de_imovel));
  expect(ref.homeVisitDomains.reasons_max).toBe(domains.home_visit.rules.reasons_max);
  expect(ref.homeVisitDomains.non_residential_property_types).toEqual(domains.home_visit.rules.non_residential_property_types);
  // The ranges are the measurements that have limits (glucose_type is a choice, not a range).
  const ranged = Object.entries(domains.home_visit.rules.measurements).filter(([, row]) => "min" in row).map(([key]) => key);
  expect(Object.keys(ref.homeVisitDomains.measurement_ranges).sort()).toEqual(ranged.sort());
  expect(codes(ref.collectiveDomains.activity_types)).toEqual(codes(domains.collective_activity.tipo_atividade_coletiva));
  expect(codes(ref.collectiveDomains.procedures)).toEqual(codes(domains.collective_activity.outro_procedimento_coletivo));
});
