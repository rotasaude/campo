import { useRouter } from "expo-router";
import { ActivityForm } from "../../../src/features/activities/ActivityForm";

export default function NewActivityRoute() {
  const router = useRouter();
  return <ActivityForm onSaved={() => router.back()} />;
}
