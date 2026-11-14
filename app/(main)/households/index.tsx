import { useRouter } from "expo-router";
import { HouseholdList } from "../../../src/features/households/HouseholdList";

export default function HouseholdsRoute() {
  const router = useRouter();
  return <HouseholdList onOpen={(key) => router.push({ pathname: "/households/[key]", params: { key } })} onNew={() => router.push("/households/new")} />;
}
