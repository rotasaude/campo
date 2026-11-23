// A record the server sent back for the person: the sentence of the refusal,
// the field it points to, and what can be done — correct it in its form,
// send it again, or discard it. Three refusals are questions, not errors:
// the server suspects the person typed is somebody it knows (its candidates
// are shown and the agent answers), the person already has a registration
// (the existing one is opened), or a participant looks like a repetition.
// 35a: a sample label already taken in the city (sample_label_taken, Q7(1)) offers new labels — only on the agent's tap,
// and the new ones are shown at once, for the tubes to be labelled again.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import type { Candidate, ItemType } from "../../contract";
import { useLive } from "../../db/events";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { fmtDay } from "../../rules/homeVisit";
import { discardImpact, removeUnsent, resend } from "../../sync/outbox";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, Muted, Notice, Screen, Title } from "../../ui/components";
import { pathLabel } from "../conflicts/fieldText";
import { phraseForItem } from "../messages/errorPhrases";
import { DISCARD_WARNING, ITEM_TYPE_LABEL, dependentsWarning } from "../outbox/OutboxScreen";
import { confirmOtherPerson, confirmSamePerson, discardForExisting } from "../registrations/duplicates";
import { confirmOtherParticipant } from "./participants";
import { correctNumber } from "../ovitraps/save";
import { takenNumbers } from "../ovitraps/view";
import { installProblems, numberTaken } from "../../rules/ovitrap";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { bulletinLabels, canRelabel, relabelVisit } from "../visits/relabel";

export const NOT_WAITING_FOR_YOU = "Este registro não está aguardando você.";
export const NO_FORM_FOR_THIS = "Este registro não pode ser corrigido aqui. Descarte e registre de novo.";
export const EXISTING_NOT_HERE = "O cadastro que esta pessoa já tem não está neste tablet. Descarte este registro, ou peça ao enfermeiro da equipe para conferir.";

// What "Corrigir" opens: the form of the record the item edits.
export interface FixTarget { type: ItemType; targetId: string; familyId: string | null }
const WITH_FORM: ItemType[] = ["household", "family", "individual_registration"];

const TABLES = ["outbox"];

// The new number of a refused installation: the shape (Q7(6)) and the numbers the tablet knows, the ovitrap itself left out.
async function numberRefusal(db: Db, ovitrapKey: string, number: string): Promise<string | null> {
  const shape = installProblems({ number, consent: true, installedOn: "2000-01-01", householdHasBlock: null }, "2000-01-01").find((p) => p.path === "number");
  if (shape) return shape.text;
  return numberTaken(number, await takenNumbers(db, ovitrapKey)) ? VECTOR_ERRORS.ovitrap_number_taken : null;
}

export function AttentionScreen({ seq, onFix, onOpenRegistration, onDone }: {
  seq: number; onFix(target: FixTarget): void; onOpenRegistration(registrationKey: string): void; onDone(): void;
}) {
  const { colors } = useTheme();
  const { db, crypto } = useServices();
  const read = useCallback(async (from: Db): Promise<{ item: OutboxItem | null; others: number; existingKey: string | null }> => {
    const item = await outboxRepo.bySeq(from, seq);
    const existingId = item?.error === "already_registered" ? ((item.candidates?.[0] as { registration_id?: string } | undefined)?.registration_id ?? null) : null;
    return {
      item, others: item ? await discardImpact(from, item.client_uuid) : 0,
      existingKey: existingId === null ? null : await territoryRepo.registrationKey(from, existingId),
    };
  }, [seq]);
  const data = useLive(TABLES, read);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // "Corrigir número" (Q11): the number typed, and why the tablet refuses it.
  const [number, setNumber] = useState<string | null>(null);
  const [numberProblem, setNumberProblem] = useState<string | null>(null);
  // The labels "Gerar etiquetas novas" gave: shown until the agent leaves (the item is back in the line by then).
  const [newLabels, setNewLabels] = useState<string[] | null>(null);

  if (!data) return <Screen title="Precisa de atenção"><Muted>Carregando…</Muted></Screen>;
  if (notice !== null) return <Screen title="Precisa de atenção"><Notice>{notice}</Notice></Screen>;
  // The dashboard's words after the 201 (InspectionSection.tubeLabelsText).
  if (newLabels !== null) return <Screen title="Precisa de atenção"><Notice>{`Etiquete os tubitos: ${newLabels.join(", ")}`}</Notice></Screen>;
  const { item } = data;
  if (item === null || item.state !== "needs_attention") return <Screen title="Precisa de atenção"><Notice>{NOT_WAITING_FOR_YOU}</Notice></Screen>;

  const run = (action: () => Promise<unknown>) => { void action().then(onDone).catch(() => setNotice("Não foi possível concluir. Volte e tente de novo.")); };
  const suspected = item.error === "duplicate_suspected" && (item.type === "individual_registration" || item.type === "patient");
  const registered = item.error === "already_registered";
  const candidates = suspected ? ((item.candidates ?? []) as Candidate[]) : [];
  const existingId = registered ? ((item.candidates?.[0] as { registration_id?: string } | undefined)?.registration_id ?? null) : null;
  const hasForm = WITH_FORM.includes(item.type) && item.target_id !== null && !suspected && !registered;
  const renumber = item.type === "ovitrap_installation" && item.error === "ovitrap_number_taken";
  const relabel = canRelabel(item);
  const card = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;

  const openExisting = async () => {
    const key = await discardForExisting(db, seq, existingId);
    if (key !== null) onOpenRegistration(key);
  };

  return (
    <Screen title="Precisa de atenção">
      <Body>{ITEM_TYPE_LABEL[item.type] ?? item.type}</Body>
      <Notice tone="warn">{phraseForItem(item.error, item)}</Notice>
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
      {registered && data.existingKey !== null && (
        <Button label="Abrir o cadastro existente" onPress={() => { void openExisting().catch(() => setNotice("Não foi possível concluir. Volte e tente de novo.")); }} />
      )}
      {registered && data.existingKey === null && <Notice>{EXISTING_NOT_HERE}</Notice>}
      {item.error === "duplicate_participant" && item.confirmable === true && (
        <Button label="É outra pessoa" variant="secondary" onPress={() => run(() => confirmOtherParticipant(db, seq))} />
      )}

      {hasForm && (
        <Button label="Corrigir" onPress={() => onFix({
          type: item.type, targetId: item.target_id as string,
          familyId: item.type === "family" ? (typeof item.body.family_id === "string" ? item.body.family_id : item.client_uuid) : null,
        })} />
      )}
      {renumber && (
        <>
          <Title>Corrigir número</Title>
          <Field label="Número" value={number ?? String(item.body.number ?? "")} maxLength={12} autoCapitalize="characters" autoCorrect={false}
            onChangeText={(text) => { setNumber(text); setNumberProblem(null); }} />
          {numberProblem !== null && <Notice tone="down">{numberProblem}</Notice>}
          <Button label="Reenviar" onPress={() => {
            const typed = number ?? String(item.body.number ?? "");
            void numberRefusal(db, item.client_uuid, typed).then((problem) => {
              if (problem !== null) setNumberProblem(problem);
              else run(() => correctNumber(db, seq, typed));
            });
          }} />
        </>
      )}
      {relabel && (
        <>
          <Muted>{bulletinLabels(item).join(", ")}</Muted>
          <Button label="Gerar etiquetas novas" onPress={() => {
            void relabelVisit(db, seq, crypto.randomUUID).then(({ labels }) => setNewLabels(labels))
              .catch(() => setNotice("Não foi possível concluir. Volte e tente de novo."));
          }} />
        </>
      )}
      {!hasForm && !suspected && !registered && !renumber && !relabel && <Muted>{NO_FORM_FOR_THIS}</Muted>}
      {!suspected && !registered && !renumber && !relabel && <Button label="Reenviar" variant="secondary" onPress={() => run(() => resend(db, seq))} />}
      {confirming ? (
        <>
          <Notice tone="down">{DISCARD_WARNING}</Notice>
          {dependentsWarning(data.others) !== null && <Notice tone="down">{dependentsWarning(data.others)}</Notice>}
          <Button label="Confirmar descarte" variant="danger" onPress={() => run(() => removeUnsent(db, item.client_uuid))} />
          <Button label="Cancelar" variant="secondary" onPress={() => setConfirming(false)} />
        </>
      ) : <Button label="Descartar" variant="danger" onPress={() => setConfirming(true)} />}
    </Screen>
  );
}
