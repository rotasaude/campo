import { useLocalSearchParams, useRouter } from "expo-router";
import { useApp } from "../../../../src/app/AppRoot";
import { HouseholdForm } from "../../../../src/features/households/HouseholdForm";

export default function EditHouseholdRoute() {
  const router = useRouter();
  const { map } = useApp();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <HouseholdForm householdKey={key} map={map} onSaved={() => router.back()} />;
}
