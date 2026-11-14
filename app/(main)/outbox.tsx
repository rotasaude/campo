import { useRouter } from "expo-router";
import { OutboxScreen } from "../../src/features/outbox/OutboxScreen";

export default function OutboxRoute() {
  const router = useRouter();
  return <OutboxScreen onFix={(seq) => router.push(`/attention/${seq}`)} onResolve={(seq) => router.push(`/conflicts/${seq}`)} />;
}
