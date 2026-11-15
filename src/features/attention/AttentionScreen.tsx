// A record the server sent back for the person: the sentence of the refusal,
// the field it points to, and what can be done — correct it in its form,
// send it again, or discard it. Three refusals are questions, not errors:
// the server suspects the person typed is somebody it knows (its candidates
// are shown and the agent answers), the person already has a registration
// (the existing one is opened), or a participant looks like a repetition.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import type { Candidate, ItemType } from "../../contract";
import { useLive } from "../../db/events";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { fmtDay } from "../../rules/homeVisit";
import { removeUnsent, resend } from "../../sync/outbox";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";
import { pathLabel } from "../conflicts/fieldText";
import { phraseFor } from "../messages/errorPhrases";
import { DISCARD_WARNING, ITEM_TYPE_LABEL } from "../outbox/OutboxScreen";
import { confirmOtherPerson, confirmSamePerson, discardForExisting } from "../registrations/duplicates";
import { confirmOtherParticipant } from "./participants";

export const NOT_WAITING_FOR_YOU = "Este registro não está aguardando você.";
export const NO_FORM_FOR_THIS = "Este registro não pode ser corrigido aqui. Descarte e registre de novo.";
export const EXISTING_NOT_HERE = "O cadastro existente não está neste tablet. O registro foi descartado.";

// What "Corrigir" opens: the form of the record the item edits.
export interface FixTarget { type: ItemType; targetId: string; familyId: string | null }
const WITH_FORM: ItemType[] = ["household", "family", "individual_registration"];

const TABLES = ["outbox"];

export function AttentionScreen({ seq, onFix, onOpenRegistration, onDone }: {
  seq: number; onFix(target: FixTarget): void; onOpenRegistration(registrationKey: string): void; onDone(): void;
}) {
  const { colors } = useTheme();
  const { db } = useServices();
  const read = useCallback((from: Db) => outboxRepo.bySeq(from, seq).then((item): { item: OutboxItem | null } => ({ item })), [seq]);
  const data = useLive(TABLES, read);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!data) return <Screen title="Precisa de atenção"><Muted>Carregando…</Muted></Screen>;
  if (notice !== null) return <Screen title="Precisa de atenção"><Notice>{notice}</Notice></Screen>;
  const { item } = data;
  if (item === null || item.state !== "needs_attention") return <Screen title="Precisa de atenção"><Notice>{NOT_WAITING_FOR_YOU}</Notice></Screen>;

  const run = (action: () => Promise<unknown>) => { void action().then(onDone).catch(() => setNotice("Não foi possível concluir. Volte e tente de novo.")); };
  const suspected = item.error === "duplicate_suspected" && (item.type === "individual_registration" || item.type === "patient");
  const registered = item.error === "already_registered";
  const candidates = suspected ? ((item.candidates ?? []) as Candidate[]) : [];
  const existingId = registered ? ((item.candidates?.[0] as { registration_id?: string } | undefined)?.registration_id ?? null) : null;
  const hasForm = WITH_FORM.includes(item.type) && item.target_id !== null && !suspected && !registered;
  const card = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;

  const openExisting = async () => {
    const key = await discardForExisting(db, seq, existingId);
    if (key === null) setNotice(EXISTING_NOT_HERE);
    else onOpenRegistration(key);
  };

  return (
    <Screen title="Precisa de atenção">
      <Body>{ITEM_TYPE_LABEL[item.type] ?? item.type}</Body>
      <Notice tone="warn">{phraseFor(item.error)}</Notice>
      {item.path !== null && <Body>{`Campo: ${pathLabel(item.type, item.path)}`}</Body>}

      {candidates.map((candidate) => (
        <View key={candidate.patient_id} testID={`candidate-${candidate.patient_id}`} style={card}>
          <Body>{candidate.display_name}</Body>
          <Muted>{[
            `Nascimento: ${fmtDay(candidate.birth_date)}`, candidate.has_cpf ? "com CPF" : "sem CPF",
            ...(candidate.has_cns === undefined ? [] : [candidate.has_cns ? "com CNS" : "sem CNS"]),
          ].join(" · ")}</Muted>
          <Button label="É esta pessoa" onPress={() => run(() => confirmSamePerson(db, seq, candidate.patient_id))} />
        </View>
      ))}
      {suspected && <Button label="É outra pessoa" variant="secondary" onPress={() => run(() => confirmOtherPerson(db, seq))} />}
      {registered && <Button label="Abrir o cadastro existente" onPress={() => { void openExisting().catch(() => setNotice("Não foi possível concluir. Volte e tente de novo.")); }} />}
      {item.error === "duplicate_participant" && item.confirmable === true && (
        <Button label="É outra pessoa" variant="secondary" onPress={() => run(() => confirmOtherParticipant(db, seq))} />
      )}

      {hasForm && (
        <Button label="Corrigir" onPress={() => onFix({
          type: item.type, targetId: item.target_id as string,
          familyId: item.type === "family" ? (typeof item.body.family_id === "string" ? item.body.family_id : item.client_uuid) : null,
        })} />
      )}
      {!hasForm && !suspected && !registered && <Muted>{NO_FORM_FOR_THIS}</Muted>}
      {!suspected && !registered && <Button label="Reenviar" variant="secondary" onPress={() => run(() => resend(db, seq))} />}
      {confirming ? (
        <>
          <Notice tone="down">{DISCARD_WARNING}</Notice>
          <Button label="Confirmar descarte" variant="danger" onPress={() => run(() => removeUnsent(db, item.client_uuid))} />
          <Button label="Cancelar" variant="secondary" onPress={() => setConfirming(false)} />
        </>
      ) : <Button label="Descartar" variant="danger" onPress={() => setConfirming(true)} />}
    </Screen>
  );
}
