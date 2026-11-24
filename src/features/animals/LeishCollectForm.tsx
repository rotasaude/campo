// "Coletar sangue (LV)" (35b; contract §6, §11, Q20, Q21, Q24): the dashboard's collection form (apps/dashboard
// src/modules/zoonoses/TestsPanel.tsx CollectForm, main 51b1871) offline, for the endemic agent only (canCollectLeish):
// the dog opened, today in the city's clock (the collection's day and the TR-DPP's, Q20). The surveys are the ones the
// tablet has that list this household (openSurveysFor, Q21), and "Avulsa" (no leish_survey_id), which comes chosen as the
// dashboard's "sem inquérito"; a household born on the tablet has no server id, so only "Avulsa". The TR-DPP is optional,
// with the reference's labels. The label is the api's, after acceptance: this form never shows or makes one.
// collectionProblems (Task 5) in the dashboard's words, each under its field (`field-<path>`).
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/services";
import type { LeishSurveyBody } from "../../contract";
import { zoonosesRepo } from "../../db/repos/zoonosesRepo";
import type { Db } from "../../db/types";
import { collectionProblems, type ZooProblem } from "../../rules/animal";
import type { DppResult } from "../../rules/zoonosesDomains";
import { ZOONOSES_ERRORS } from "../../rules/zoonosesErrors";
import { loadReference } from "../../sync/reference";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";
import { Choice, type Option } from "../../ui/choices";
import { canCollectLeish, cityTodayOf, loadSession } from "../session";
import { COLLECT_LEISH } from "./AnimalSection";
import { collectLeish } from "./save";
import { ANIMAL_NOT_FOUND, readCareTarget, ruleRowOf, useRefusals, type CareTarget } from "./VaccinateForm";

export const AVULSA = "Avulsa";
// The choice of no survey; never a survey's id (those are uuids).
const NO_SURVEY = "avulsa";

interface Loaded extends CareTarget { collects: boolean; surveys: LeishSurveyBody[] }

async function readCollectTarget(db: Db, animalKey: string): Promise<Loaded | "missing"> {
  const target = await readCareTarget(db, animalKey);
  if (target === "missing") return "missing";
  const household = await db.get<{ id: string | null }>("SELECT id FROM households WHERE key = ?", [target.view.householdKey]);
  return {
    ...target, collects: canCollectLeish(await loadSession(db), await loadReference(db).catch(() => null)),
    surveys: await zoonosesRepo.openSurveysFor(db, household?.id ?? null),
  };
}

export function LeishCollectForm({ animalKey, onSaved }: { animalKey: string; onSaved(): void }) {
  const { db, crypto, now } = useServices();
  const [loaded, setLoaded] = useState<Loaded | "missing" | null>(null);
  const [surveyId, setSurveyId] = useState(NO_SURVEY);
  const [dpp, setDpp] = useState<DppResult | null>(null);
  const [problems, setProblems] = useState<ZooProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const at = useRefusals(problems);

  useEffect(() => {
    let alive = true;
    void readCollectTarget(db, animalKey).then((value) => { if (alive) setLoaded(value); });
    return () => { alive = false; };
  }, [animalKey, db]);

  const save = useCallback(async () => {
    if (loaded === null || loaded === "missing" || busy) return;
    const chosen = surveyId === NO_SURVEY ? null : surveyId;
    const found = collectionProblems(ruleRowOf(loaded.view), chosen, loaded.surveys);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await collectLeish(db, { animalKey, surveyId: chosen, dppResult: dpp, today: await cityTodayOf(db, now()), newUuid: crypto.randomUUID });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [animalKey, busy, crypto.randomUUID, db, dpp, loaded, now, onSaved, surveyId]);

  if (loaded === null) return <Screen title={COLLECT_LEISH}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "missing") return <Screen title={COLLECT_LEISH}><Notice tone="warn">{ANIMAL_NOT_FOUND}</Notice></Screen>;
  if (!loaded.collects || loaded.domains === null) return <Screen title={COLLECT_LEISH}><Notice>{ZOONOSES_ERRORS.cbo_not_allowed}</Notice></Screen>;

  const surveys: Option<string>[] = [{ code: NO_SURVEY, label: AVULSA }, ...loaded.surveys.map((survey) => ({ code: survey.id, label: survey.name }))];
  return (
    <Screen title={COLLECT_LEISH}>
      {at("animal_id", <Body>{loaded.title}</Body>)}
      {at("leish_survey_id", (
        // Touching the chosen survey again goes back to "Avulsa": one of them is always chosen.
        <Choice label="Inquérito" options={surveys} value={surveyId}
          onChange={(next) => { setSurveyId(next ?? NO_SURVEY); setProblems((p) => p.filter((x) => x.path !== "leish_survey_id")); }} />
      ))}
      {at("dpp_result", (
        <Choice<DppResult> label="Resultado do TR-DPP" options={loaded.domains.dpp_results} value={dpp} onChange={setDpp} />
      ))}
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : COLLECT_LEISH} disabled={busy} onPress={() => { void save(); }} />
    </Screen>
  );
}
