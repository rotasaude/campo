// Bringing something of a scrolling screen into sight. The measuring and the
// scrolling belong to the device; this file is the arithmetic between them,
// behind two small shapes so that it is tested without a device.

// What is kept in sight above the node, besides the status bar: the field a refusal is about is right above its sentence.
export const REVEAL_MARGIN = 120;

export interface Measurable {
  measureLayout(relativeTo: never, onSuccess: (x: number, y: number, width: number, height: number) => void, onFail?: () => void): void;
}
export interface Scrollable {
  // The view that holds the content: positions measured against it are positions in the content.
  getInnerViewRef(): unknown;
  scrollTo(to: { y: number; animated: boolean }): void;
}

export function scrollIntoView(scroll: Scrollable | null, node: Measurable | null, margin: number): void {
  const inner = scroll?.getInnerViewRef();
  if (!scroll || !node || !inner) return;
  node.measureLayout(inner as never, (_x, y) => scroll.scrollTo({ y: Math.max(0, y - margin), animated: true }), () => undefined);
}
