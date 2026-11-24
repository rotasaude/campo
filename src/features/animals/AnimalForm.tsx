// "Cadastrar animal" and "Editar animal" from the household (35b; contract §11, Q20, Q22, Q24): the dashboard's
// AnimalForm (apps/dashboard src/modules/zoonoses/AnimalForm.tsx, main 51b1871) with its labels, offline.
// - The tutor is one of the residents the tablet has in the household (a resident registered here too, N1/Q29), or
//   nobody ("tutor não identificado", Q22); "Animal comunitário" takes the tutor off.
// - The microchip is typed on creation only; after that the form says only that there is one (§16). The species does
//   not change on an edit, as on the dashboard.
// - The situation only on an edit of an animal the server has, never back to "Ativo" (Q20).
// animalProblems (Task 5) in the dashboard's words; each refusal under its field (`field-<path>`), brought into sight.
// The edit opens on the animal with the line on top and keeps the base it opened with (Q41).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { animalProblems, emptyAnimalDraft, type AnimalDraft, type ZooProblem } from "../../rules/animal";
import type { AnimalStatus, ZoonosesDomains } from "../../rules/zoonosesDomains";
import { ZOONOSES_ERRORS } from "../../rules/zoonosesErrors";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, FieldRefusal, Muted, Notice, Screen } from "../../ui/components";
import { Check, Choice, type Option } from "../../ui/choices";
import { NOT_FOUND } from "../households/HouseholdScreen";
import { canUseZoonoses, cityTodayOf, loadSession } from "../session";
import { HAS_MICROCHIP, NEW_ANIMAL } from "./AnimalSection";
import { saveAnimal } from "./save";
import { readAnimal, type AnimalEditView } from "./view";

export const EDIT_ANIMAL = "Editar animal";
export const COMMUNITY_LABEL = "Animal comunitário";
// The dashboard's line for neither tutor nor community (Q22).
export const UNKNOWN_TUTOR = "Sem tutor e sem comunitário: tutor não identificado.";

interface Loaded {
  allowed: boolean; domains: ZoonosesDomains | null; householdKey: string; view: AnimalEditView | null; residents: Option<string>[]; today: string;
}

async function read(db: Db, householdKey: string | undefined, animalKey: string | undefined, now: number): Promise<Loaded | "missing"> {
  const view = animalKey === undefined ? null : await readAnimal(db, animalKey);
  if (animalKey !== undefined && view === null) return "missing";
  const key = view?.householdKey ?? householdKey;
  if (key === undefined || !(await db.get("SELECT key FROM households WHERE key = ?", [key]))) return "missing";
  const reference = await loadReference(db).catch(() => null);
  const residents = (await territoryRepo.residentsOf(db, key)).filter(({ registration }) => registration.exit == null)
    .map(({ registration }) => ({ code: registration.patient.id, label: registration.patient.display_name }));
  // The tutor it has stays on the list, also when the tablet no longer has him in the household.
  const tutor = view?.body.tutor ?? null;
  if (tutor !== null && !residents.some((resident) => resident.code === tutor.patient_id)) residents.push({ code: tutor.patient_id, label: tutor.display_name });
  return {
    allowed: canUseZoonoses(await loadSession(db), reference), domains: reference?.zoonosesDomains ?? null, householdKey: key, view, residents,
    today: await cityTodayOf(db, now),
  };
}

const draftOf = (view: AnimalEditView | null): AnimalDraft => {
  if (view === null) return emptyAnimalDraft();
  const b = view.body;
  return {
    species: b.species, sex: b.sex, size: b.size ?? "", name: b.name ?? "", coat: b.coat ?? "", breed: b.breed ?? "",
    birthEstimateMonth: b.birth_estimate_on?.slice(0, 7) ?? "", microchip: "", tutorKey: b.community ? null : b.tutor?.patient_id ?? null, community: b.community,
  };
};

export function AnimalForm({ householdKey, animalKey, onSaved }: { householdKey?: string; animalKey?: string; onSaved(): void }) {
  const { db, crypto, now } = useServices();
  const { colors } = useTheme();
  const [loaded, setLoaded] = useState<Loaded | "missing" | null>(null);
  const [draft, setDraft] = useState<AnimalDraft>(emptyAnimalDraft);
  const [status, setStatus] = useState<AnimalStatus | null>(null);
  const [problems, setProblems] = useState<ZooProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Read once: a sync in the middle of the typing must not change what the person sees, nor the base of the edit.
  useEffect(() => {
    let alive = true;
    void read(db, householdKey, animalKey, now()).then((value) => {
      if (!alive) return;
      setLoaded(value);
      if (value !== "missing") { setDraft(draftOf(value.view)); setStatus(value.view?.body.status ?? null); }
    });
    return () => { alive = false; };
  }, [db, householdKey, animalKey, now]);

  const set = (patch: Partial<AnimalDraft>, paths: string[]) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblems((p) => p.filter((x) => !paths.includes(x.path)));
  };

  const save = useCallback(async () => {
    if (loaded === null || loaded === "missing" || loaded.domains === null || busy) return;
    const edit = loaded.view !== null;
    const typed = edit ? { ...draft, microchip: "" } : draft;
    const found = animalProblems(typed, loaded.domains.limits, loaded.today);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await saveAnimal(db, {
        householdKey: loaded.householdKey, draft: typed, animalKey, newUuid: crypto.randomUUID,
        ...(edit && !loaded.view!.creating && status !== null ? { status } : {}), today: loaded.today, editBase: loaded.view?.base ?? null,
      });
      // The number typed leaves the screen with it.
      setDraft((d) => ({ ...d, microchip: "" }));
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [animalKey, busy, crypto.randomUUID, db, draft, loaded, onSaved, status]);

  const title = animalKey === undefined ? NEW_ANIMAL : EDIT_ANIMAL;
  if (loaded === null) return <Screen title={title}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "missing") return <Screen title={title}><Notice tone="warn">{NOT_FOUND}</Notice></Screen>;
  if (!loaded.allowed || loaded.domains === null) return <Screen title={title}><Notice>{ZOONOSES_ERRORS.cbo_not_allowed}</Notice></Screen>;

  const { domains, view } = loaded;
  const edit = view !== null;
  const refusals = (path: string): ReactNode => problems.map((problem, index) => (problem.path !== path ? null : index === problems.findIndex((p) => p.path === path)
    ? <FieldRefusal key={index} problem={{ message: problem.text }} />
    : <Text key={index} accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.text}</Text>));
  const at = (path: string, children: ReactNode) => <View testID={`field-${path}`} style={{ gap: 6 }}>{children}{refusals(path)}</View>;
  const speciesLabel = domains.species.find((entry) => entry.code === draft.species)?.label ?? draft.species;
  // Never back to "Ativo": it is offered only while it is the animal's situation.
  const current = view?.body.status ?? "active";
  const statuses = domains.animal_statuses.filter((entry) => entry.code !== "active" || current === "active");

  return (
    <Screen title={title}>
      {at("species", edit
        ? <Body>{`Espécie: ${speciesLabel}`}</Body>
        : <Choice label="Espécie" options={domains.species as Option<string>[]} value={draft.species || null} onChange={(next) => set({ species: next ?? "" }, ["species"])} />)}
      {at("name", <Field label="Nome" value={draft.name} onChangeText={(text) => set({ name: text }, ["name"])} />)}
      {at("sex", <Choice label="Sexo" options={domains.sexes as Option<string>[]} value={draft.sex || null} onChange={(next) => set({ sex: next ?? "" }, ["sex"])} />)}
      {at("size", <Choice label="Porte" options={domains.sizes as Option<string>[]} value={draft.size || null} onChange={(next) => set({ size: next ?? "" }, ["size"])} />)}
      {at("coat", <Field label="Pelagem" value={draft.coat} onChangeText={(text) => set({ coat: text }, ["coat"])} />)}
      {at("breed", <Field label="Raça" value={draft.breed} onChangeText={(text) => set({ breed: text }, ["breed"])} />)}
      {at("birth_estimate_month", (
        <Field label="Mês de nascimento (estimado)" placeholder="AAAA-MM" value={draft.birthEstimateMonth} maxLength={7} keyboardType="numbers-and-punctuation"
          onChangeText={(text) => set({ birthEstimateMonth: text }, ["birth_estimate_month"])} />
      ))}
      {edit
        ? view.body.has_microchip && <Body>{HAS_MICROCHIP}</Body>
        : at("microchip", (
          <Field label={`Microchip (${domains.limits.microchip_digits} dígitos)`} value={draft.microchip} maxLength={domains.limits.microchip_digits}
            keyboardType="number-pad" autoCorrect={false} autoComplete="off" onChangeText={(text) => set({ microchip: text }, ["microchip"])} />
        ))}
      {at("tutor_patient_id", (
        <Choice label="Tutor" options={loaded.residents} value={draft.tutorKey}
          onChange={(next) => set({ tutorKey: next, ...(next !== null ? { community: false } : {}) }, ["tutor_patient_id", "community"])} />
      ))}
      {at("community", (
        <Check label={COMMUNITY_LABEL} value={draft.community}
          onChange={(next) => set({ community: next, ...(next ? { tutorKey: null } : {}) }, ["tutor_patient_id", "community"])} />
      ))}
      {draft.tutorKey === null && !draft.community && <Muted>{UNKNOWN_TUTOR}</Muted>}
      {edit && !view.creating && at("status", (
        <Choice label="Situação" options={statuses} value={status} onChange={(next) => { setStatus(next ?? current); setProblems((p) => p.filter((x) => x.path !== "status")); }} />
      ))}
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : edit ? "Salvar alterações" : NEW_ANIMAL} disabled={busy} onPress={() => { void save(); }} />
    </Screen>
  );
}
