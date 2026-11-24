import { useRouter } from "expo-router";
import { CollarsDueScreen } from "../../../src/features/animals/CollarsDueScreen";

export default function CollarsRoute() {
  const router = useRouter();
  return <CollarsDueScreen onOpen={(key) => router.push({ pathname: "/households/[key]", params: { key } })} />;
}
