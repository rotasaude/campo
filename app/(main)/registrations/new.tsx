import { useLocalSearchParams, useRouter } from "expo-router";
import { RegistrationForm } from "../../../src/features/registrations/RegistrationForm";

// The route says where the person will live — keys and ids only.
export default function NewRegistrationRoute() {
  const router = useRouter();
  const { household, family } = useLocalSearchParams<{ household: string; family?: string }>();
  return <RegistrationForm householdKey={household} familyId={family ? family : null} onSaved={() => router.back()} />;
}
