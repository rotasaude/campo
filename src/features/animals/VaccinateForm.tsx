// "Vacinar" (35b; contract §3, §11, Q19, Q20, Q24): the dashboard's VaccinationForm (apps/dashboard
// src/modules/zoonoses/VaccinationForm.tsx, main 51b1871) with its labels, offline and at home only: the animal is the one
// opened, the campaign is the reference's open one, the day is today in the city's clock. No modality (it is always
// house) and no check of a dose already given in the campaign: the api bars the second one (Q19). The products are the
// reference's of use rabies_vaccine; with only one, it comes chosen. With "Evento adverso" on, the contract's EATAV
// reminder and the note. A shortage of stock never shows here: the item comes back accepted (§11).
// vaccinationProblems (Task 5) and productProblems in the dashboard's words, each under its field (`field-<path>`).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import type { AnimalRow } from "../../db/repos/zoonosesRepo";
import type { Db } from "../../db/types";
import { fmtDay } from "../../rules/homeVisit";
import { productProblems, vaccinationProblems, type ZooProblem } from "../../rules/animal";
import type { ZoonosesDomains, ZoonosesProductUse } from "../../rules/zoonosesDomains";
import { ZOONOSES_ERRORS } from "../../rules/zoonosesErrors";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, FieldRefusal, Muted, Notice, Screen } from "../../ui/components";
import { Check, Choice, type Option } from "../../ui/choices";
import { canUseZoonoses, cityTodayOf, loadSession } from "../session";
import { VACCINATE } from "./AnimalSection";
import { vaccinate } from "./save";
import { readAnimal, type AnimalEditView } from "./view";

export const EATAV_REMINDER = "Notifique o evento adverso no formulário do Ministério da Saúde (EATAV).";
export const ANIMAL_NOT_FOUND = ZOONOSES_ERRORS.not_found;

export interface CareTarget { allowed: boolean; domains: ZoonosesDomains | null; view: AnimalEditView; title: string }

// The animal as the line leaves it (readAnimal), for the vaccine and the collar forms. Read once: a sync in the middle
// must not change what the person sees.
export async function readCareTarget(db: Db, animalKey: string): Promise<CareTarget | "missing"> {
  const view = await readAnimal(db, animalKey);
  if (view === null) return "missing";
  const reference = await loadReference(db).catch(() => null);
  const domains = reference?.zoonosesDomains ?? null;
  const species = domains?.species.find((entry) => entry.code === view.body.species)?.label ?? view.body.species;
  return {
    allowed: canUseZoonoses(await loadSession(db), reference), domains, view,
    title: [species, view.body.name].filter((part) => part !== null && part !== "").join(" · "),
  };
}

// What the rules of the screen read of the animal.
export const ruleRowOf = (view: AnimalEditView): AnimalRow => ({
  key: view.key, id: view.id, client_uuid: view.id === null ? view.key : null, household_key: view.householdKey,
  species: view.body.species, status: view.body.status, version: view.base?.version ?? null, body: view.body,
});

export const productOptions = (domains: ZoonosesDomains, use: ZoonosesProductUse): Option<string>[] =>
  domains.products.filter((product) => product.use === use).map((product) => ({ code: product.id, label: product.name }));

// Each refusal under its field, the first one brought into sight (as AnimalForm).
export function useRefusals(problems: ZooProblem[]) {
  const { colors } = useTheme();
  const refusals = (path: string): ReactNode => problems.map((problem, index) => (problem.path !== path ? null : index === problems.findIndex((p) => p.path === path)
    ? <FieldRefusal key={index} problem={{ message: problem.text }} />
    : <Text key={index} accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.text}</Text>));
  function at(path: string, children: ReactNode): ReactNode {
    return <View testID={`field-${path}`} style={{ gap: 6 }}>{children}{refusals(path)}</View>;
  }
  return at;
}

export function VaccinateForm({ animalKey, onSaved }: { animalKey: string; onSaved(): void }) {
  const { db, crypto, now } = useServices();
  const [loaded, setLoaded] = useState<CareTarget | "missing" | null>(null);
  const [productId, setProductId] = useState("");
  const [adverseEvent, setAdverseEvent] = useState(false);
  const [adverseNote, setAdverseNote] = useState("");
  const [problems, setProblems] = useState<ZooProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const at = useRefusals(problems);

  useEffect(() => {
    let alive = true;
    void readCareTarget(db, animalKey).then((value) => {
      if (!alive) return;
      setLoaded(value);
      const products = value === "missing" || value.domains === null ? [] : productOptions(value.domains, "rabies_vaccine");
      if (products.length === 1) setProductId(products[0].code);
    });
    return () => { alive = false; };
  }, [animalKey, db]);

  const clear = (...paths: string[]) => setProblems((p) => p.filter((x) => !paths.includes(x.path)));

  const save = useCallback(async () => {
    if (loaded === null || loaded === "missing" || loaded.domains === null || busy) return;
    const note = adverseEvent ? adverseNote : null;
    const found = [
      ...vaccinationProblems(ruleRowOf(loaded.view), loaded.domains, { adverseEvent, adverseNote: note }),
      ...productProblems(productId, "rabies_vaccine"),
    ];
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await vaccinate(db, { animalKey, productId, adverseEvent, adverseNote: note, today: await cityTodayOf(db, now()), newUuid: crypto.randomUUID });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [adverseEvent, adverseNote, animalKey, busy, crypto.randomUUID, db, loaded, now, onSaved, productId]);

  if (loaded === null) return <Screen title={VACCINATE}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "missing") return <Screen title={VACCINATE}><Notice tone="warn">{ANIMAL_NOT_FOUND}</Notice></Screen>;
  if (!loaded.allowed || loaded.domains === null) return <Screen title={VACCINATE}><Notice>{ZOONOSES_ERRORS.cbo_not_allowed}</Notice></Screen>;

  const { domains, view } = loaded;
  const campaign = domains.open_campaign;
  const last = view.body.last_rabies_vaccination_on;
  return (
    <Screen title={VACCINATE}>
      {at("animal_id", <Body>{loaded.title}</Body>)}
      {last !== null && <Muted>{`Última vacina antirrábica: ${fmtDay(last)}`}</Muted>}
      {at("campaign_id", campaign !== null && <Body>{`Campanha: ${campaign.name}`}</Body>)}
      {at("vector_product_id", (
        <Choice label="Produto" options={productOptions(domains, "rabies_vaccine")} value={productId || null}
          onChange={(next) => { setProductId(next ?? ""); clear("vector_product_id"); }} />
      ))}
      <Check label="Evento adverso" value={adverseEvent} onChange={(next) => { setAdverseEvent(next); clear("adverse_note"); }} />
      {adverseEvent && (
        <>
          <Muted>{EATAV_REMINDER}</Muted>
          {at("adverse_note", (
            <Field label="Nota do evento adverso" value={adverseNote} multiline maxLength={domains.limits.adverse_note_max}
              onChangeText={(text) => { setAdverseNote(text); clear("adverse_note"); }} />
          ))}
        </>
      )}
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : VACCINATE} disabled={busy} onPress={() => { void save(); }} />
    </Screen>
  );
}
