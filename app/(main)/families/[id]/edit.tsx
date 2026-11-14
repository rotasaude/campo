import { useLocalSearchParams, useRouter } from "expo-router";
import { FamilyForm } from "../../../../src/features/families/FamilyForm";

export default function EditFamilyRoute() {
  const router = useRouter();
  const { id, household } = useLocalSearchParams<{ id: string; household: string }>();
  return <FamilyForm householdKey={household} familyId={id} onSaved={() => router.back()} />;
}
