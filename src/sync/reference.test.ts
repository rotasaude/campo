import { domains, type ReferenceResponse, type SessionResponse } from "../contract";
import { example } from "../contract/fixtures";
import { expectValid } from "../contract/validate";
import { createTestDb } from "../db/testing/sqljsDb";
import { loadHome } from "../features/home/homeData";
import { canRecordInspection, loadSession } from "../features/session";
import { loadedTablet } from "../features/testing";
import { ReferenceShapeError } from "../rules/dictionaries";
import { ANIMAL_SEXES, ANIMAL_SIZES, ANIMAL_SPECIES, ANIMAL_STATUSES, DPP_RESULTS, ZOONOSES_PRODUCT_USES, parseZoonosesDomains } from "../rules/zoonosesDomains";
import { DEPOSIT_GROUPS, MEASURE_METHODS, RISK_CLASSES, VECTOR_ACTIVITIES, VECTOR_SITUATIONS, VECTOR_WORK_TYPES, parseVectorDomains } from "../rules/vectorDomains";
import { FieldHttpError } from "./http";
import { APP_UPDATE_NOTICE, healthUnitOptions, loadReference, parseReference, professionalOptions, referenceNeedsAppUpdate, refreshReference } from "./reference";
import { referenceFixture } from "./testing";

const EXAMPLE = example<ReferenceResponse>("reference.json");
// The v1.3.0 example with the vector block (same reference_version as reference.json in the tag: told apart here).
const VECTOR = { ...example<ReferenceResponse>("reference-vector-control.json"), reference_version: "35".repeat(32) };
const NOW = Date.parse("2026-11-19T15:00:00Z");
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

test("a reference the app does not understand asks for an app update and the work goes on with the previous one (Q71)", async () => {
  const db = await createTestDb();
  await refreshReference(db, clientOf(EXAMPLE), EXAMPLE.reference_version);
  expect(await referenceNeedsAppUpdate(db)).toBe(false);

  // A section this version of the app has never heard of.
  const newer = { ...EXAMPLE, reference_version: "45".repeat(32),
    registration_dictionaries: { ...EXAMPLE.registration_dictionaries, sections: { living_conditions: [], novidade: [] } } };
  const client = clientOf(newer);
  expect(await refreshReference(db, client, newer.reference_version)).toBe("kept_previous");
  expect(await referenceNeedsAppUpdate(db)).toBe(true);
  expect((await loadReference(db))!.version).toBe(EXAMPLE.reference_version);
  expect(APP_UPDATE_NOTICE).toBe("Atualize o app: há novidades no cadastro que esta versão não conhece. O app segue funcionando com as regras anteriores.");

  // The same refused version is not downloaded again on every round.
  expect(await refreshReference(db, client, newer.reference_version)).toBe("kept_previous");
  expect(client.reference).toHaveBeenCalledTimes(1);

  // Another version is tried; when one is understood, the notice goes away.
  const good = { ...referenceFixture(), reference_version: "67".repeat(32) };
  expect(await refreshReference(db, clientOf(good), good.reference_version)).toBe("updated");
  expect(await referenceNeedsAppUpdate(db)).toBe(false);
});

test("the server going back to the version the tablet already has also clears the notice", async () => {
  const db = await createTestDb();
  await refreshReference(db, clientOf(EXAMPLE), EXAMPLE.reference_version);
  const broken = { ...EXAMPLE, reference_version: "89".repeat(32), health_units: "nenhuma" };
  await refreshReference(db, clientOf(broken), broken.reference_version);
  expect(await referenceNeedsAppUpdate(db)).toBe(true);
  expect(await refreshReference(db, clientOf(EXAMPLE), EXAMPLE.reference_version)).toBe("unchanged");
  expect(await referenceNeedsAppUpdate(db)).toBe(false);
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

test("reference without vector_control_domains parses with vectorDomains null", () => {
  expect(EXAMPLE).not.toHaveProperty("vector_control_domains");
  expect(parseReference(EXAMPLE).vectorDomains).toBeNull();
  expect(parseReference(referenceFixture()).vectorDomains).toBeNull();
  expect(parseVectorDomains(undefined)).toBeNull();
});

test("vector_control_domains of the v1.3.0 example is parsed with the five limits", async () => {
  expect(() => expectValid("reference-response", VECTOR)).not.toThrow();
  const parsed = parseReference(VECTOR).vectorDomains!;
  expect(parsed.limits).toEqual({ deposit_count_max: 999, charges_max: 999, samples_max: 99, larvae_collected_max: 10, measures_max: 20 });
  expect(parsed.limits).toEqual(domains.vector_control.limits);
  // Nothing renamed or dropped; the charge stays text with two places (Q15).
  expect(parsed).toEqual(VECTOR.vector_control_domains);
  expect(parsed.products.map((p) => p.charge_size)).toEqual(["1.00", "12.50"]);
  expect(parsed.cadences[0]).toEqual({ neighborhood_id: null, risk_class: null, strategic_point: true, days: 15 });
  // The codes the app knows are those of domains-v1.json.
  const codes = (list: readonly { code: string }[]) => list.map((entry) => entry.code);
  expect(VECTOR_ACTIVITIES).toEqual(codes(domains.vector_control.activities));
  expect(VECTOR_WORK_TYPES).toEqual(codes(domains.vector_control.work_types));
  expect(VECTOR_SITUATIONS).toEqual(codes(domains.vector_control.situations));
  expect(DEPOSIT_GROUPS).toEqual(codes(domains.vector_control.deposit_groups));
  expect(MEASURE_METHODS).toEqual(codes(domains.vector_control.measure_methods));
  expect(RISK_CLASSES).toEqual(codes(domains.vector_control.risk_classes));

  // Stored and read back the same.
  const db = await createTestDb();
  expect(await refreshReference(db, clientOf(VECTOR), VECTOR.reference_version)).toBe("updated");
  expect((await loadReference(db))!.vectorDomains).toEqual(VECTOR.vector_control_domains);
});

test("Q44(1): a domain with a new use is saved with vectorDomains null and the ACS gets no app update notice", async () => {
  const block = VECTOR.vector_control_domains!;
  const [product] = block.products;
  const news: [string, unknown][] = [
    ["new product use", { ...block, products: [{ ...product, uses: ["focal", "larvitrampa"] }] }],
    ["new product unit", { ...block, products: [{ ...product, unit: "kg" }] }],
    ["new activity", { ...block, activities: [...block.activities, { code: "novidade", label: "Novidade" }] }],
    ["new deposit group", { ...block, deposit_groups: [...block.deposit_groups, { code: "F", label: "F" }] }],
    ["new cadence risk", { ...block, cadences: [{ ...block.cadences[0], risk_class: "blue" }] }],
  ];
  for (const [index, [label, raw]] of news.entries()) {
    expect([label, parseVectorDomains(raw)]).toEqual([label, null]);
    // A tablet of the ACS with the previous reference: the new one is stored, without the vector block.
    const db = await loadedTablet();
    const body = { ...VECTOR, reference_version: (index + 0xa0).toString(16).repeat(32), vector_control_domains: raw };
    expect([label, await refreshReference(db, clientOf(body), body.reference_version)]).toEqual([label, "updated"]);
    const stored = (await loadReference(db))!;
    expect([stored.version, stored.vectorDomains]).toEqual([body.reference_version, null]);
    expect(await referenceNeedsAppUpdate(db)).toBe(false);
    const session = (await loadSession(db))!;
    expect(session.professional.cbo).toBe("515105");
    expect((await loadHome(db, NOW)).appUpdate).toBe(false);
    // The bulletin is unavailable for the agent too, with the same reference.
    expect(canRecordInspection(example<SessionResponse>("session-endemic-agent.json"), stored)).toBe(false);
  }
});

test("Q44(1)/Q71: an unknown code in a 24c dictionary still refuses the whole reference", async () => {
  const db = await createTestDb();
  expect(await refreshReference(db, clientOf(VECTOR), VECTOR.reference_version)).toBe("updated");
  const newer = { ...VECTOR, reference_version: "bc".repeat(32),
    registration_dictionaries: { ...VECTOR.registration_dictionaries, sections: { living_conditions: [{ key: "novo", ledi: "novo", type: "novidade" }] } } };
  expect(await refreshReference(db, clientOf(newer), newer.reference_version)).toBe("kept_previous");
  expect(await referenceNeedsAppUpdate(db)).toBe(true);
  const stored = (await loadReference(db))!;
  expect(stored.version).toBe(VECTOR.reference_version);
  expect(stored.vectorDomains).toEqual(VECTOR.vector_control_domains);
});

test("a malformed vector block keeps the previous reference (kept_previous)", async () => {
  const db = await createTestDb();
  expect(await refreshReference(db, clientOf(VECTOR), VECTOR.reference_version)).toBe("updated");
  const block = VECTOR.vector_control_domains!;
  const [product] = block.products;
  const broken: [string, unknown][] = [
    ["invalid-reference-product-charge-size-number.json", example<ReferenceResponse>("invalid-reference-product-charge-size-number.json").vector_control_domains],
    ["invalid-reference-product-without-uses.json", example<ReferenceResponse>("invalid-reference-product-without-uses.json").vector_control_domains],
    ["null block", null],
    ["charge without two places", { ...block, products: [{ ...product, charge_size: "1.5" }] }],
    ["mechanical product", { ...block, products: [{ ...product, uses: ["mechanical"] }] }],
    ["limit missing", { ...block, limits: { ...block.limits, measures_max: undefined } }],
    ["limit zero", { ...block, limits: { ...block.limits, samples_max: 0 } }],
    ["parameter not integer", { ...block, parameters: { ...block.parameters, default_days: "60" } }],
    ["cadence days fraction", { ...block, cadences: [{ ...block.cadences[0], days: 15.5 }] }],
    ["list as object", { ...block, deposit_groups: { A1: "A1" } }],
    ["code not text", { ...block, work_types: [{ code: 1, label: "Rotina" }] }],
    // Shape wins over news: a new code does not excuse a broken block.
    ["unknown code and broken shape", { ...block, activities: [...block.activities, { code: "novidade", label: "Novidade" }], limits: {} }],
    ["empty list", { ...block, situations: [] }],
  ];
  for (const [index, [label, raw]] of broken.entries()) {
    let thrown: unknown = null;
    try { parseVectorDomains(raw); } catch (err) { thrown = err; }
    expect([label, thrown instanceof ReferenceShapeError]).toEqual([label, true]);
    const body = { ...VECTOR, reference_version: index.toString(16).padStart(2, "0").repeat(32), vector_control_domains: raw };
    expect(await refreshReference(db, clientOf(body), body.reference_version)).toBe("kept_previous");
    const stored = (await loadReference(db))!;
    expect(stored.version).toBe(VECTOR.reference_version);
    expect(stored.vectorDomains).toEqual(block);
  }
  expect(await referenceNeedsAppUpdate(db)).toBe(true);
});

// ── 35b: zoonoses_domains ──
const ZOONOSES = { ...example<ReferenceResponse>("reference-zoonoses.json"), reference_version: "36".repeat(32) };

test("reference without zoonoses_domains parses with zoonosesDomains null", () => {
  expect(EXAMPLE).not.toHaveProperty("zoonoses_domains");
  expect(parseReference(EXAMPLE).zoonosesDomains).toBeNull();
  expect(parseReference(VECTOR).zoonosesDomains).toBeNull();
  expect(parseReference(referenceFixture()).zoonosesDomains).toBeNull();
  expect(parseZoonosesDomains(undefined)).toBeNull();
});

test("zoonoses_domains of the v1.4.0 example is parsed; products only rabies_vaccine and collar", async () => {
  expect(() => expectValid("reference-response", ZOONOSES)).not.toThrow();
  const parsed = parseReference(ZOONOSES).zoonosesDomains!;
  expect(parsed).toEqual(ZOONOSES.zoonoses_domains);
  expect(parsed.products.map((p) => p.use)).toEqual(["rabies_vaccine", "collar"]);
  expect(parsed.parameters).toEqual({ collar_months: 6 });
  expect(parsed.limits).toEqual(domains.zoonoses.limits);
  const codes = (list: readonly { code: string }[]) => list.map((entry) => entry.code);
  expect(ANIMAL_SPECIES).toEqual(codes(domains.zoonoses.species));
  expect(ANIMAL_SEXES).toEqual(codes(domains.zoonoses.sexes));
  expect(ANIMAL_SIZES).toEqual(codes(domains.zoonoses.sizes));
  expect(ANIMAL_STATUSES).toEqual(codes(domains.zoonoses.animal_statuses));
  expect(DPP_RESULTS).toEqual(codes(domains.zoonoses.dpp_results));
  expect(ZOONOSES_PRODUCT_USES).toEqual(codes(domains.zoonoses.product_uses));

  const db = await createTestDb();
  expect(await refreshReference(db, clientOf(ZOONOSES), ZOONOSES.reference_version)).toBe("updated");
  expect((await loadReference(db))!.zoonosesDomains).toEqual(ZOONOSES.zoonoses_domains);
});

test("open_campaign null is kept as null", async () => {
  const raw = { ...ZOONOSES.zoonoses_domains!, open_campaign: null };
  expect(parseZoonosesDomains(raw)!.open_campaign).toBeNull();
  const body = { ...ZOONOSES, reference_version: "37".repeat(32), zoonoses_domains: raw };
  expect(() => expectValid("reference-response", body)).not.toThrow();
  const db = await createTestDb();
  expect(await refreshReference(db, clientOf(body), body.reference_version)).toBe("updated");
  expect((await loadReference(db))!.zoonosesDomains!.open_campaign).toBeNull();
});

test("an unknown species code drops only the zoonoses block; vectorDomains and the forms stay", async () => {
  const block = ZOONOSES.zoonoses_domains!;
  const vector = VECTOR.vector_control_domains!;
  const news: [string, unknown][] = [
    ["new species", { ...block, species: [...block.species, { code: "bird", label: "Ave" }] }],
    ["new sex", { ...block, sexes: [...block.sexes, { code: "x", label: "X" }] }],
    ["new size", { ...block, sizes: [...block.sizes, { code: "giant", label: "Gigante" }] }],
    ["new status", { ...block, animal_statuses: [...block.animal_statuses, { code: "adopted", label: "Adotado" }] }],
    ["new dpp result", { ...block, dpp_results: [...block.dpp_results, { code: "weak", label: "Fraco" }] }],
    ["new product use", { ...block, products: [{ ...block.products[0], use: "dewormer" }] }],
  ];
  for (const [index, [label, raw]] of news.entries()) {
    expect([label, parseZoonosesDomains(raw)]).toEqual([label, null]);
    const db = await loadedTablet();
    const body = { ...VECTOR, reference_version: (index + 0xc0).toString(16).repeat(32), zoonoses_domains: raw };
    expect([label, await refreshReference(db, clientOf(body), body.reference_version)]).toEqual([label, "updated"]);
    const stored = (await loadReference(db))!;
    expect([stored.version, stored.zoonosesDomains]).toEqual([body.reference_version, null]);
    expect(stored.vectorDomains).toEqual(vector);
    expect(stored.homeVisitDomains).toEqual(VECTOR.home_visit_domains);
    expect(stored.collectiveDomains).toEqual(VECTOR.collective_activity_domains);
    expect(await referenceNeedsAppUpdate(db)).toBe(false);
    expect((await loadHome(db, NOW)).appUpdate).toBe(false);
  }
});

test("a malformed zoonoses block keeps the previous reference (kept_previous)", async () => {
  const db = await createTestDb();
  expect(await refreshReference(db, clientOf(ZOONOSES), ZOONOSES.reference_version)).toBe("updated");
  const block = ZOONOSES.zoonoses_domains!;
  const broken: [string, unknown][] = [
    ["invalid-reference-zoonoses-campaign-with-goal.json", example<ReferenceResponse>("invalid-reference-zoonoses-campaign-with-goal.json").zoonoses_domains],
    ["invalid-reference-zoonoses-collar-months-13.json", example<ReferenceResponse>("invalid-reference-zoonoses-collar-months-13.json").zoonoses_domains],
    ["invalid-reference-zoonoses-species-empty.json", example<ReferenceResponse>("invalid-reference-zoonoses-species-empty.json").zoonoses_domains],
    ["invalid-reference-zoonoses-without-open-campaign.json", example<ReferenceResponse>("invalid-reference-zoonoses-without-open-campaign.json").zoonoses_domains],
    ["null block", null],
    ["list as object", { ...block, sexes: { male: "Macho" } }],
    ["code not text", { ...block, sizes: [{ code: 1, label: "Pequeno" }] }],
    ["product without name", { ...block, products: [{ ...block.products[0], name: undefined }] }],
    ["limit missing", { ...block, limits: { ...block.limits, microchip_digits: undefined } }],
    ["limit zero", { ...block, limits: { ...block.limits, name_max: 0 } }],
    ["collar months zero", { ...block, parameters: { collar_months: 0 } }],
    ["campaign date not a date", { ...block, open_campaign: { ...block.open_campaign, starts_on: "amanha" } }],
    // Shape wins over news: a new code does not excuse a broken block.
    ["unknown code and broken shape", { ...block, species: [...block.species, { code: "bird", label: "Ave" }], limits: {} }],
  ];
  for (const [index, [label, raw]] of broken.entries()) {
    let thrown: unknown = null;
    try { parseZoonosesDomains(raw); } catch (err) { thrown = err; }
    expect([label, thrown instanceof ReferenceShapeError]).toEqual([label, true]);
    const body = { ...ZOONOSES, reference_version: index.toString(16).padStart(2, "0").repeat(32), zoonoses_domains: raw };
    expect([label, await refreshReference(db, clientOf(body), body.reference_version)]).toEqual([label, "kept_previous"]);
    const stored = (await loadReference(db))!;
    expect(stored.version).toBe(ZOONOSES.reference_version);
    expect(stored.zoonosesDomains).toEqual(block);
  }
  expect(await referenceNeedsAppUpdate(db)).toBe(true);
});
