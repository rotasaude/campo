// The household form: the address, the kind of property, the living
// conditions (only where they apply) and the point on the map. What the api
// would refuse is refused here first, by the rules ported from the dashboard,
// with the sentence under the field. Saving never needs the network: the
// record goes to the outbox and is on the screens at once.
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useServices } from "../../app/services";
import type { Location } from "../../contract";
import { captureGps, mapTapLocation } from "../../location/capture";
import type { MapCanvasProps } from "../../map/canvas";
import { createRegistryRules, type HouseholdInput, type Problem } from "../../rules/registry";
import { loadReference, type Reference } from "../../sync/reference";
import { Choice, YesNo } from "../../ui/choices";
import { Body, Button, Field, FieldRefusal, InSightAfter, Muted, Notice, Screen, Title } from "../../ui/components";
import { SectionFields } from "../forms/SectionFields";
import { MapScreen } from "../map/MapScreen";
import { canEditRegistry, loadSession, myMicroAreas, type MyMicroArea } from "../session";
import { HouseholdInConflictError, saveHousehold, type HouseholdFields } from "./save";
import { pointText, readHousehold, type HouseholdView } from "./view";

export const READ_ONLY = "Só o agente comunitário de saúde edita o cadastro neste app. Aqui você consulta.";
export const NO_FIX_MARK_ON_MAP = "Sem posição precisa. Marque no mapa.";
export const NOT_READY = "As listas do cadastro ainda não chegaram a este tablet. Sincronize e tente de novo.";

type Values = Record<string, unknown>;
interface AddressDraft { zip: string; street_type: string | null; street: string; number: string; no_number: boolean; complement: string; neighborhood_id: string | null; district: string; reference: string }
interface Draft {
  microAreaId: string | null; refused: boolean; address: AddressDraft; propertyType: string | null; phone: string; living: Values;
  // undefined: the point was not touched in this form (an edit then leaves it as the server has it).
  location: Location | null | undefined;
}
interface Loaded { reference: Reference; areas: MyMicroArea[]; view: HouseholdView | null; current: Location | null }

const digits = (text: string) => text.replace(/\D/g, "");
const text = (value: unknown) => (typeof value === "string" ? value : "");
const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

function draftOf(view: HouseholdView | null, areas: MyMicroArea[]): Draft {
  const body = view?.body;
  const a = (body?.address ?? {}) as Values;
  return {
    microAreaId: body?.micro_area.id ?? (areas.length === 1 ? areas[0].id : null),
    refused: body?.refused ?? false,
    address: {
      zip: text(a.zip), street_type: typeof a.street_type === "string" ? a.street_type : null, street: text(a.street), number: text(a.number),
      no_number: a.no_number === true, complement: text(a.complement), neighborhood_id: typeof a.neighborhood_id === "string" ? a.neighborhood_id : null,
      district: text(a.district), reference: text(a.reference),
    },
    propertyType: body?.property_type ?? null, phone: body?.contact_phone ?? "", living: { ...((body?.living_conditions ?? {}) as Values) },
    location: undefined,
  };
}

export interface HouseholdFormProps {
  // Absent: a new household.
  householdKey?: string;
  // What draws the map, for "Marcar no mapa".
  map: { Canvas: ComponentType<MapCanvasProps>; readHead(uri: string, bytes: number): Promise<Uint8Array> };
  // Android's Back button. A handler that answers true keeps the press from reaching the navigator.
  back: { onPress(handler: () => boolean): { remove(): void } };
  onSaved(key: string): void;
}

export function HouseholdForm({ householdKey, map, back, onSaved }: HouseholdFormProps) {
  const { db, crypto, now, location: gps } = useServices();
  const [loaded, setLoaded] = useState<Loaded | "read_only" | "not_ready" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  // Read once: a sync in the middle of the typing must not rewrite what the person sees.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const session = await loadSession(db);
      if (!canEditRegistry(session)) { if (alive) setLoaded("read_only"); return; }
      const reference = await loadReference(db).catch(() => null);
      if (reference === null) { if (alive) setLoaded("not_ready"); return; }
      const view = householdKey === undefined ? null : await readHousehold(db, householdKey);
      if (!alive) return;
      const areas = myMicroAreas(session);
      setLoaded({ reference, areas, view, current: view?.body.location ?? null });
      setDraft(draftOf(view, areas));
    })();
    return () => { alive = false; };
  }, [db, householdKey]);

  // The map to mark the point takes the place of the form inside the same route: Back closes the map, not the form
  // (the navigator would pop the route, and with it everything the person typed).
  useEffect(() => {
    if (!picking) return undefined;
    const subscription = back.onPress(() => { setPicking(false); return true; });
    return () => subscription.remove();
  }, [back, picking]);

  const reference = loaded !== null && typeof loaded === "object" ? loaded.reference : null;
  const rules = useMemo(() => (reference === null ? null : createRegistryRules(reference.dictionaries)), [reference]);

  if (loaded === null) return <Screen title="Domicílio"><Muted>Carregando…</Muted></Screen>;
  if (loaded === "read_only") return <Screen title="Domicílio"><Notice>{READ_ONLY}</Notice></Screen>;
  if (loaded === "not_ready" || draft === null || rules === null || reference === null) return <Screen title="Domicílio"><Notice tone="warn">{NOT_READY}</Notice></Screen>;

  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setProblem(null); };
  const setAddress = (patch: Partial<AddressDraft>) => set({ address: { ...draft.address, ...patch } });
  const type = draft.propertyType ?? "";
  const livingAsked = !draft.refused && rules.allowsLivingConditions(type);
  const shownLocation = draft.location === undefined ? loaded.current : draft.location;

  // The item's fields, as the contract wants them: empty text is null, and what does not apply does not go.
  const fields = (): HouseholdFields => {
    const a = draft.address;
    const address = {
      zip: orNull(digits(a.zip)), street_type: a.street_type, street: orNull(a.street), number: a.no_number ? null : orNull(a.number), no_number: a.no_number,
      complement: orNull(a.complement), neighborhood_id: a.neighborhood_id, district: orNull(a.district), reference: orNull(a.reference),
    };
    const blank = Object.entries(address).every(([key, value]) => key === "no_number" ? value === false : value === null);
    return {
      micro_area_id: draft.microAreaId ?? "", property_type: type as HouseholdFields["property_type"], refused: draft.refused,
      contact_phone: orNull(digits(draft.phone)),
      // A refusal with nothing of the address written carries no address at all.
      ...(draft.refused && blank ? {} : { address }),
      living_conditions: livingAsked ? draft.living : {},
      ...(draft.location === undefined ? {} : { location: draft.location }),
    };
  };

  const save = async () => {
    const body = fields();
    if (draft.microAreaId === null) { setProblem({ path: "micro_area_id", message: "escolha a microárea" }); return; }
    const families = (loaded.view?.body.families ?? []).map((family) => ({
      members_count: family.members_count, moved_out: family.moved_out, responsible: { patient_id: family.responsible.patient_id },
    }));
    const neighborhoods = reference.neighborhoods.map((n) => ({ ...n, active: true }));
    const found = rules.householdProblem(body as unknown as HouseholdInput, families, { neighborhoods });
    if (found) { setProblem(found); return; }
    setSaving(true);
    try {
      // The base is the one the form opened with: a round may have downloaded a newer version since.
      const saved = await saveHousehold(db, { key: householdKey, fields: body, editBase: loaded.view?.base ?? null }, { newUuid: crypto.randomUUID, now });
      // What was just saved is now what the household has.
      setLoaded({ ...loaded, current: shownLocation });
      setDraft({ ...draft, location: undefined });
      onSaved(saved.key);
    } catch (err) {
      setNotice(err instanceof HouseholdInConflictError ? err.message : "Não foi possível salvar. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const readGps = async () => {
    setLocating(true);
    setNotice(null);
    const fix = await captureGps(gps);
    setLocating(false);
    if (fix === null) setNotice(NO_FIX_MARK_ON_MAP);
    else set({ location: fix });
  };

  const at = (key: string, path: string, children: ReactNode) => (
    <View testID={`field-${key}`} style={{ gap: 6 }}>
      {children}
      {problem?.path === path && <FieldRefusal problem={problem} />}
    </View>
  );
  const fieldPaths = new Set([
    "micro_area_id", "property_type", "contact_phone", "address.zip", "address.street_type", "address.street", "address.number",
    "address.complement", "address.neighborhood_id", "address.district", "address.reference",
  ]);
  const general = problem !== null && !fieldPaths.has(problem.path) && !problem.path.startsWith("living_conditions.") ? problem.message : null;
  const streetTypes = reference.dictionaries.stringDomains.tipo_logradouro;
  const propertyTypes = (reference.dictionaries.domains.tipo_de_imovel ?? []).map((entry) => ({ code: String(entry.code), label: entry.label }));

  // The map to mark the point is opened from the end of the form. It is drawn over the form, which stays where it was —
  // out of sight, out of the screen reader and out of reach of a touch — instead of taking its place: a form taken off
  // the screen comes back at its top, with the point just marked and the button several screens below.
  return (
    <View style={{ flex: 1 }}>
    <View style={{ flex: 1 }} pointerEvents={picking ? "none" : "auto"}
      importantForAccessibility={picking ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={picking}>
    <Screen title={householdKey === undefined ? "Novo domicílio" : "Editar domicílio"}>
      {at("micro_area_id", "micro_area_id",
        <Choice label="Microárea" options={loaded.areas.map((area) => ({ code: area.id, label: `${area.code} · ${area.name}` }))} value={draft.microAreaId}
          onChange={(next) => set({ microAreaId: next })} />)}
      {at("refused", "refused", <YesNo label="A pessoa recusou o cadastro" value={draft.refused} onChange={(next) => set({ refused: next === true })} />)}

      <Title>Endereço</Title>
      {at("zip", "address.zip", <Field label="CEP" value={draft.address.zip} keyboardType="number-pad" onChangeText={(zip) => setAddress({ zip })} />)}
      {at("street_type", "address.street_type",
        <Choice label="Tipo de logradouro" options={streetTypes} value={draft.address.street_type} onChange={(next) => setAddress({ street_type: next })} />)}
      {at("street", "address.street", <Field label="Logradouro" value={draft.address.street} onChangeText={(street) => setAddress({ street })} />)}
      {at("number", "address.number", (
        <>
          <Field label="Número" value={draft.address.number} onChangeText={(number) => setAddress({ number })} />
          <YesNo label="Sem número" value={draft.address.no_number} onChange={(next) => setAddress({ no_number: next === true })} />
        </>
      ))}
      {at("complement", "address.complement", <Field label="Complemento" value={draft.address.complement} onChangeText={(complement) => setAddress({ complement })} />)}
      {at("neighborhood_id", "address.neighborhood_id",
        <Choice label="Bairro" options={reference.neighborhoods.map((n) => ({ code: n.id, label: n.name }))} value={draft.address.neighborhood_id}
          onChange={(next) => setAddress({ neighborhood_id: next })} />)}
      {at("district", "address.district", <Field label="Bairro (se não está na lista)" value={draft.address.district} onChangeText={(district) => setAddress({ district })} />)}
      {at("reference", "address.reference", <Field label="Ponto de referência" value={draft.address.reference} onChangeText={(reference_) => setAddress({ reference: reference_ })} />)}

      <Title>Imóvel</Title>
      {at("property_type", "property_type",
        <Choice label="Tipo de imóvel" options={propertyTypes} value={draft.propertyType} onChange={(next) => set({ propertyType: next })} />)}
      {at("contact_phone", "contact_phone",
        <Field label="Telefone de contato (com DDD)" value={draft.phone} keyboardType="phone-pad" onChangeText={(phone) => set({ phone })} />)}

      {livingAsked && (
        <>
          <Title>Condições de moradia</Title>
          <SectionFields section="living_conditions" dict={reference.dictionaries} values={draft.living} problem={problem}
            show={(key) => rules.livingFieldAllowed(type, key.split(".")[0])} onChange={(living) => set({ living })} />
        </>
      )}

      <Title>Ponto do imóvel</Title>
      <Body>{pointText(shownLocation)}</Body>
      <Button label={locating ? "Pegando a posição…" : "Usar o GPS aqui na frente"} variant="secondary" disabled={locating} onPress={() => { void readGps(); }} />
      <Button label="Marcar no mapa" variant="secondary" onPress={() => setPicking(true)} />
      {shownLocation !== null && <Button label="Tirar o ponto" variant="secondary" onPress={() => set({ location: null })} />}

      {notice !== null && <Notice tone="warn">{notice}</Notice>}
      {general !== null && <Notice tone="down">{general}</Notice>}
      {/* A marked point adds "Tirar o ponto" above the button and pushes it down — on a tablet, under the taskbar. */}
      <InSightAfter after={draft.location}>
        <Button label={saving ? "Salvando…" : "Salvar"} disabled={saving} onPress={() => { void save(); }} />
      </InSightAfter>
    </Screen>
    </View>
    {picking && (
      <View style={StyleSheet.absoluteFill}>
        <MapScreen Canvas={map.Canvas} readHead={map.readHead}
          pick={{ onPicked: (at) => { set({ location: mapTapLocation(at.latitude, at.longitude, at.zoom) }); setNotice(null); setPicking(false); } }} />
      </View>
    )}
    </View>
  );
}
