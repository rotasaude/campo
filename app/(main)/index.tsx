import { useRouter } from "expo-router";
import { HomeScreen } from "../../src/features/home/HomeScreen";

export default function HomeRoute() {
  const router = useRouter();
  return <HomeScreen onOpenWho={() => router.push("/who")} onOpenToday={() => router.push("/visits/today")} onOpenDue={() => router.push("/vector/due")} onOpenOvitraps={() => router.push("/ovitraps")} onNewActivity={() => router.push("/activities/new")} onOpenHouseholds={() => router.push("/households")} onOpenMap={() => router.push("/map")} onOpenOutbox={() => router.push("/outbox")} onOpenAbout={() => router.push("/about")} />;
}
