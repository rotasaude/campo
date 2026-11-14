import { useLocalSearchParams, useRouter } from "expo-router";
import { HouseholdScreen } from "../../../../src/features/households/HouseholdScreen";

// The routes carry local keys and ids only: never a name, a document or an address.
export default function HouseholdRoute() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  return (
    <HouseholdScreen householdKey={key}
      onEdit={() => router.push({ pathname: "/households/[key]/edit", params: { key } })}
      onNewFamily={() => router.push({ pathname: "/families/new", params: { household: key } })}
      onNewResident={() => router.push({ pathname: "/registrations/new", params: { household: key } })}
      onOpenResident={(registration) => router.push({ pathname: "/registrations/[key]/edit", params: { key: registration } })}
      onStartVisit={(start) => router.push({
        pathname: "/visits/new",
        params: { patient_id: start.patient_id, household_id: start.household_id ?? "", family_id: start.family_id ?? "", micro_area_id: start.micro_area_id },
      })} />
  );
}
