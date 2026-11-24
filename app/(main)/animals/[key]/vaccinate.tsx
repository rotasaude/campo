import { useLocalSearchParams, useRouter } from "expo-router";
import { VaccinateForm } from "../../../../src/features/animals/VaccinateForm";

// The animal by its local key only (the server id, or the creation's client_uuid).
export default function VaccinateAnimalRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <VaccinateForm animalKey={key} onSaved={() => router.back()} />;
}
