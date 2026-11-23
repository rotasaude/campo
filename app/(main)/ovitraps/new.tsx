import { useLocalSearchParams, useRouter } from "expo-router";
import { InstallForm } from "../../../src/features/ovitraps/InstallForm";

// The household comes by its local key only.
export default function NewOvitrapRoute() {
  const router = useRouter();
  const { household } = useLocalSearchParams<{ household: string }>();
  return <InstallForm householdKey={household} onSaved={() => router.replace("/ovitraps")} />;
}
