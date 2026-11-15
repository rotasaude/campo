import { useLocalSearchParams, useRouter } from "expo-router";
import { ConflictScreen } from "../../../src/features/conflicts/ConflictScreen";

export default function ConflictRoute() {
  const router = useRouter();
  const { seq } = useLocalSearchParams<{ seq: string }>();
  return <ConflictScreen seq={Number(seq)} onDone={() => router.back()} />;
}
