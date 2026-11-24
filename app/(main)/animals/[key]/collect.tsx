import { useLocalSearchParams, useRouter } from "expo-router";
import { LeishCollectForm } from "../../../../src/features/animals/LeishCollectForm";

// The animal by its local key only (the server id, or the creation's client_uuid).
export default function CollectAnimalRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <LeishCollectForm animalKey={key} onSaved={() => router.back()} />;
}
