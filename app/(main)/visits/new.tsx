import { useLocalSearchParams, useRouter } from "expo-router";
import { VisitForm } from "../../../src/features/visits/VisitForm";
import type { VectorActivity, VectorWorkType } from "../../../src/rules/vectorDomains";
import type { VectorStart } from "../../../src/rules/vectorInspection";

const ACTIVITIES: readonly string[] = ["li", "li_t", "pe", "ie", "transmission_block", "liraa"];
const WORK_TYPES: readonly string[] = ["routine", "pending"];

// The bulletin's start from the lists of what to visit (35a): activity, work type and the link. A value the app does not
// know is left out (the form offers the choice).
function vectorStart(p: { vector_activity?: string; work_type?: string; liraa_draw_item_id?: string; transmission_block_id?: string }): VectorStart | undefined {
  const start: VectorStart = {
    ...(p.vector_activity && ACTIVITIES.includes(p.vector_activity) ? { activity: p.vector_activity as VectorActivity } : {}),
    ...(p.work_type && WORK_TYPES.includes(p.work_type) ? { workType: p.work_type as VectorWorkType } : {}),
    ...(p.liraa_draw_item_id ? { liraaDrawItemId: p.liraa_draw_item_id } : {}),
    ...(p.transmission_block_id ? { transmissionBlockId: p.transmission_block_id } : {}),
  };
  return Object.keys(start).length > 0 ? start : undefined;
}

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
