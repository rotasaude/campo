import { useRouter } from "expo-router";
import { HomeScreen } from "../../src/features/home/HomeScreen";

export default function HomeRoute() {
  const router = useRouter();
  return <HomeScreen onOpenWho={() => router.push("/who")} onOpenToday={() => router.push("/visits/today")} onOpenHouseholds={() => router.push("/households")} onOpenMap={() => router.push("/map")} onOpenOutbox={() => router.push("/outbox")} onOpenAbout={() => router.push("/about")} />;
}
