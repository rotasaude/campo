import { useLocalSearchParams, useRouter } from "expo-router";
import { VisitForm } from "../../../src/features/visits/VisitForm";

// Who and where come as ids and local keys only; the form reads the rest from the tablet.
export default function NewVisitRoute() {
  const router = useRouter();
  const { household_id, patient_id, family_id } = useLocalSearchParams<{ household_id?: string; patient_id?: string; family_id?: string }>();
  return (
    <VisitForm start={{ householdKey: household_id || undefined, patientRef: patient_id || undefined, familyId: family_id || undefined }}
      onSaved={() => router.replace("/visits/today")} />
  );
}
