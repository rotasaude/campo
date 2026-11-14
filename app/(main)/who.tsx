import { useRouter } from "expo-router";
import { WhoScreen } from "../../src/features/who/WhoScreen";

// The visit form (Task 20) reads who and where from the route's parameters: ids only.
export default function WhoRoute() {
  const router = useRouter();
  return (
    <WhoScreen onStartVisit={(start) => router.push({
      pathname: "/visits/new",
      params: { patient_id: start.patient_id, household_id: start.household_id ?? "", family_id: start.family_id ?? "", micro_area_id: start.micro_area_id },
    })} />
  );
}
