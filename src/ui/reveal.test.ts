import { scrollIntoView, type Measurable, type Scrollable } from "./reveal";

// A scroll area and something inside it, 1200 dp down its content.
function scene(y: number) {
  const inner = { inner: true };
  const scrolled: { y: number; animated: boolean }[] = [];
  const scroll: Scrollable = { getInnerViewRef: () => inner, scrollTo: (to) => { scrolled.push(to); } };
  const measuredAgainst: unknown[] = [];
  const node: Measurable = { measureLayout: (relativeTo, onSuccess) => { measuredAgainst.push(relativeTo); onSuccess(0, y, 300, 20); } };
  return { inner, scroll, node, scrolled, measuredAgainst };
}

test("brings a node into sight: its place in the content, less the margin that keeps what is above it visible", () => {
  const t = scene(1200);
  scrollIntoView(t.scroll, t.node, 144);
  expect(t.measuredAgainst).toEqual([t.inner]);
  expect(t.scrolled).toEqual([{ y: 1056, animated: true }]);
});

test("near the top it scrolls to the top, never above it", () => {
  const t = scene(60);
  scrollIntoView(t.scroll, t.node, 144);
  expect(t.scrolled).toEqual([{ y: 0, animated: true }]);
});

test("with nothing to measure or nothing to scroll it does nothing, and a measure that fails moves nothing", () => {
  const t = scene(1200);
  scrollIntoView(null, t.node, 144);
  scrollIntoView(t.scroll, null, 144);
  scrollIntoView({ ...t.scroll, getInnerViewRef: () => null }, t.node, 144);
  scrollIntoView(t.scroll, { measureLayout: (_relativeTo, _onSuccess, onFail) => { onFail?.(); } }, 144);
  expect(t.scrolled).toEqual([]);
});
