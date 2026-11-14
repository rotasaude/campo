import { useLocalSearchParams, useRouter } from "expo-router";
import { RegistrationForm } from "../../../../src/features/registrations/RegistrationForm";

export default function EditRegistrationRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return <RegistrationForm registrationKey={key} familyId={null} onSaved={() => router.back()} />;
}
