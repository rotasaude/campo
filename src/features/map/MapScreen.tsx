// The city map, offline: the households of the agent's micro-areas as points
// coloured by what there is to do today. Two uses: looking (touch a household
// to open it) and marking the point of a household (touch the map, confirm).
// The agent's own position is read only when they ask for it, and stays on
// this screen: it is not stored, sent or logged.
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { captureGps } from "../../location/capture";
import type { MapCanvasProps, MapPoint, MapTap } from "../../map/canvas";
import { mapUri } from "../../map/download";
import type { HouseholdStatus } from "../../map/householdLayer";
import { PMTILES_HEADER_BYTES, pmtilesBounds, type MapBounds } from "../../map/pmtilesHeader";
import { MAP_ASSET_PATHS, buildStyle } from "../../map/style";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Notice, Screen, Title } from "../../ui/components";
import { MAP_TABLES, loadMapData } from "./mapData";

export const NO_MAP = "Mapa ainda não baixado";
export const NO_MAP_HINT = "O mapa chega com a sincronização, pelo Wi-Fi. Os cadastros e as visitas funcionam sem ele.";
export const NO_FIX = "Sem posição precisa. Vá para um lugar aberto e toque de novo.";
export const ATTRIBUTION = "© OpenStreetMap";
export const PICK_TITLE = "Marcar o ponto do imóvel";
export const PICK_HINT = "Toque no mapa, em cima do imóvel.";
// Close enough to tell one house from the next.
const MY_POSITION_ZOOM = 17;

const LEGEND: [HouseholdStatus, string][] = [["to_visit", "A visitar"], ["visited_today", "Visitado hoje"], ["registered", "Cadastrado"]];

export interface MapScreenProps {
  Canvas: ComponentType<MapCanvasProps>;
  readHead(uri: string, bytes: number): Promise<Uint8Array>;
  // Marking mode: the caller receives the point the person confirmed.
  pick?: { onPicked(at: MapTap): void };
  onOpenHousehold?(key: string): void;
}

export function MapScreen({ Canvas, readHead, pick, onOpenHousehold }: MapScreenProps) {
  const { colors, dark } = useTheme();
  const { fs, location, now } = useServices();
  const read = useCallback((db: Db) => loadMapData(db, now()), [now]);
  const data = useLive(MAP_TABLES, read);

  // undefined: the head of the file was not read yet (the map waits for it, to open framed on the city).
  const [bounds, setBounds] = useState<MapBounds | null | undefined>(undefined);
  const [focus, setFocus] = useState<MapTap | null>(null);
  const [me, setMe] = useState<MapPoint | null>(null);
  const [picked, setPicked] = useState<MapTap | null>(null);
  const [locating, setLocating] = useState(false);
  const [noFix, setNoFix] = useState(false);

  const path = data?.file?.path ?? null;
  const fileUri = path === null ? null : fs.documentDirectory + path;
  useEffect(() => {
    if (fileUri === null) return undefined;
    let alive = true;
    readHead(fileUri, PMTILES_HEADER_BYTES).then(pmtilesBounds).catch(() => null).then((box) => { if (alive) setBounds(box); });
    return () => { alive = false; };
  }, [fileUri, readHead]);

  const mapStyle = useMemo(
    () => (path === null ? null : buildStyle(dark ? "dark" : "light", { pmtilesUri: mapUri({ path }, fs.documentDirectory), ...MAP_ASSET_PATHS })),
    [dark, fs.documentDirectory, path]);
  const palette = useMemo<MapCanvasProps["colors"]>(() => ({
    to_visit: colors.focus, visited_today: colors.ok, registered: colors.accent,
    cluster: colors.ink2, clusterText: colors.panel, outline: colors.panel, me: colors.info, picked: colors.down,
  }), [colors]);

  const findMe = async () => {
    setLocating(true);
    setNoFix(false);
    const fix = await captureGps(location);
    setLocating(false);
    if (fix === null) { setNoFix(true); return; }
    setMe({ latitude: fix.latitude, longitude: fix.longitude });
    setFocus({ latitude: fix.latitude, longitude: fix.longitude, zoom: MY_POSITION_ZOOM });
  };

  const title = pick ? PICK_TITLE : "Mapa";
  if (!data) return <Screen title={title}><Muted>Carregando…</Muted></Screen>;
  if (mapStyle === null) {
    return (
      <Screen title={title}>
        <Notice>{NO_MAP}</Notice>
        <Body>{NO_MAP_HINT}</Body>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: SIZES.pad, gap: 8 }}>
        <Title>{title}</Title>
        {pick && <Body>{PICK_HINT}</Body>}
        {noFix && <Notice tone="warn">{NO_FIX}</Notice>}
      </View>
      <View style={{ flex: 1 }}>
        {bounds !== undefined && (
          <Canvas mapStyle={mapStyle} points={data.points} colors={palette} bounds={bounds} focus={focus} me={me}
            picked={picked === null ? null : { latitude: picked.latitude, longitude: picked.longitude }}
            onPressMap={pick ? setPicked : undefined} onPressHousehold={pick ? undefined : onOpenHousehold} />
        )}
        {/* The map data's credit, always on screen while the map is. */}
        <View pointerEvents="none" style={{ position: "absolute", right: 8, bottom: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: colors.panel }}>
          <Text style={{ fontSize: 14, color: colors.ink2 }}>{ATTRIBUTION}</Text>
        </View>
      </View>
      <View style={{ padding: SIZES.pad, gap: SIZES.gap }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SIZES.gap }}>
          {LEGEND.map(([status, label]) => (
            <View key={status} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: palette[status], borderWidth: 2, borderColor: colors.rule2 }} />
              <Text style={{ fontSize: SIZES.small, color: colors.ink }}>{label}</Text>
            </View>
          ))}
        </View>
        <Button label={locating ? "Pegando a posição…" : "Minha posição"} variant="secondary" disabled={locating} onPress={() => { void findMe(); }} />
        {pick && <Button label="Usar este ponto" disabled={picked === null} onPress={() => { if (picked !== null) pick.onPicked(picked); }} />}
      </View>
    </View>
  );
}
