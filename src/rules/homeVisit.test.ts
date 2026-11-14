// Ported from apps/dashboard/src/lib/homeVisits.test.ts (dashboard main ceb53af): the cases of the visit rules,
// unchanged — same `path`, same sentence. The cases of the api's error phrases, of the gates and of the labels
// of the day sheet stay on the dashboard (the app does not have those).
import {
  EMPTY_MEASURES, allowedMeasurements, createVisitRules, emptyVisitDraft, familyVisitNotice, isNonResidential, measurementsAllowed,
  measurementsAnyAllowed, measurementsProblems, offeredReasons, parseMeasure, pruneVisitDraft, reasonsFor, shiftPreview, textProblem, type VisitDraft,
} from "./homeVisit";
import { createRegistryRules } from "./registry";
import { registrationDictionaries } from "./testing/dictionaries";
import { NOW24B, TODAY24B, VISIT_DOMAINS, acsTeam, household, householdDetail, tacsTeam } from "./testing/visitFixtures";

// The city of the dashboard's tests: UTC−3.
const { occurredAt, quickPatientProblems, visitProblems, visitBody } = createVisitRules({
  offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem,
});
const ctx = { domains: VISIT_DOMAINS, today: TODAY24B, minDate: "2026-10-01", team: acsTeam(), now: NOW24B };
const draft = (o: Partial<VisitDraft> = {}): VisitDraft => ({ ...emptyVisitDraft(), day: TODAY24B, time: "09:15", ...o });
const inHousehold = (o: Partial<VisitDraft> = {}) => draft({ place: { kind: "household", householdId: "h1", propertyType: "1", microAreaId: "ma1" }, ...o });

describe("motivos e medidas (§3, lidos do domínio)", () => {
  it("recusada e ausente não levam motivo; não residencial só os do domínio; 5 e 6 indisponíveis para male", () => {
    expect(reasonsFor(VISIT_DOMAINS, { propertyType: "1", outcome: 2, sex: null })).toEqual([]);
    expect(reasonsFor(VISIT_DOMAINS, { propertyType: "1", outcome: 3, sex: null })).toEqual([]);
    expect(reasonsFor(VISIT_DOMAINS, { propertyType: "2", outcome: 1, sex: null }).map((r) => r.code)).toEqual([ 1, 34, 35, 36, 37, 27, 31, 28 ]);
    expect(isNonResidential(VISIT_DOMAINS, "2")).toBe(true);
    expect(isNonResidential(VISIT_DOMAINS, "1")).toBe(false);
    const male = reasonsFor(VISIT_DOMAINS, { propertyType: "1", outcome: 1, sex: "male" });
    expect(male.find((r) => r.code === 5)!.disabled).toBe("não se aplica a pessoa do sexo masculino");
    expect(male.find((r) => r.code === 11)!.disabled).toBeNull();
    expect(male.map((r) => r.group_label)).toContain("Controle ambiental e vetorial");
  });

  it("Q34/Q44: sem pessoa, só 1, 27 e 28; 29 e 34–37 só sem família ativa", () => {
    const base = { propertyType: "1", outcome: 1 as const, sex: null, subject: "none" as const };
    expect(reasonsFor(VISIT_DOMAINS, { ...base, hasActiveFamily: false }).map((r) => [ r.code, r.disabled ]))
      .toEqual([ [ 1, null ], [ 29, null ], [ 34, null ], [ 35, null ], [ 36, null ], [ 37, null ], [ 27, null ], [ 28, null ] ]);
    const withFamily = reasonsFor(VISIT_DOMAINS, { ...base, hasActiveFamily: true });
    expect(withFamily.filter((r) => r.disabled === null).map((r) => r.code)).toEqual([ 1, 27, 28 ]);
    expect(withFamily.find((r) => r.code === 29)!.disabled).toBe("com família ativa no domicílio, escolha a família");
    expect(withFamily.find((r) => r.code === 37)!.disabled).toBe("com família ativa no domicílio, escolha a família");
  });

  it("medidas por chave: só em realizada residencial; sem pessoa, peso e altura ficam de fora (Q34)", () => {
    expect(measurementsAllowed(VISIT_DOMAINS, { propertyType: "1", outcome: 1 }).systolic).toBe(true);
    expect(measurementsAnyAllowed(measurementsAllowed(VISIT_DOMAINS, { propertyType: "4", outcome: 1 }))).toBe(false);
    expect(measurementsAnyAllowed(measurementsAllowed(VISIT_DOMAINS, { propertyType: "1", outcome: 3 }))).toBe(false);
    const none = measurementsAllowed(VISIT_DOMAINS, { propertyType: "1", outcome: 1, subject: "none" });
    expect(none.weight_kg).toBe(false);
    expect(none.height_cm).toBe(false);
    expect(none.systolic).toBe(true);
    expect(none.temperature_c).toBe(true);
  });

  it("parseMeasure: vírgula ou ponto; vazio é null; inválido é undefined", () => {
    expect(parseMeasure("72,5")).toBe(72.5);
    expect(parseMeasure("72.5")).toBe(72.5);
    expect(parseMeasure(" 130 ")).toBe(130);
    expect(parseMeasure("")).toBeNull();
    expect(parseMeasure("  ")).toBeNull();
    expect(parseMeasure("7a")).toBeUndefined();
    expect(parseMeasure("-1")).toBeUndefined();
    expect(parseMeasure("1,2,3")).toBeUndefined();
  });

  it("medidas: faixa, casas e os pares (pressão, glicemia)", () => {
    expect(measurementsProblems(VISIT_DOMAINS, { ...EMPTY_MEASURES, weight_kg: "0,4", height_cm: "160,25", systolic: "130", glucose_mg_dl: "110" })
      .map((p) => p.path).sort()).toEqual([ "measurements.diastolic", "measurements.glucose_type", "measurements.height_cm", "measurements.weight_kg" ]);
    expect(measurementsProblems(VISIT_DOMAINS, { ...EMPTY_MEASURES, systolic: "130", diastolic: "85", glucose_mg_dl: "110", glucose_type: "0", temperature_c: "36,5" })).toEqual([]);
    expect(measurementsProblems(VISIT_DOMAINS, { ...EMPTY_MEASURES, glucose_type: "1" }).map((p) => p.path)).toEqual([ "measurements.glucose_mg_dl" ]);
    expect(measurementsProblems(VISIT_DOMAINS, { ...EMPTY_MEASURES, temperature_c: "50" }).map((p) => p.path)).toEqual([ "measurements.temperature_c" ]);
    expect(measurementsProblems(VISIT_DOMAINS, { ...EMPTY_MEASURES, systolic: "1000", diastolic: "80" }).map((p) => p.path)).toEqual([ "measurements.systolic" ]);
    expect(measurementsProblems(VISIT_DOMAINS, { ...EMPTY_MEASURES, systolic: "abc", diastolic: "80" }).map((p) => p.path)).toEqual([ "measurements.systolic" ]);
  });

  it("data e turno: occurredAt pela hora da cidade; shiftPreview só para a tela", () => {
    expect(occurredAt("2026-11-12", "09:15")).toBe("2026-11-12T09:15:00-03:00");
    expect(occurredAt("", "09:15")).toBeNull();
    expect(occurredAt("2026-11-12", "")).toBeNull();
    expect(shiftPreview("09:15")).toBe("Manhã");
    expect(shiftPreview("12:00")).toBe("Tarde");
    expect(shiftPreview("18:00")).toBe("Noite");
    expect(shiftPreview("")).toBeNull();
  });
});

describe("visitProblems", () => {
  it("todas as recusas de uma vez, com o path do api", () => {
    const problems = visitProblems(draft({ day: "2026-09-30", place: { kind: "no_household", propertyType: "", microAreaId: null, outOfArea: false },
      outcome: null, note: "x".repeat(501) }), ctx);
    expect(problems.map((p) => p.path).sort()).toEqual([ "micro_area_id", "note", "occurred_at", "outcome", "property_type" ]);
    expect(problems.find((p) => p.path === "occurred_at")!.text).toBe("a data da visita vai de 01/10/2026 até agora");
  });

  it("hora futura no dia de hoje; dia depois de hoje", () => {
    const place = { kind: "no_household", propertyType: "1", microAreaId: "ma1", outOfArea: false } as const;
    const base = { place, subject: "none", outcome: 3 } as const;
    expect(visitProblems(draft({ ...base, time: "11:00" }), ctx).map((p) => p.path)).toEqual([ "occurred_at" ]);
    expect(visitProblems(draft({ ...base, day: "2026-11-13", time: "08:00" }), ctx).map((p) => p.path)).toEqual([ "occurred_at" ]);
    expect(visitProblems(draft({ ...base, time: "10:00" }), ctx)).toEqual([]);
  });

  it("imóvel não residencial não leva pessoa nem motivo fora da lista; fora de área é só do ACS", () => {
    const nonRes = visitProblems(draft({ place: { kind: "no_household", propertyType: "2", microAreaId: "ma1", outOfArea: false },
      subject: "resident", person: { kind: "patient", patientId: "pa1", sex: null }, outcome: 1, reasons: [ 5 ] }), ctx);
    expect(nonRes.map((p) => p.path)).toEqual(expect.arrayContaining([ "subject", "reasons[0]" ]));
    const tacs = visitProblems(draft({ place: { kind: "no_household", propertyType: "1", microAreaId: null, outOfArea: true }, outcome: 3 }),
      { ...ctx, team: tacsTeam() });
    expect(tacs.find((p) => p.path === "out_of_area")!.text).toBe("fora de área é só para o ACS");
  });

  it("morador sem pessoa, família sem família, observação com code points", () => {
    expect(visitProblems(inHousehold({ subject: "resident", outcome: 3 }), ctx).map((p) => p.path)).toEqual([ "patient_id" ]);
    expect(visitProblems(inHousehold({ subject: "family_responsible", outcome: 3 }), ctx).map((p) => p.path)).toEqual([ "family_id" ]);
    expect(visitProblems(inHousehold({ subject: null, outcome: 3 }), ctx).map((p) => p.path)).toEqual([ "subject" ]);
    expect(visitProblems(inHousehold({ subject: "none", outcome: 3, note: "😀".repeat(500) }), ctx)).toEqual([]);
    expect(visitProblems(inHousehold({ subject: "none", outcome: 3, note: "😀".repeat(501) }), ctx).map((p) => p.path)).toEqual([ "note" ]);
  });

  it("registro rápido: os problemas saem com path new_patient.<campo> e texto", () => {
    const p = visitProblems(inHousehold({ subject: "resident", outcome: 3,
      person: { kind: "new", patient: { full_name: "", birth_date: "", sex: "female" }, duplicatesReviewed: false } }), ctx);
    expect(p).toHaveLength(1);
    expect(p[0].path).toBe("new_patient.full_name");
    expect(typeof p[0].text).toBe("string");
    expect(quickPatientProblems({ full_name: "Ana Prado", birth_date: "1990-04-02", sex: "female", cpf: "52998224725" }, TODAY24B)).toEqual([]);
  });

  it("Q36: mais motivos que reasons_max recusa em reasons", () => {
    const reasons = Array.from({ length: 37 }, (_, i) => i + 1);
    const p = visitProblems(inHousehold({ subject: "none", outcome: 1, reasons }), ctx);
    expect(p.find((x) => x.path === "reasons")!.text).toBe("no máximo 36 motivos");
  });

  it("Q34/Q44: sem pessoa com família ativa, 29 vira reasons[i] e peso vira measurements.weight_kg; pressão passa", () => {
    const withFamily = { ...ctx, household: household() };
    const p = visitProblems(inHousehold({ subject: "none", outcome: 1, reasons: [ 1, 29 ],
      measurements: { ...EMPTY_MEASURES, weight_kg: "70", systolic: "120", diastolic: "80" } }), withFamily);
    expect(p.map((x) => x.path).sort()).toEqual([ "measurements.weight_kg", "reasons[1]" ]);
    const without = visitProblems(inHousehold({ subject: "none", outcome: 1, reasons: [ 1, 29 ] }), { ...ctx, household: household({ has_active_family: false, families: [] }) });
    expect(without).toEqual([]);
  });

  it("recusada ou ausente com motivo ou medida recusa; medida em imóvel não residencial recusa por chave", () => {
    expect(visitProblems(inHousehold({ subject: "none", outcome: 2, reasons: [ 1 ] }), ctx).map((p) => p.path)).toEqual([ "reasons" ]);
    expect(visitProblems(inHousehold({ subject: "none", outcome: 3, measurements: { ...EMPTY_MEASURES, systolic: "120", diastolic: "80" } }), ctx)
      .map((p) => p.path).sort()).toEqual([ "measurements.diastolic", "measurements.systolic" ]);
    expect(visitProblems(draft({ place: { kind: "no_household", propertyType: "4", microAreaId: "ma1", outOfArea: false }, outcome: 1,
      measurements: { ...EMPTY_MEASURES, temperature_c: "36" } }), ctx).map((p) => p.path)).toEqual([ "measurements.temperature_c" ]);
  });

  it("Q35/Q43: com a conversão para a família, o sexo dos motivos 5 e 6 é o do responsável", () => {
    const h = householdDetail();
    // Maria (mulher) é moradora da família f1, cujo responsável é José (homem).
    const converted = inHousehold({ subject: "resident", person: { kind: "patient", patientId: "pa1", sex: "female" }, outcome: 1, reasons: [ 29, 5 ] });
    expect(visitProblems(converted, { ...ctx, household: h }).map((p) => p.path)).toEqual([ "reasons[1]" ]);
    const plain = inHousehold({ subject: "resident", person: { kind: "patient", patientId: "pa1", sex: "female" }, outcome: 1, reasons: [ 11, 5 ] });
    expect(visitProblems(plain, { ...ctx, household: h })).toEqual([]);
  });
});

describe("o desfecho segue o dado do domínio (revisão da Task 2)", () => {
  it("reasons_max e without_person_allowed_reasons mutados mudam a recusa e a oferta", () => {
    const domains = { ...VISIT_DOMAINS, reasons_max: 2, without_person_allowed_reasons: [ 28 ] };
    const p = visitProblems(inHousehold({ subject: "none", outcome: 1, reasons: [ 1, 27, 28 ] }), { ...ctx, domains, household: household({ has_active_family: false, families: [] }) });
    expect(p.find((x) => x.path === "reasons")!.text).toBe("no máximo 2 motivos");
    expect(p.map((x) => x.path)).toEqual(expect.arrayContaining([ "reasons[0]", "reasons[1]" ]));
    expect(p.map((x) => x.path)).not.toContain("reasons[2]");
    expect(reasonsFor(domains, { propertyType: "1", outcome: 1, sex: null, subject: "none", hasActiveFamily: true }).filter((r) => !r.disabled).map((r) => r.code))
      .toEqual([ 28 ]);
  });

  it("uma faixa mutada em measurement_ranges muda a recusa", () => {
    const domains = { ...VISIT_DOMAINS, measurement_ranges: { ...VISIT_DOMAINS.measurement_ranges, systolic: { min: 50, max: 200, decimals: 0 } } };
    const m = { ...EMPTY_MEASURES, systolic: "250", diastolic: "80" };
    expect(measurementsProblems(VISIT_DOMAINS, m)).toEqual([]);
    expect(measurementsProblems(domains, m)).toEqual([ { path: "measurements.systolic", text: "pressão sistólica: de 50 a 200" } ]);
  });

  it("medida proibida sem o par: só a frase de 'não vale', nunca a do par", () => {
    const refused = (m: Partial<typeof EMPTY_MEASURES>) =>
      visitProblems(inHousehold({ subject: "none", outcome: 3, measurements: { ...EMPTY_MEASURES, ...m } }), ctx);
    expect(refused({ systolic: "120" })).toEqual([ { path: "measurements.systolic", text: "esta medida não vale para esta visita" } ]);
    expect(refused({ glucose_mg_dl: "110" })).toEqual([ { path: "measurements.glucose_mg_dl", text: "esta medida não vale para esta visita" } ]);
    expect(refused({ glucose_type: "0" })).toEqual([ { path: "measurements.glucose_type", text: "esta medida não vale para esta visita" } ]);
  });
});

describe("oferta e poda do rascunho (Task 7)", () => {
  const maria = { kind: "patient", patientId: "pa1", sex: "female" } as const;
  it("offeredReasons usa o sujeito depois da conversão (Q43: o sexo é o do responsável)", () => {
    const d = inHousehold({ subject: "resident", person: maria, outcome: 1, reasons: [ 29 ] });
    expect(offeredReasons(VISIT_DOMAINS, d, householdDetail()).find((r) => r.code === 5)!.disabled).toBe("não se aplica a pessoa do sexo masculino");
    expect(offeredReasons(VISIT_DOMAINS, { ...d, reasons: [] }, householdDetail()).find((r) => r.code === 5)!.disabled).toBeNull();
    expect(allowedMeasurements(VISIT_DOMAINS, inHousehold({ subject: "none", outcome: 1 }), household()).weight_kg).toBe(false);
  });

  it("poda: motivo e medida que deixaram de valer saem, com os rótulos do que saiu", () => {
    const d = inHousehold({ subject: "resident", person: maria, outcome: 1, reasons: [ 29, 11 ],
      measurements: { ...EMPTY_MEASURES, weight_kg: "70", systolic: "120", diastolic: "80" } });
    expect(pruneVisitDraft(VISIT_DOMAINS, d, householdDetail())).toEqual({ draft: d, cleared: [] });
    const refused = pruneVisitDraft(VISIT_DOMAINS, { ...d, outcome: 2 }, householdDetail());
    expect(refused.draft.reasons).toEqual([]);
    expect(refused.draft.measurements).toEqual(EMPTY_MEASURES);
    expect(refused.cleared).toEqual([ "Visita periódica", "Pessoa com hipertensão", "peso (kg)", "pressão sistólica", "pressão diastólica" ]);
    const none = pruneVisitDraft(VISIT_DOMAINS, { ...d, subject: "none", person: null }, householdDetail());
    expect(none.draft.reasons).toEqual([]);
    expect(none.draft.measurements.weight_kg).toBe("");
    expect(none.draft.measurements.systolic).toBe("120");
  });

  it("poda: imóvel não residencial limpa pessoa e família", () => {
    const d = draft({ place: { kind: "no_household", propertyType: "4", microAreaId: "ma1", outOfArea: false }, subject: "resident", person: maria,
      familyId: null, outcome: 1, reasons: [ 35, 11 ] });
    const out = pruneVisitDraft(VISIT_DOMAINS, d, null);
    expect(out.draft).toMatchObject({ subject: null, person: null, familyId: null, reasons: [ 35 ] });
    expect(out.cleared).toEqual([ "pessoa", "Pessoa com hipertensão" ]);
  });
});

describe("aviso da conversão em família (Q43/Q51)", () => {
  const resident = (o: Partial<VisitDraft> = {}) => inHousehold({ subject: "resident", person: { kind: "patient", patientId: "pa1", sex: "female" }, outcome: 1, reasons: [ 29 ], ...o });
  it("morador de família ativa deste domicílio: a visita vai para a família", () => {
    expect(familyVisitNotice(VISIT_DOMAINS, resident(), householdDetail())).toBe("A visita será registrada para a família, no nome do responsável");
  });
  it("sem família ativa: registrada ao imóvel (cadastro sem família, família que mudou, sem domicílio)", () => {
    const text = "Sem família ativa: a visita será registrada ao imóvel";
    expect(familyVisitNotice(VISIT_DOMAINS, resident(), householdDetail({ residents: [ { patient_id: "pa1", display_name: "M", sex: "female", family_id: null, unidentified: false } ] }))).toBe(text);
    expect(familyVisitNotice(VISIT_DOMAINS, resident(), householdDetail({ families: [ { ...household().families[0], moved_out: true } ] }))).toBe(text);
    expect(familyVisitNotice(VISIT_DOMAINS, draft({ place: { kind: "no_household", propertyType: "1", microAreaId: "ma1", outOfArea: false }, subject: "resident",
      person: { kind: "patient", patientId: "pa1", sex: "female" }, outcome: 1, reasons: [ 34 ] }), null)).toBe(text);
  });
  it("pessoa digitada: nunca é cadastrada e a frase diz isso", () => {
    const typed = resident({ person: { kind: "new", patient: { full_name: "Ana", birth_date: "1990-04-02", sex: "female" }, duplicatesReviewed: false } });
    expect(familyVisitNotice(VISIT_DOMAINS, typed, householdDetail())).toBe(
      "Sem família ativa: a visita será registrada ao imóvel. A pessoa digitada não será cadastrada");
  });
  it("sem aviso: outros motivos, outro sujeito, não residencial", () => {
    expect(familyVisitNotice(VISIT_DOMAINS, resident({ reasons: [ 11 ] }), householdDetail())).toBeNull();
    expect(familyVisitNotice(VISIT_DOMAINS, resident({ subject: "none", person: null }), householdDetail())).toBeNull();
    expect(familyVisitNotice(VISIT_DOMAINS, draft({ place: { kind: "no_household", propertyType: "2", microAreaId: "ma1", outOfArea: false }, subject: "resident",
      person: { kind: "patient", patientId: "pa1", sex: null }, outcome: 1, reasons: [ 34 ] }), null)).toBeNull();
  });
});

describe("visitBody", () => {
  it("com domicílio não manda imóvel nem microárea; opcional vazio não vai; turno nunca vai", () => {
    const body = visitBody(inHousehold({ subject: "family_responsible", familyId: "f1", outcome: 1, reasons: [ 29 ], shared: true,
      measurements: { ...EMPTY_MEASURES, systolic: "130", diastolic: "85" }, note: "  " }));
    expect(body).toEqual({ occurred_at: "2026-11-12T09:15:00-03:00", household_id: "h1", subject: "family_responsible", family_id: "f1",
      outcome: 1, reasons: [ 29 ], shared: true, measurements: { systolic: 130, diastolic: 85 } });
    expect(body).not.toHaveProperty("shift");
  });

  it("sem domicílio: imóvel e microárea; fora de área só como true; morador e pessoa digitada", () => {
    const placed = visitBody(draft({ place: { kind: "no_household", propertyType: "1", microAreaId: "ma1", outOfArea: false }, subject: "none", outcome: 3 }));
    expect(placed).toEqual({ occurred_at: "2026-11-12T09:15:00-03:00", property_type: "1", micro_area_id: "ma1", subject: "none", outcome: 3, reasons: [], shared: false });
    const out = visitBody(draft({ place: { kind: "no_household", propertyType: "1", microAreaId: null, outOfArea: true }, subject: "none", outcome: 3 }));
    expect(out).toMatchObject({ out_of_area: true, property_type: "1" });
    expect(out).not.toHaveProperty("micro_area_id");
    const typed = visitBody(inHousehold({ subject: "resident", outcome: 1, reasons: [ 11 ], note: " olá ",
      person: { kind: "new", patient: { full_name: "Ana", birth_date: "1990-04-02", sex: "female", mother_name: "", cpf: null }, duplicatesReviewed: true },
      measurements: { ...EMPTY_MEASURES, glucose_mg_dl: "110,0", glucose_type: "0" } }));
    expect(typed).toMatchObject({ new_patient: { full_name: "Ana", birth_date: "1990-04-02", sex: "female" }, duplicates_reviewed: true, note: "olá",
      measurements: { glucose_mg_dl: 110, glucose_type: 0 } });
    expect(typed.new_patient).not.toHaveProperty("mother_name");
    expect(typed.new_patient).not.toHaveProperty("cpf");
    expect(typed).not.toHaveProperty("patient_id");
    const existing = visitBody(inHousehold({ subject: "resident", person: { kind: "patient", patientId: "pa1", sex: null }, outcome: 3 }));
    expect(existing).toMatchObject({ patient_id: "pa1" });
    expect(existing).not.toHaveProperty("duplicates_reviewed");
  });
});

describe("textProblem", () => {
  it("conta code points depois do trim", () => {
    expect(textProblem("  ab  ", { min: 3, max: 10, path: "reason" })).toEqual({ path: "reason", text: "escreva de 3 a 10 caracteres" });
    expect(textProblem("abc", { min: 3, max: 10, path: "reason" })).toBeNull();
    expect(textProblem("😀😀😀", { min: 3, max: 3, path: "reason" })).toBeNull();
    expect(textProblem("😀😀😀😀", { min: 3, max: 3, path: "reason" })).not.toBeNull();
  });
});
