import { useLocalSearchParams, useRouter } from "expo-router";
import { AnimalForm } from "../../../src/features/animals/AnimalForm";

// The household comes by its local key only.
export default function NewAnimalRoute() {
  const router = useRouter();
  const { household } = useLocalSearchParams<{ household: string }>();
  return <AnimalForm householdKey={household} onSaved={() => router.back()} />;
}
