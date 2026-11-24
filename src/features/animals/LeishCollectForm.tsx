// "Coletar sangue (LV)" (35b; contract §6, §11, Q20, Q21, Q24): the dashboard's collection form (apps/dashboard
// src/modules/zoonoses/TestsPanel.tsx CollectForm, main 51b1871) offline, for the endemic agent only (canCollectLeish):
// the dog opened, today in the city's clock (the collection's day and the TR-DPP's, Q20). The surveys are the ones the
// tablet has that list this household (openSurveysFor, Q21), and "Avulsa" (no leish_survey_id). What comes chosen
// (coordinator's ruling, fix round of Task 8): the only survey when one lists the household — one missed tap would send an
// avulsa collection that can never be relinked; "Avulsa" when none does (a household born on the tablet has no server id,
// so it has none); nothing when two or more do, and the form waits for a choice (AGENT_CHOOSE_SURVEY). The TR-DPP is optional,
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
import { AGENT_CHOOSE_SURVEY } from "../messages/errorPhrases";
import { canCollectLeish, cityTodayOf, loadSession } from "../session";
import { COLLECT_LEISH } from "./AnimalSection";
import { collectLeish } from "./save";
import { ANIMAL_NOT_FOUND, readCareTarget, ruleRowOf, useRefusals, type CareTarget } from "./VaccinateForm";

export const AVULSA = "Avulsa";
// The choice of no survey; never a survey's id (those are uuids).
const NO_SURVEY = "avulsa";

// The only survey listing the household; "Avulsa" when none does; nothing when two or more do.
const initialSurvey = (surveys: LeishSurveyBody[]): string | null =>
  (surveys.length === 0 ? NO_SURVEY : surveys.length === 1 ? surveys[0].id : null);

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
  // A survey's id, NO_SURVEY ("Avulsa"), or null: nothing chosen yet.
  const [surveyId, setSurveyId] = useState<string | null>(null);
  const [dpp, setDpp] = useState<DppResult | null>(null);
  const [problems, setProblems] = useState<ZooProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const at = useRefusals(problems);

  useEffect(() => {
    let alive = true;
    void readCollectTarget(db, animalKey).then((value) => {
      if (!alive) return;
      setLoaded(value);
      if (value !== "missing") setSurveyId(initialSurvey(value.surveys));
    });
    return () => { alive = false; };
  }, [animalKey, db]);

  const save = useCallback(async () => {
    if (loaded === null || loaded === "missing" || busy) return;
    const chosen = surveyId === NO_SURVEY ? null : surveyId;
    const found: ZooProblem[] = [
      ...collectionProblems(ruleRowOf(loaded.view), chosen, loaded.surveys),
      ...(surveyId === null ? [{ code: null, path: "leish_survey_id", text: AGENT_CHOOSE_SURVEY }] : []),
    ];
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
        // Touching the chosen one again: back to nothing with two or more surveys, to "Avulsa" otherwise.
        <Choice label="Inquérito" options={surveys} value={surveyId}
          onChange={(next) => {
            setSurveyId(next ?? (loaded.surveys.length >= 2 ? null : NO_SURVEY));
            setProblems((p) => p.filter((x) => x.path !== "leish_survey_id"));
          }} />
      ))}
      {at("dpp_result", (
        <Choice<DppResult> label="Resultado do TR-DPP" options={loaded.domains.dpp_results} value={dpp} onChange={setDpp} />
      ))}
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : COLLECT_LEISH} disabled={busy} onPress={() => { void save(); }} />
    </Screen>
  );
}
