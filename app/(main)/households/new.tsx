import { useRouter } from "expo-router";
import { useApp } from "../../../src/app/AppRoot";
import { HouseholdForm } from "../../../src/features/households/HouseholdForm";

// Saved: the new household's own screen takes the place of the form.
export default function NewHouseholdRoute() {
  const router = useRouter();
  const { map, back } = useApp();
  return <HouseholdForm map={map} back={back} onSaved={(key) => router.replace({ pathname: "/households/[key]", params: { key } })} />;
}
