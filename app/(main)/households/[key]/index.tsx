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
      onEditFamily={(id) => router.push({ pathname: "/families/[id]/edit", params: { id, household: key } })}
      onNewResident={(family) => router.push({ pathname: "/registrations/new", params: { household: key, family: family ?? "" } })}
      onOpenResident={(registration) => router.push({ pathname: "/registrations/[key]/edit", params: { key: registration } })}
      onInstallOvitrap={() => router.push({ pathname: "/ovitraps/new", params: { household: key } })}
      onNewAnimal={() => router.push({ pathname: "/animals/new", params: { household: key } })}
      onEditAnimal={(animal) => router.push({ pathname: "/animals/[key]/edit", params: { key: animal } })}
      onStartPropertyVisit={(params) => router.push({ pathname: "/visits/new", params: { ...params } })}
      onStartVisit={(start) => router.push({
        pathname: "/visits/new",
        params: { patient_id: start.patient_id, household_id: start.household_id ?? "", family_id: start.family_id ?? "", micro_area_id: start.micro_area_id },
      })} />
  );
}
