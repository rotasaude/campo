// Ported from apps/dashboard/src/lib/vectorErrors.test.ts (dashboard commit dc6c0e0), the cases unchanged; the last
// test is the app's (Q9).
import { VECTOR_CONTROL_DISABLED, VECTOR_ERRORS, VECTOR_ERROR_CODES } from "./vectorErrors";

describe("vectorErrors", () => {
  it("cada código do contrato tem uma frase, e só uma por código", () => {
    expect(Object.keys(VECTOR_ERRORS).sort()).toEqual([ ...VECTOR_ERROR_CODES ].sort());
    const phrases = Object.values(VECTOR_ERRORS);
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const p of phrases) expect(p.length).toBeGreaterThan(10);
  });

  it("frases que o campo copia, sem dado de pessoa nem código cru", () => {
    expect(VECTOR_ERRORS.reason_derived).toBe("os motivos de controle vetorial (34 a 37) saem do boletim — desmarque-os");
    expect(VECTOR_ERRORS.feature_disabled).toBe(VECTOR_CONTROL_DISABLED);
    expect(VECTOR_ERRORS.sample_label_taken).toBe("esta etiqueta já foi usada — gere etiquetas novas para este boletim");
    expect(VECTOR_ERRORS.invalid_transition).toBe("a situação mudou enquanto a tela estava aberta — os dados foram relidos");
    for (const p of Object.values(VECTOR_ERRORS)) expect(p).not.toMatch(/_/);
  });

  it("os 38 códigos da brief, o proposal_changed (Q26(4)), os dois do PUT dos parâmetros (Q34) e os dois do PUT das cadências (Q35) e os dois da correção com versão (Q36)", () => {
    expect(VECTOR_ERROR_CODES).toHaveLength(46);
    expect(VECTOR_ERRORS.reading_changed).toBe("outra pessoa corrigiu esta contagem; confira e salve de novo");
    expect(VECTOR_ERRORS.sample_changed).toBe("outra pessoa corrigiu este resultado; confira e salve de novo");
    expect(VECTOR_ERRORS.cadences_changed).toBe("outra pessoa alterou as cadências; confira e salve de novo");
    expect(VECTOR_ERRORS.expected_digest_required).toBe("a lista de cadências está desatualizada — recarregue a página e tente de novo");
    expect(VECTOR_ERRORS.parameters_changed).toBe("outra pessoa alterou os parâmetros; confira e salve de novo");
    expect(VECTOR_ERRORS.expected_version_required).toBe("a tela está desatualizada — recarregue a página e tente de novo");
    expect(VECTOR_ERRORS.proposal_changed).toBe("a proposta ganhou caso novo enquanto a tela estava aberta — os dados foram relidos");
  });
});

test("sample_label_taken and invalid_transition have the Q9 phrases; status_changed is gone", () => {
  expect(VECTOR_ERRORS.sample_label_taken).toBe("esta etiqueta já foi usada — gere etiquetas novas para este boletim");
  expect(VECTOR_ERRORS.invalid_transition).toBe("a situação mudou enquanto a tela estava aberta — os dados foram relidos");
  expect(VECTOR_ERROR_CODES).not.toContain("status_changed");
  expect(Object.keys(VECTOR_ERRORS)).not.toContain("status_changed");
});
