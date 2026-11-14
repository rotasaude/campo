import { useRouter } from "expo-router";
import { useApp } from "../../src/app/AppRoot";
import { MapScreen } from "../../src/features/map/MapScreen";

// The household screen (Task 18) reads which one from the route's parameter: its local key only.
export default function MapRoute() {
  const router = useRouter();
  const { map } = useApp();
  return <MapScreen Canvas={map.Canvas} readHead={map.readHead} onOpenHousehold={(key) => router.push({ pathname: "/households/[key]", params: { key } })} />;
}
