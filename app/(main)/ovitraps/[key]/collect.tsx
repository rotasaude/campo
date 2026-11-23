import { useLocalSearchParams, useRouter } from "expo-router";
import { CollectForm } from "../../../../src/features/ovitraps/CollectForm";

// The ovitrap comes by its local key only.
export default function CollectOvitrapRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <CollectForm ovitrapKey={key} onSaved={() => router.back()} />;
}
