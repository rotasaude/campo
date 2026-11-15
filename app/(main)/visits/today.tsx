import { useRouter } from "expo-router";
import { TodayScreen } from "../../../src/features/visits/TodayScreen";

export default function TodayRoute() {
  const router = useRouter();
  return <TodayScreen onNewVisit={() => router.push("/visits/new")} />;
}
