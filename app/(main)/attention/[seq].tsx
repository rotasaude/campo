import { useLocalSearchParams, useRouter } from "expo-router";
import { AttentionScreen } from "../../../src/features/attention/AttentionScreen";

// "Corrigir" opens the form of the record the item edits; saving there puts the same item back in the line.
export default function AttentionRoute() {
  const router = useRouter();
  const { seq } = useLocalSearchParams<{ seq: string }>();
  return (
    <AttentionScreen seq={Number(seq)} onDone={() => router.back()}
      onOpenRegistration={(key) => router.replace({ pathname: "/registrations/[key]/edit", params: { key } })}
      onFix={(target) => {
        if (target.type === "household") router.push({ pathname: "/households/[key]/edit", params: { key: target.targetId } });
        else if (target.type === "individual_registration") router.push({ pathname: "/registrations/[key]/edit", params: { key: target.targetId } });
        else if (target.type === "animal") router.push({ pathname: "/animals/[key]/edit", params: { key: target.targetId } });
        else if (target.familyId !== null) router.push({ pathname: "/families/[id]/edit", params: { id: target.familyId, household: target.targetId } });
      }} />
  );
}
