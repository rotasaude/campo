// "Colocar coleira" (35b; contract §11, Q20, Q24): the dashboard's collar form (apps/dashboard
// src/modules/zoonoses/CollarsPanel.tsx, main 51b1871) with its labels, offline: the dog opened, today in the city's
// clock, a product of use collar (with only one, it comes chosen). The due date is the api's (placed_on + collar_months);
// the card shows it from the line until the download. A shortage of stock never shows here (§11).
// collarProblems (Task 5) and productProblems in the dashboard's words, each under its field.
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/services";
import { collarProblems, productProblems, type ZooProblem } from "../../rules/animal";
import { ZOONOSES_ERRORS } from "../../rules/zoonosesErrors";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";
import { Choice } from "../../ui/choices";
import { cityTodayOf } from "../session";
import { PLACE_COLLAR } from "./AnimalSection";
import { placeCollar } from "./save";
import { ANIMAL_NOT_FOUND, productOptions, readCareTarget, ruleRowOf, useRefusals, type CareTarget } from "./VaccinateForm";

export function CollarForm({ animalKey, onSaved }: { animalKey: string; onSaved(): void }) {
  const { db, crypto, now } = useServices();
  const [loaded, setLoaded] = useState<CareTarget | "missing" | null>(null);
  const [productId, setProductId] = useState("");
  const [problems, setProblems] = useState<ZooProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const at = useRefusals(problems);

  useEffect(() => {
    let alive = true;
    void readCareTarget(db, animalKey).then((value) => {
      if (!alive) return;
      setLoaded(value);
      const products = value === "missing" || value.domains === null ? [] : productOptions(value.domains, "collar");
      if (products.length === 1) setProductId(products[0].code);
    });
    return () => { alive = false; };
  }, [animalKey, db]);

  const save = useCallback(async () => {
    if (loaded === null || loaded === "missing" || loaded.domains === null || busy) return;
    const found = [...collarProblems(ruleRowOf(loaded.view)), ...productProblems(productId, "collar")];
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await placeCollar(db, { animalKey, productId, today: await cityTodayOf(db, now()), newUuid: crypto.randomUUID });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [animalKey, busy, crypto.randomUUID, db, loaded, now, onSaved, productId]);

  if (loaded === null) return <Screen title={PLACE_COLLAR}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "missing") return <Screen title={PLACE_COLLAR}><Notice tone="warn">{ANIMAL_NOT_FOUND}</Notice></Screen>;
  if (!loaded.allowed || loaded.domains === null) return <Screen title={PLACE_COLLAR}><Notice>{ZOONOSES_ERRORS.cbo_not_allowed}</Notice></Screen>;

  return (
    <Screen title={PLACE_COLLAR}>
      {at("animal_id", <Body>{loaded.title}</Body>)}
      {at("vector_product_id", (
        <Choice label="Produto" options={productOptions(loaded.domains, "collar")} value={productId || null}
          onChange={(next) => { setProductId(next ?? ""); setProblems((p) => p.filter((x) => x.path !== "vector_product_id")); }} />
      ))}
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : PLACE_COLLAR} disabled={busy} onPress={() => { void save(); }} />
    </Screen>
  );
}
