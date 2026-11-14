// The family form. A new family: who heads it (one of the residents of the
// household), the income, how many people and since when they live there.
// An existing one: the same, without the responsible (changing it is done at
// the dashboard) and with "moved out", which is final. The labels and the
// sentences are the dashboard's (modules/territory/FamilyForm.tsx).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import { createRegistryRules, type Problem } from "../../rules/registry";
import { loadReference, type Reference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Choice, YesNo } from "../../ui/choices";
import { Body, Button, Field, Muted, Notice, Screen } from "../../ui/components";
import { monthFromScreen, monthToScreen } from "../forms/SectionFields";
import { NOT_READY, READ_ONLY } from "../households/HouseholdForm";
import { readHousehold, type HouseholdView } from "../households/view";
import { canEditRegistry, cityTodayOf, loadSession } from "../session";
import { FamilyInConflictError, responsibleOptions, saveFamily, type ResponsibleOption } from "./save";

export const NO_RESIDENTS = "nenhum morador com cadastro disponível — cadastre o responsável antes";
export const MOVED_OUT_WARNING = "a mudança é definitiva: a família sai do domicílio e não volta nem muda mais";
export const FAMILY_NOT_FOUND = "Família não encontrada neste domicílio.";

interface Loaded { reference: Reference; view: HouseholdView; residents: ResponsibleOption[]; today: string }
interface Draft { responsibleKey: string | null; income: string | null; members: string; since: string; movedOut: boolean }

export function FamilyForm({ householdKey, familyId, onSaved }: { householdKey: string; familyId?: string; onSaved(): void }) {
  const { colors } = useTheme();
  const { db, crypto, now } = useServices();
  const [loaded, setLoaded] = useState<Loaded | "read_only" | "not_ready" | "missing" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Read once: a sync in the middle of the typing must not rewrite what the person sees.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!canEditRegistry(await loadSession(db))) { if (alive) setLoaded("read_only"); return; }
      const reference = await loadReference(db).catch(() => null);
      if (reference === null) { if (alive) setLoaded("not_ready"); return; }
      const view = await readHousehold(db, householdKey);
      const family = familyId === undefined ? null : view?.body.families.find((f) => f.id === familyId) ?? null;
      if (view === null || (familyId !== undefined && family === null)) { if (alive) setLoaded("missing"); return; }
      const residents = await responsibleOptions(db, householdKey);
      const today = await cityTodayOf(db, now());
      if (!alive) return;
      setLoaded({ reference, view, residents, today });
      setDraft({
        // Never chosen for the person, even with a single resident: who heads a family is said, not assumed.
        responsibleKey: null, income: family?.income_band ?? null,
        members: family ? String(family.members_count) : "", since: monthToScreen(family?.living_since?.slice(0, 7) ?? ""), movedOut: family?.moved_out ?? false,
      });
    })();
    return () => { alive = false; };
  }, [db, familyId, householdKey, now]);

  const reference = loaded !== null && typeof loaded === "object" ? loaded.reference : null;
  const rules = useMemo(() => (reference === null ? null : createRegistryRules(reference.dictionaries)), [reference]);
  const title = familyId === undefined ? "Nova família" : "Editar família";

  if (loaded === null) return <Screen title={title}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "read_only") return <Screen title={title}><Notice>{READ_ONLY}</Notice></Screen>;
  if (loaded === "missing") return <Screen title={title}><Notice tone="warn">{FAMILY_NOT_FOUND}</Notice></Screen>;
  if (loaded === "not_ready" || draft === null || rules === null || reference === null) return <Screen title={title}><Notice tone="warn">{NOT_READY}</Notice></Screen>;

  const isNew = familyId === undefined;
  const propertyType = loaded.view.body.property_type;
  const current = isNew ? null : loaded.view.body.families.find((f) => f.id === familyId) ?? null;
  // The household must be one that takes families at all, before anything is asked.
  const household = isNew ? rules.familyRulesProblem({}, propertyType, loaded.today) : null;
  if (household !== null) return <Screen title={title}><Notice tone="warn">{household.message}</Notice></Screen>;
  if (isNew && loaded.residents.length === 0) return <Screen title={title}><Notice tone="warn">{NO_RESIDENTS}</Notice></Screen>;

  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setProblem(null); };
  const incomes = (reference.dictionaries.domains.renda_familiar ?? []).map((entry) => ({ code: String(entry.code), label: entry.label }));

  const save = async () => {
    const members = draft.members.trim() === "" ? null : Number(draft.members.replace(/\D/g, "") || "NaN");
    const fields = { income_band: draft.income, members_count: members, living_since: draft.since.trim() === "" ? null : monthFromScreen(draft.since), moved_out: draft.movedOut };
    const found = rules.familyProblem(
      { ...fields, responsible: draft.responsibleKey === null ? null : { patient_id: draft.responsibleKey } }, { propertyType, today: loaded.today, isNew });
    if (found) { setProblem(found); return; }
    setSaving(true);
    try {
      if (isNew) await saveFamily(db, { householdKey, responsibleKey: draft.responsibleKey as string, fields: { ...fields, moved_out: undefined } }, { newUuid: crypto.randomUUID, now });
      else await saveFamily(db, { householdKey, familyId, fields }, { newUuid: crypto.randomUUID, now });
      onSaved();
    } catch (err) {
      setNotice(err instanceof FamilyInConflictError || err instanceof Error ? err.message : "Não foi possível salvar. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const at = (key: string, path: string, children: ReactNode) => (
    <View testID={`field-${key}`} style={{ gap: 6 }}>
      {children}
      {problem?.path === path && <Text accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.message}</Text>}
    </View>
  );
  const fieldPaths = ["responsible.patient_id", "income_band", "members_count", "living_since", "moved_out"];
  const general = problem !== null && !fieldPaths.includes(problem.path) ? problem.message : null;

  return (
    <Screen title={title}>
      {isNew
        ? at("responsible", "responsible.patient_id",
          <Choice label="Responsável" options={loaded.residents.map((r) => ({ code: r.registrationKey, label: r.name }))} value={draft.responsibleKey}
            onChange={(next) => set({ responsibleKey: next })} />)
        : <Body>{`Responsável: ${current?.responsible.display_name ?? ""}`}</Body>}
      {at("income_band", "income_band", <Choice label="Renda familiar" options={incomes} value={draft.income} onChange={(next) => set({ income: next })} />)}
      {at("members_count", "members_count",
        <Field label="Número de membros" value={draft.members} keyboardType="number-pad" onChangeText={(members) => set({ members })} />)}
      {at("living_since", "living_since",
        <Field label="Reside desde (mm/aaaa)" value={draft.since} keyboardType="number-pad" onChangeText={(since) => set({ since })} />)}
      {!isNew && at("moved_out", "moved_out", <YesNo label="Mudou-se" value={draft.movedOut} onChange={(next) => set({ movedOut: next === true })} />)}
      {!isNew && draft.movedOut && <Notice tone="warn">{MOVED_OUT_WARNING}</Notice>}
      {notice !== null && <Notice tone="warn">{notice}</Notice>}
      {general !== null && <Notice tone="down">{general}</Notice>}
      <Button label={saving ? "Salvando…" : "Salvar família"} disabled={saving} onPress={() => { void save(); }} />
    </Screen>
  );
}
