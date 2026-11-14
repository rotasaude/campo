import { useLocalSearchParams, useRouter } from "expo-router";
import { FamilyForm } from "../../../src/features/families/FamilyForm";

export default function NewFamilyRoute() {
  const router = useRouter();
  const { household } = useLocalSearchParams<{ household: string }>();
  return <FamilyForm householdKey={household} onSaved={() => router.back()} />;
}
