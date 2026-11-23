// "Instalar ovitrampa" from the household (35a; contract §6, §17; Q7(5), Q7(6), Q23): the dashboard's InstallForm
// (apps/dashboard src/modules/vectorControl/InstallForm.tsx, main 2e3a2a9) with its labels and phrases, offline. The
// household comes from its screen; the installation is today in the city's clock. The block is the profile as the tablet
// knows it (readProfile: the download with the bulletins still in the line); without it, household_without_block and no
// button. installProblems in the api's order, then the number the tablet knows to be taken (ovitrap_number_taken at
// `number`). The client_uuid is drawn when the form opens and is the one saved. No person: the short address only.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import type { Db } from "../../db/types";
import { installProblems, numberTaken, type OvitrapProblem } from "../../rules/ovitrap";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, FieldRefusal, Muted, Notice, Screen } from "../../ui/components";
import { Check } from "../../ui/choices";
import { NOT_FOUND } from "../households/HouseholdScreen";
import { addressShort, readHousehold } from "../households/view";
import { canUseOvitraps, cityTodayOf, loadSession } from "../session";
import { readProfile } from "../vector/profile";
import { installOvitrap } from "./save";
import { takenNumbers } from "./view";

export const TCLE_LABEL = "O morador assinou o termo de consentimento (TCLE)";
export const INSTALL_TITLE = "Instalar ovitrampa";
export const NOT_FOR_YOU = "só o agente de combate às endemias (CBO 515140) usa esta tela";

interface Loaded { address: string; hasBlock: boolean; allowed: boolean }

async function read(db: Db, householdKey: string): Promise<Loaded | "missing"> {
  const view = await readHousehold(db, householdKey);
  if (!view) return "missing";
  const reference = await loadReference(db).catch(() => null);
  const profile = await readProfile(db, householdKey);
  return { address: addressShort(view.body, reference?.dictionaries ?? null), hasBlock: !!profile?.city_block_id, allowed: canUseOvitraps(await loadSession(db)) };
}

export function InstallForm({ householdKey, onSaved }: { householdKey: string; onSaved(): void }) {
  const { db, crypto, now } = useServices();
  const { colors } = useTheme();
  const [loaded, setLoaded] = useState<Loaded | "missing" | null>(null);
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const [problems, setProblems] = useState<OvitrapProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Drawn once, when the form opens: the installation's client_uuid and the local row's key.
  const [clientUuid] = useState(() => crypto.randomUUID().toLowerCase());

  // Read once: a sync in the middle of the typing must not change what the person sees.
  useEffect(() => {
    let alive = true;
    void read(db, householdKey).then((value) => { if (alive) setLoaded(value); });
    return () => { alive = false; };
  }, [db, householdKey]);

  const save = useCallback(async () => {
    if (loaded === null || loaded === "missing" || busy) return;
    const today = await cityTodayOf(db, now());
    const found = installProblems({ number, consent, installedOn: today, householdHasBlock: loaded.hasBlock }, today);
    if (!found.some((p) => p.path === "number") && numberTaken(number, await takenNumbers(db))) {
      found.push({ code: "ovitrap_number_taken", path: "number", text: VECTOR_ERRORS.ovitrap_number_taken });
    }
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await installOvitrap(db, { householdKey, number, clientUuid, today });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, clientUuid, consent, db, householdKey, loaded, now, number, onSaved]);

  if (loaded === null) return <Screen title={INSTALL_TITLE}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "missing") return <Screen title={INSTALL_TITLE}><Notice tone="warn">{NOT_FOUND}</Notice></Screen>;
  if (!loaded.allowed) return <Screen title={INSTALL_TITLE}><Notice>{NOT_FOR_YOU}</Notice></Screen>;

  const refusals = (path: string): ReactNode => problems.map((problem, index) => (problem.path !== path ? null : index === 0
    ? <FieldRefusal key={index} problem={{ message: problem.text }} />
    : <Text key={index} accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.text}</Text>));

  return (
    <Screen title={INSTALL_TITLE}>
      <View testID="field-household_id" style={{ gap: 6 }}>
        <Body>{loaded.address}</Body>
        {!loaded.hasBlock && <Notice tone="warn">{VECTOR_ERRORS.household_without_block}</Notice>}
      </View>
      <View testID="field-number" style={{ gap: 6 }}>
        <Field label="Número" value={number} maxLength={12} autoCapitalize="characters" autoCorrect={false}
          onChangeText={(text) => { setNumber(text); setProblems((p) => p.filter((x) => x.path !== "number")); }} />
        {refusals("number")}
      </View>
      <View testID="field-consent" style={{ gap: 6 }}>
        <Check label={TCLE_LABEL} value={consent} onChange={(value) => { setConsent(value); setProblems((p) => p.filter((x) => x.path !== "consent")); }} />
        {refusals("consent")}
      </View>
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy ? "Salvando…" : "Instalar"} disabled={busy || !loaded.hasBlock} onPress={() => { void save(); }} />
    </Screen>
  );
}
