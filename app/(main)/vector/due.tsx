import { useRouter } from "expo-router";
import { DueScreen } from "../../../src/features/vector/DueScreen";

// The visit form reads the household's local key and the bulletin's start from the route: ids and codes only.
export default function DueRoute() {
  const router = useRouter();
  return <DueScreen onStartVisit={(params) => router.push({ pathname: "/visits/new", params: { ...params } })} />;
}
