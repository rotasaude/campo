// The endemic agent's bulletin inside the home visit (module 35a, §3, §14): the behaviour of the dashboard's Task 5
// (apps/dashboard src/modules/homeVisits/InspectionSection.tsx, dashboard main 2e3a2a9) on the tablet, with its labels.
// What differs from there:
// - the sample label is final from the moment the line is born (the visit is offline: the client_uuid was fixed when
//   the form opened and is the one saved, §9) — so only the last sample can be deleted, and a deposit group with
//   samples is not taken out (either would renumber the labels already written on the tubes, Review Focus 1);
// - the counts are steppers (Counter) and the times are "hh:mm" text, as the visit's own time;
// - the profile and the blocks come from the tablet (src/features/vector/profile.ts), not from a request.
// The draft keeps text (InspectionDraft); the form converts, checks and saves. Nothing of a person here: the place is
// read only by its type and its vector profile.
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { CityBlockBody } from "../../contract";
import type { DepositGroup, MeasureMethod, VectorControlDomains } from "../../rules/vectorDomains";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { IE_PROPERTIES, PE_PROPERTY, measureQuantity, sampleLabel, type InspectionDraft } from "../../rules/vectorInspection";
import { SIZES, useTheme } from "../../theme/theme";
import { Check, Choice } from "../../ui/choices";
import { Body, Button, Field, Muted, Title } from "../../ui/components";
import { Counter } from "../../ui/counter";
import type { VectorProfile } from "../vector/profile";

// Q10: the bulletin is of a registered household.
export const BULLETIN_NEEDS_HOUSEHOLD = "O boletim precisa de um imóvel cadastrado.";
// Q44(2): the endemic agent with the switch on and no vector domains on this tablet.
export const BULLETIN_UNAVAILABLE = "o boletim está indisponível neste aparelho — sincronize ou atualize o app";
export const BLOCK_FROM_PROFILE = "o imóvel já tem quarteirão no perfil — só a coordenação de endemias troca";
export const SAMPLE_NEEDS_LARVAE = "amostra só de grupo com larva";
export const EXIT_AT_SAVE = "Saída em branco: a hora em que a visita for registrada.";
export const SECTION_TITLE = "Boletim do agente de endemias";
const ROOT = "vector_inspection";
const COUNTERS = [
  ["existing", "Existentes"], ["with_water", "Com água"], ["with_larvae", "Com larva"], ["eliminated", "Eliminados"], ["treated", "Tratados"],
] as const;

// `prune`: the change is of the situation (the form prunes and says what went); `cleared`: what the section itself
// took out; `touched`: the entry was typed (blank again, it follows the visit's time again).
export type InspectionChange = { prune?: boolean; cleared?: string[]; touched?: "entry" };

const decimal = (s: string) => s.replace(".", ",");
// Text → number as the draft reads it (comma accepted); anything else → null.
const parse = (s: string): number | null => (/^\d+([.,]\d+)?$/.test(s.trim()) ? Number(s.trim().replace(",", ".")) : null);
const labelOf = (list: { code: string; label: string }[], code: string) => list.find((x) => x.code === code)?.label ?? code;

// Activities offered: LIRAa and transmission block only with the link of the start (Q8); PE only in a strategic point,
// IE only in a special property. The one already chosen stays in the list (the rule refuses it if it does not hold).
export function offeredActivities(domains: VectorControlDomains, draft: InspectionDraft, propertyType: string) {
  return domains.activities.filter((a) => {
    if (a.code === draft.activity) return true;
    if (a.code === "liraa") return draft.liraaDrawItemId !== null;
    if (a.code === "transmission_block") return draft.transmissionBlockId !== null;
    if (a.code === "pe") return propertyType === PE_PROPERTY;
    if (a.code === "ie") return (IE_PROPERTIES as readonly string[]).includes(propertyType);
    return true;
  });
}

// The `path`s the section shows at their field; any other goes to the form's list at the end.
export function inspectionPaths(draft: InspectionDraft): Set<string> {
  const out = [ROOT, ...["activity", "work_type", "situation", "educational_action", "entered_at", "left_at", "liraa_draw_item_id",
    "transmission_block_id", "city_block_id", "risk_class", "deposits", "measures", "samples"].map((k) => `${ROOT}.${k}`)];
  draft.deposits.forEach((_, i) => {
    const p = `${ROOT}.deposits[${i}]`;
    out.push(p, `${p}.group`, ...COUNTERS.map(([k]) => `${p}.${k}`));
  });
  draft.measures.forEach((_, i) => { const p = `${ROOT}.measures[${i}]`; out.push(p, `${p}.method`, `${p}.vector_product_id`, `${p}.charges`); });
  draft.samples.forEach((_, i) => { const p = `${ROOT}.samples[${i}]`; out.push(p, `${p}.number`, `${p}.deposit_group`, `${p}.larvae_collected`); });
  return new Set(out);
}

export function InspectionSection({ draft, onChange, domains, propertyType, profile, neighborhoodId, blocks, clientUuid, cleared, refusals }: {
  draft: InspectionDraft; onChange(next: InspectionDraft, o?: InspectionChange): void; domains: VectorControlDomains; propertyType: string;
  profile: VectorProfile | null; neighborhoodId: string | null; blocks: CityBlockBody[] | null;
  clientUuid: string; cleared: string | null;
  // The refusals of this `path`, under its field.
  refusals(path: string): ReactNode;
}) {
  const { colors } = useTheme();
  const [groupToAdd, setGroupToAdd] = useState<DepositGroup | null>(null);
  const [methodToAdd, setMethodToAdd] = useState<MeasureMethod | null>(null);
  const [sampleGroup, setSampleGroup] = useState<DepositGroup | null>(null);
  const p = (k: string) => `${ROOT}.${k}`;
  const set = (patch: Partial<InspectionDraft>, o?: InspectionChange) => onChange({ ...draft, ...patch }, o);
  const at = (path: string, children: ReactNode) => <View key={path} testID={`field-${path}`} style={{ gap: 6 }}>{children}{refusals(path)}</View>;
  const card = { gap: 8, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;

  const worked = draft.situation === null || draft.situation === "worked";
  const usedGroups = new Set(draft.deposits.map((d) => d.group));
  const freeGroups = domains.deposit_groups.filter((g) => !usedGroups.has(g.code));
  // A sample per deposit with larvae: a group is offered while it has more larvae than samples.
  const samplesOf = (g: DepositGroup) => draft.samples.filter((s) => s.group === g).length;
  const larvaeGroups = draft.deposits.filter((d) => (parse(d.with_larvae) ?? 0) > samplesOf(d.group)).map((d) => d.group);
  const anyLarvae = draft.deposits.some((d) => (parse(d.with_larvae) ?? 0) > 0);
  const { limits } = domains;

  const setDeposit = (i: number, key: (typeof COUNTERS)[number][0], v: string) =>
    set({ deposits: draft.deposits.map((d, j) => (j === i ? { ...d, [key]: v } : d)) });
  const setMeasure = (i: number, patch: Partial<InspectionDraft["measures"][number]>) =>
    set({ measures: draft.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  // A mechanical measure takes no product nor charges; a product that does not serve the new method goes. Either is said.
  function setMethod(i: number, method: MeasureMethod) {
    const m = draft.measures[i];
    const product = domains.products.find((x) => x.id === m.productId);
    const gone: string[] = [];
    let next = { ...m, method };
    if (method === "mechanical") {
      if (m.productId !== null || m.charges !== "") gone.push("produto e cargas da medida mecânica");
      next = { ...next, productId: null, charges: "" };
    } else if (product && !(product.uses as string[]).includes(method)) {
      gone.push(`produto da medida ${i + 1}`);
      next = { ...next, productId: null };
    }
    set({ measures: draft.measures.map((x, j) => (j === i ? next : x)) }, { cleared: gone });
  }

  return (
    <View style={{ gap: SIZES.gap }}>
      <Title>{SECTION_TITLE}</Title>
      {refusals(ROOT)}
      {cleared !== null && <Muted>{cleared}</Muted>}

      {at(p("activity"),
        <Choice label="Atividade" options={offeredActivities(domains, draft, propertyType)} value={draft.activity} onChange={(activity) => set({ activity })} />)}
      {refusals(p("liraa_draw_item_id"))}
      {refusals(p("transmission_block_id"))}
      {at(p("work_type"),
        <Choice label="Tipo de trabalho" options={domains.work_types} value={draft.workType} onChange={(workType) => { if (workType !== null) set({ workType }); }} />)}
      {at(p("situation"),
        <Choice label="Situação do imóvel" options={domains.situations} value={draft.situation}
          onChange={(situation) => onChange({ ...draft, situation }, { prune: true })} />)}

      {at(p("entered_at"),
        <Field label="Entrada (hh:mm)" value={draft.enteredAt} keyboardType="number-pad" onChangeText={(enteredAt) => set({ enteredAt }, { touched: "entry" })} />)}
      {at(p("left_at"),
        <Field label="Saída (hh:mm)" value={draft.leftAt} keyboardType="number-pad" onChangeText={(leftAt) => set({ leftAt })} />)}
      {/* True only when it holds: a blank exit goes as the moment of saving only with an entry. */}
      {draft.leftAt.trim() === "" && draft.enteredAt.trim() !== "" && <Muted>{EXIT_AT_SAVE}</Muted>}

      {worked && at(p("deposits"), (
        <>
          <Body>Depósitos</Body>
          {draft.deposits.map((d, i) => {
            const dp = `${ROOT}.deposits[${i}]`;
            return (
              <View key={d.group} testID={`deposit-${d.group}`} style={card}>
                <Body>{labelOf(domains.deposit_groups, d.group)}</Body>
                {refusals(dp)}
                {refusals(`${dp}.group`)}
                {COUNTERS.map(([key, label]) => at(`${dp}.${key}`,
                  // "Com larva" does not step below the group's samples (a sample per deposit with larvae).
                  <Counter label={label} value={d[key]} max={limits.deposit_count_max} min={key === "with_larvae" ? samplesOf(d.group) : 0}
                    onChange={(v) => setDeposit(i, key, v)} />))}
                {samplesOf(d.group) === 0 && (
                  <Button label="Retirar grupo" variant="secondary" onPress={() => set({ deposits: draft.deposits.filter((_, j) => j !== i) })} />
                )}
              </View>
            );
          })}
          {freeGroups.length > 0 && (
            <>
              {at(p("deposit_group"),
                <Choice label="Grupo do depósito" options={freeGroups} value={groupToAdd} onChange={(g) => setGroupToAdd(g)} />)}
              <Button label="Adicionar grupo" variant="secondary" disabled={groupToAdd === null || !freeGroups.some((g) => g.code === groupToAdd)}
                onPress={() => {
                  if (groupToAdd === null) return;
                  setGroupToAdd(null);
                  set({ deposits: [...draft.deposits, { group: groupToAdd, existing: "0", with_water: "0", with_larvae: "0", eliminated: "0", treated: "0" }] });
                }} />
            </>
          )}
        </>
      ))}

      {worked && at(p("measures"), (
        <>
          <Body>Medidas de controle</Body>
          {draft.measures.map((m, i) => {
            const mp = `${ROOT}.measures[${i}]`;
            const products = domains.products.filter((x) => (x.uses as string[]).includes(m.method) || x.id === m.productId);
            const product = domains.products.find((x) => x.id === m.productId);
            const charges = parse(m.charges);
            return (
              <View key={i} testID={`measure-${i + 1}`} style={card}>
                <Body>{`Medida ${i + 1}`}</Body>
                {refusals(mp)}
                {at(`${mp}.method`,
                  <Choice label="Método" options={domains.measure_methods} value={m.method} onChange={(method) => { if (method !== null) setMethod(i, method); }} />)}
                {m.method !== "mechanical" && (
                  <>
                    {at(`${mp}.vector_product_id`,
                      <Choice label="Produto" options={products.map((x) => ({ code: x.id, label: x.name }))} value={m.productId}
                        onChange={(productId) => setMeasure(i, { productId })} />)}
                    {at(`${mp}.charges`,
                      <Field label="Cargas" value={m.charges} keyboardType="decimal-pad" onChangeText={(text) => setMeasure(i, { charges: text })} />)}
                    {product && charges !== null && charges > 0 && <Muted>{`= ${decimal(measureQuantity(charges, product.charge_size))} ${product.unit}`}</Muted>}
                  </>
                )}
                <Button label="Retirar medida" variant="secondary" onPress={() => set({ measures: draft.measures.filter((_, j) => j !== i) })} />
              </View>
            );
          })}
          {at(p("measure_method"),
            <Choice label="Método da medida" options={domains.measure_methods} value={methodToAdd} onChange={(m) => setMethodToAdd(m)} />)}
          <Button label="Adicionar medida" variant="secondary" disabled={methodToAdd === null || draft.measures.length >= limits.measures_max}
            onPress={() => {
              if (methodToAdd === null || draft.measures.length >= limits.measures_max) return;
              setMethodToAdd(null);
              set({ measures: [...draft.measures, { method: methodToAdd, productId: null, charges: "" }] });
            }} />
        </>
      ))}

      {worked && at(p("samples"), (
        <>
          <Body>Amostras</Body>
          {draft.samples.map((s, i) => {
            const sp = `${ROOT}.samples[${i}]`;
            const last = i === draft.samples.length - 1;
            return (
              <View key={i} testID={`sample-${i + 1}`} style={card}>
                <Body>{`Amostra ${i + 1}`}</Body>
                {/* Final from the moment the line is born: the label written on the tube. */}
                <Body>{sampleLabel(clientUuid, i + 1)}</Body>
                <Muted>{`grupo ${s.group}`}</Muted>
                {refusals(sp)}
                {refusals(`${sp}.number`)}
                {refusals(`${sp}.deposit_group`)}
                {at(`${sp}.larvae_collected`,
                  <Counter label="Larvas coletadas" value={s.larvae} max={limits.larvae_collected_max}
                    onChange={(larvae) => set({ samples: draft.samples.map((x, j) => (j === i ? { ...x, larvae } : x)) })} />)}
                {last && <Button label="Retirar amostra" variant="danger" onPress={() => set({ samples: draft.samples.slice(0, -1) })} />}
              </View>
            );
          })}
          {!anyLarvae ? <Muted>{SAMPLE_NEEDS_LARVAE}</Muted> : larvaeGroups.length > 0 && (
            <>
              {at(p("sample_group"),
                <Choice label="Grupo da amostra" options={larvaeGroups.map((g) => ({ code: g, label: g }))} value={sampleGroup} onChange={(g) => setSampleGroup(g)} />)}
              <Button label="Adicionar amostra" variant="secondary"
                disabled={sampleGroup === null || !larvaeGroups.includes(sampleGroup) || draft.samples.length >= limits.samples_max}
                onPress={() => {
                  if (sampleGroup === null || draft.samples.length >= limits.samples_max) return;
                  setSampleGroup(null);
                  set({ samples: [...draft.samples, { group: sampleGroup, larvae: "" }] });
                }} />
            </>
          )}
        </>
      ))}

      {worked && at(p("educational_action"),
        <Check label="Ação educativa" value={draft.educationalAction} onChange={(educationalAction) => set({ educationalAction })} />)}

      <Body>Quarteirão do imóvel</Body>
      {profile?.city_block_id ? <Muted>{BLOCK_FROM_PROFILE}</Muted>
        : neighborhoodId === null ? <Muted>{VECTOR_ERRORS.household_without_neighborhood}</Muted>
        : at(p("city_block_id"),
          <Choice label="Quarteirão" options={(blocks ?? []).filter((b) => b.active).map((b) => ({ code: b.id, label: b.number }))} value={draft.cityBlockId}
            onChange={(cityBlockId) => set({ cityBlockId })} />)}

      {at(p("risk_class"), (
        <>
          {profile?.risk_class && <Muted>{`atual: ${labelOf(domains.risk_classes, profile.risk_class)}`}</Muted>}
          <Choice label="Risco do imóvel" options={domains.risk_classes} value={draft.riskClass} onChange={(riskClass) => set({ riskClass })} />
        </>
      ))}
    </View>
  );
}
