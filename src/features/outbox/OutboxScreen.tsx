// "Envio": what the tablet still owes the server, item by item, in the order
// it was written. Type, state and — when the server refused — the phrase of
// the refusal. Nothing of the body is shown here: the form of the item is
// where the person sees and fixes the data.
import { useState } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import type { ItemType } from "../../contract";
import { useLive } from "../../db/events";
import { outboxRepo, type OutboxItem, type OutboxState } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { discardImpact, removeUnsent, resend } from "../../sync/outbox";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";
import { itemContext } from "../households/view";
import { phraseForItem, type ItemContext } from "../messages/errorPhrases";
import { canRenumber } from "../ovitraps/save";
import { canRelabel } from "../visits/relabel";

export const DISCARD_WARNING = "Este registro nunca chegou ao Rota Saúde e será apagado";
// Said with the discard warning when other records go with the one being discarded (what cites it, what waits for it).
export function dependentsWarning(others: number): string | null {
  if (others <= 0) return null;
  return others === 1 ? "Outro registro que depende dele também será apagado." : `Outros ${others} registros que dependem dele também serão apagados.`;
}
export const EMPTY_OUTBOX = "Nada para enviar: tudo o que você registrou já está no Rota Saúde.";

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  home_visit: "Visita domiciliar", home_visit_withdrawal: "Retirada de visita", collective_activity: "Atividade coletiva",
  patient: "Pessoa", household: "Domicílio", family: "Família", individual_registration: "Cadastro individual",
  ovitrap_installation: "Instalação de ovitrampa", ovitrap_collection: "Coleta de ovitrampa",
};
export const ITEM_STATE_LABEL: Record<OutboxState, string> = {
  pending: "aguardando envio", sending: "enviando", needs_attention: "precisa de atenção", conflict: "conflito com o posto",
  blocked: "aguardando outro registro",
};

const TABLES = ["outbox"];
// With the context of each refused item's phrase (Q54: the endemic agent's household).
async function readAll(db: Db): Promise<{ item: OutboxItem; context: ItemContext | undefined }[]> {
  const items = await outboxRepo.all(db);
  return Promise.all(items.map(async (item) => ({ item, context: item.state === "needs_attention" ? await itemContext(db, item) : undefined })));
}

export function OutboxScreen({ onFix, onResolve }: { onFix(seq: number): void; onResolve(seq: number): void }) {
  const { db } = useServices();
  const items = useLive(TABLES, readAll);
  // The item whose discard is being confirmed, and how many other records would go with it.
  const [confirming, setConfirming] = useState<number | null>(null);
  const [others, setOthers] = useState(0);

  if (!items) return <Screen title="Envio"><Muted>Carregando…</Muted></Screen>;
  return (
    <Screen title="Envio">
      {items.length === 0 && <Body>{EMPTY_OUTBOX}</Body>}
      {items.map(({ item, context }) => (
        <Item key={item.seq} item={item} context={context} confirming={confirming === item.seq} others={confirming === item.seq ? others : 0}
          onFix={() => onFix(item.seq)} onResolve={() => onResolve(item.seq)}
          onResend={() => void resend(db, item.seq)}
          onAskDiscard={() => { void discardImpact(db, item.client_uuid).then((count) => { setOthers(count); setConfirming(item.seq); }); }}
          onCancelDiscard={() => setConfirming(null)}
          onDiscard={() => { setConfirming(null); void removeUnsent(db, item.client_uuid); }} />
      ))}
    </Screen>
  );
}

function Item({ item, context, confirming, others, onFix, onResolve, onResend, onAskDiscard, onCancelDiscard, onDiscard }: {
  item: OutboxItem; context: ItemContext | undefined; confirming: boolean; others: number; onFix(): void; onResolve(): void; onResend(): void; onAskDiscard(): void; onCancelDiscard(): void; onDiscard(): void;
}) {
  const { colors } = useTheme();
  const attention = item.state === "needs_attention";
  // Only what the server never accepted and is not travelling can be thrown away.
  const discardable = attention || item.state === "blocked";
  // A refusal with an action of its own ("Gerar etiquetas novas", "Corrigir número") would come back the same if resent:
  // "Corrigir" opens "Precisa de atenção", where the action is.
  const resendable = attention && !canRelabel(item) && !canRenumber(item);
  return (
    <View testID={`outbox-item-${item.seq}`} style={{ gap: 8, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
      <Body>{ITEM_TYPE_LABEL[item.type] ?? item.type}</Body>
      <Muted>{ITEM_STATE_LABEL[item.state] ?? item.state}</Muted>
      {attention && <Notice tone="warn">{phraseForItem(item.error, item, context)}</Notice>}
      {confirming ? (
        <View style={{ gap: 8 }}>
          <Notice tone="down">{DISCARD_WARNING}</Notice>
          {dependentsWarning(others) !== null && <Notice tone="down">{dependentsWarning(others)}</Notice>}
          <Button label="Confirmar descarte" variant="danger" onPress={onDiscard} />
          <Button label="Cancelar" variant="secondary" onPress={onCancelDiscard} />
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {attention && <Button label="Corrigir" onPress={onFix} />}
          {resendable && <Button label="Reenviar" variant="secondary" onPress={onResend} />}
          {item.state === "conflict" && <Button label="Resolver" onPress={onResolve} />}
          {discardable && <Button label="Descartar" variant="danger" onPress={onAskDiscard} />}
        </View>
      )}
    </View>
  );
}
