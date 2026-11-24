import { useLocalSearchParams, useRouter } from "expo-router";
import { CollarForm } from "../../../../src/features/animals/CollarForm";

// The animal by its local key only (the server id, or the creation's client_uuid).
export default function CollarAnimalRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <CollarForm animalKey={key} onSaved={() => router.back()} />;
}
