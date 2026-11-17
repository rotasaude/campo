// The PIN is asked when the app opens and after 5 minutes in the background.
export const LOCK_AFTER_MS = 5 * 60_000;

// A moment read on two clocks (campo#2): `wall` is the tablet's clock, which anybody can change; `mono` is the
// process's clock, which only goes forward but may stand still while the tablet sleeps. Each one covers the other.
export interface Instant { wall: number; mono: number }

// `backgroundedAt`: when the app left the foreground; null on a cold start.
// Five minutes on either clock lock, and so does either clock going backwards.
export function shouldLock(backgroundedAt: Instant | null, now: Instant): boolean {
  if (backgroundedAt === null) return true;
  const wall = now.wall - backgroundedAt.wall;
  const mono = now.mono - backgroundedAt.mono;
  return wall < 0 || mono < 0 || Math.max(wall, mono) >= LOCK_AFTER_MS;
}

// Whether a sync may run now. The PIN is asked when the app comes back, but a tablet left in the background past the
// limit already owes it: from then on nothing is read from or sent to the server, even before anybody looks at it.
export function syncLocked(unlocked: boolean, backgroundedAt: Instant | null, now: Instant): boolean {
  return !unlocked || (backgroundedAt !== null && shouldLock(backgroundedAt, now));
}
