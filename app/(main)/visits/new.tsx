import { useLocalSearchParams, useRouter } from "expo-router";
import { VisitForm } from "../../../src/features/visits/VisitForm";
import { vectorStart } from "../../../src/features/visits/routeStart";

// Who and where come as ids and local keys only; the form reads the rest from the tablet.
export default function NewVisitRoute() {
  const router = useRouter();
  const { household_id, patient_id, family_id, vector_activity, work_type, liraa_draw_item_id, transmission_block_id } = useLocalSearchParams<{
    household_id?: string; patient_id?: string; family_id?: string;
    vector_activity?: string; work_type?: string; liraa_draw_item_id?: string; transmission_block_id?: string;
  }>();
  return (
    <VisitForm start={{
      householdKey: household_id || undefined, patientRef: patient_id || undefined, familyId: family_id || undefined,
      vector: vectorStart({ vector_activity, work_type, liraa_draw_item_id, transmission_block_id }),
    }}
      onSaved={() => router.replace("/visits/today")} />
  );
}
