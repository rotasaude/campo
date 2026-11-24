import { useLocalSearchParams, useRouter } from "expo-router";
import { AnimalForm } from "../../../../src/features/animals/AnimalForm";

// The animal by its local key only (the server id, or the creation's client_uuid); its household comes with it.
export default function EditAnimalRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <AnimalForm animalKey={key} onSaved={() => router.back()} />;
}
