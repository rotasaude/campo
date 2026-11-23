import { useRouter } from "expo-router";
import { OvitrapList } from "../../../src/features/ovitraps/OvitrapList";

// The routes carry local keys only: never a name or an address.
export default function OvitrapsRoute() {
  const router = useRouter();
  return <OvitrapList onCollect={(key) => router.push({ pathname: "/ovitraps/[key]/collect", params: { key } })} />;
}
