// The bulletin's start as the visit route (app/(main)/visits/new.tsx) reads it from its params, which come from the lists
// of what to visit and from the property's detail (35a): activity, work type and the link. A value the app does not
// know is left out (the form offers the choice). Here, and not in the route, so that the specs go through it.
import type { VectorActivity, VectorWorkType } from "../../rules/vectorDomains";
import type { VectorStart } from "../../rules/vectorInspection";

const ACTIVITIES: readonly string[] = ["li", "li_t", "pe", "ie", "transmission_block", "liraa"];
const WORK_TYPES: readonly string[] = ["routine", "pending"];

export function vectorStart(p: { vector_activity?: string; work_type?: string; liraa_draw_item_id?: string; transmission_block_id?: string }): VectorStart | undefined {
  const start: VectorStart = {
    ...(p.vector_activity && ACTIVITIES.includes(p.vector_activity) ? { activity: p.vector_activity as VectorActivity } : {}),
    ...(p.work_type && WORK_TYPES.includes(p.work_type) ? { workType: p.work_type as VectorWorkType } : {}),
    ...(p.liraa_draw_item_id ? { liraaDrawItemId: p.liraa_draw_item_id } : {}),
    ...(p.transmission_block_id ? { transmissionBlockId: p.transmission_block_id } : {}),
  };
  return Object.keys(start).length > 0 ? start : undefined;
}
