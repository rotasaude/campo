// "Coletar palheta" (35a; contract §6; Q7(5), Q9, Q33): the dashboard's CollectForm
// (apps/dashboard src/modules/vectorControl/CollectForm.tsx, main 2e3a2a9) with its labels and phrases, offline. The
// collection is today in the city's clock; the open paddle is the one the list shows (the row with the line on top).
// No separate "reinstall" box: the item always carries `reinstall: !remove` (Q33), as the dashboard. The paddle's window
// (collectionProblems, in the reference's parameters) refuses before saving; without the vector domains the api decides.
// Never a count: the eggs are counted at the laboratory.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import type { HouseholdBody } from "../../contract";
import type { Db } from "../../db/types";
import { READING_CONDITIONS, collectionProblems, conditionLabel, type OvitrapProblem, type ReadingCondition } from "../../rules/ovitrap";
import { fmtDay } from "../../rules/homeVisit";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, FieldRefusal, Muted, Notice, Screen } from "../../ui/components";
import { Check, Choice } from "../../ui/choices";
import { addressShort } from "../households/view";
import { canUseOvitraps, cityTodayOf, loadSession } from "../session";
import { NOT_FOR_YOU } from "./InstallForm";
import { collectOvitrap } from "./save";
import { readOvitraps } from "./view";

export const LOST_ON_REMOVE = "a ovitrampa sai como perdida";
export const REINSTALL_NOTE = "a palheta é reinstalada na coleta";
// A collection opened for an ovitrap the line or the download already ended.
export const OVITRAP_GONE = VECTOR_ERRORS.ovitrap_not_active;

interface Loaded {
  number: string; address: string; installedOn: string; today: string;
  params: { ovitrap_collection_days_min: number; ovitrap_collection_days_max: number } | null; allowed: boolean;
}

async function read(db: Db, ovitrapKey: string, now: number): Promise<Loaded | "gone"> {
  const ovitrap = (await readOvitraps(db)).find((o) => o.key === ovitrapKey);
  if (!ovitrap || ovitrap.installedOn === null) return "gone";
  const reference = await loadReference(db).catch(() => null);
  const row = await db.get<{ body: string }>("SELECT body FROM households WHERE key = ?", [ovitrap.householdKey]);
  return {
    number: ovitrap.number, installedOn: ovitrap.installedOn, today: await cityTodayOf(db, now), params: reference?.vectorDomains?.parameters ?? null,
    address: row ? addressShort(JSON.parse(row.body) as HouseholdBody, reference?.dictionaries ?? null) : "",
    allowed: canUseOvitraps(await loadSession(db)),
  };
}

export function CollectForm({ ovitrapKey, onSaved }: { ovitrapKey: string; onSaved(): void }) {
  const { db, crypto, now } = useServices();
  const { colors } = useTheme();
  const [loaded, setLoaded] = useState<Loaded | "gone" | null>(null);
  const [condition, setCondition] = useState<ReadingCondition | null>(null);
  const [remove, setRemove] = useState(false);
  const [problems, setProblems] = useState<OvitrapProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void read(db, ovitrapKey, now()).then((value) => { if (alive) setLoaded(value); });
    return () => { alive = false; };
  }, [db, now, ovitrapKey]);

  const save = useCallback(async () => {
    if (loaded === null || loaded === "gone" || busy) return;
    const today = await cityTodayOf(db, now());
    // Without the parameters the window is not checked here (the api checks it).
    const range = loaded.params ?? { ovitrap_collection_days_min: -Infinity, ovitrap_collection_days_max: Infinity };
    const found = collectionProblems({ installedOn: loaded.installedOn, collectedOn: today, condition }, range, today);
    setProblems(found);
    if (found.length > 0 || condition === null) return;
    setBusy(true);
    setFailed(false);
    try {
      await collectOvitrap(db, { ovitrapKey, condition, remove, today, newUuid: crypto.randomUUID });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, condition, crypto, db, loaded, now, onSaved, ovitrapKey, remove]);

  if (loaded === null) return <Screen title="Coletar palheta"><Muted>Carregando…</Muted></Screen>;
  if (loaded === "gone") return <Screen title="Coletar palheta"><Notice tone="warn">{OVITRAP_GONE}</Notice></Screen>;
  if (!loaded.allowed) return <Screen title="Coletar palheta"><Notice>{NOT_FOR_YOU}</Notice></Screen>;

  const refusals = (path: string): ReactNode => problems.map((problem, index) => (problem.path !== path ? null : index === 0
    ? <FieldRefusal key={index} problem={{ message: problem.text }} />
    : <Text key={index} accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.text}</Text>));
  const options = READING_CONDITIONS.map((code) => ({ code, label: conditionLabel(code) }));

  return (
    <Screen title={`Coletar palheta — ovitrampa ${loaded.number}`}>
      <Muted>{`${loaded.address} · palheta desde ${fmtDay(loaded.installedOn)}`}</Muted>
      <View testID="field-collected_on" style={{ gap: 6 }}>
        <Muted>Data da coleta</Muted>
        <Body>{fmtDay(loaded.today)}</Body>
        {refusals("collected_on")}
      </View>
      <View testID="field-condition" style={{ gap: 6 }}>
        <Choice label="Condição da palheta" options={options} value={condition}
          onChange={(value) => { setCondition(value); setProblems((p) => p.filter((x) => x.path !== "condition")); }} />
        {refusals("condition")}
      </View>
      <Check label="Retirar a ovitrampa" value={remove} onChange={setRemove} />
      {remove ? condition === "lost" && <Muted>{LOST_ON_REMOVE}</Muted> : <Muted>{REINSTALL_NOTE}</Muted>}
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : "Registrar coleta"} disabled={busy} onPress={() => { void save(); }} />
    </Screen>
  );
}
