// The map drawn by MapLibre Native (@maplibre/maplibre-react-native 11). Thin
// on purpose, like devicePlatform.tsx: what is shown is decided by the screen
// (src/features/map) and tested there; this file can only be proved on a
// device. Nothing here leaves the tablet — the style's source is the local
// PMTiles file, fonts and icons come from the APK.
import { Camera, GeoJSONSource, Layer, Map, type CameraRef, type MapRef, type StyleSpecification } from "@maplibre/maplibre-react-native";
import { useEffect, useMemo, useRef } from "react";
import type { MapCanvasProps, MapPoint } from "../map/canvas";

// A font of the map-style's own stacks: asking for a glyph range that has no file stops the whole map.
const COUNT_FONT = ["Noto Sans Medium"];
const HOUSEHOLDS = "households";

const pointOf = (at: MapPoint) => ({
  type: "FeatureCollection" as const,
  features: [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [at.longitude, at.latitude] }, properties: {} }],
});

export function MapLibreCanvas({ mapStyle, points, colors, bounds, focus, me, picked, onPressMap, onPressHousehold }: MapCanvasProps) {
  const map = useRef<MapRef>(null);
  const camera = useRef<CameraRef>(null);

  // The camera moves only when the screen gives a new place to go.
  useEffect(() => {
    if (focus !== null) camera.current?.easeTo({ center: [focus.longitude, focus.latitude], zoom: focus.zoom, duration: 600 });
  }, [focus]);

  // The first frame: the box the map file covers.
  const initial = useMemo(() => (bounds === null ? undefined : { bounds: [bounds.west, bounds.south, bounds.east, bounds.north] as [number, number, number, number] }), [bounds]);

  return (
    <Map ref={map} style={{ flex: 1 }} mapStyle={mapStyle as unknown as StyleSpecification} attribution={false} logo={false} touchRotate={false} touchPitch={false}
      onPress={onPressMap === undefined ? undefined : (event) => {
        const [longitude, latitude] = event.nativeEvent.lngLat;
        void map.current?.getZoom().then((zoom) => onPressMap({ latitude, longitude, zoom }));
      }}>
      <Camera ref={camera} initialViewState={initial} />
      <GeoJSONSource id={HOUSEHOLDS} data={points} cluster clusterRadius={44} clusterMaxZoom={15}
        onPress={(event) => {
          const feature = event.nativeEvent.features[0];
          if (!feature) return;
          // A group of households: come closer. One household: open it.
          if (feature.properties?.cluster) {
            const [longitude, latitude] = event.nativeEvent.lngLat;
            void map.current?.getZoom().then((zoom) => camera.current?.easeTo({ center: [longitude, latitude], zoom: zoom + 2, duration: 400 }));
          } else if (typeof feature.properties?.key === "string") {
            onPressHousehold?.(feature.properties.key);
          }
        }}>
        <Layer id="household-clusters" type="circle" filter={["has", "point_count"]}
          style={{ circleColor: colors.cluster, circleRadius: 20, circleStrokeWidth: 2, circleStrokeColor: colors.outline }} />
        <Layer id="household-cluster-count" type="symbol" filter={["has", "point_count"]}
          style={{ textField: ["to-string", ["get", "point_count"]], textFont: COUNT_FONT, textSize: 16, textColor: colors.clusterText, textAllowOverlap: true }} />
        <Layer id="household-points" type="circle" filter={["!", ["has", "point_count"]]}
          style={{
            circleColor: ["match", ["get", "status"], "visited_today", colors.visited_today, "to_visit", colors.to_visit, colors.registered],
            circleRadius: 10, circleStrokeWidth: 2, circleStrokeColor: colors.outline,
          }} />
      </GeoJSONSource>
      {me !== null && (
        <GeoJSONSource id="me" data={pointOf(me)}>
          <Layer id="me-point" type="circle" style={{ circleColor: colors.me, circleRadius: 8, circleStrokeWidth: 3, circleStrokeColor: colors.outline }} />
        </GeoJSONSource>
      )}
      {picked !== null && (
        <GeoJSONSource id="picked" data={pointOf(picked)}>
          <Layer id="picked-point" type="circle" style={{ circleColor: colors.picked, circleRadius: 12, circleStrokeWidth: 3, circleStrokeColor: colors.outline }} />
        </GeoJSONSource>
      )}
    </Map>
  );
}
