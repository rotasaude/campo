// The tablet's clock is not trusted, and neither is its time zone. Every time
// the app writes (occurred_at) and every "today" it compares with come from
// the server's clock, as last seen in GET session (server_time), in the
// city's offset. A difference above 5 minutes is also shown to the person.
export const SKEW_WARN_MS = 5 * 60_000;

// Positive: the tablet is behind the server. `deviceNowAtResponse`: the tablet's clock when the session answer arrived.
export function measureSkew(serverTime: string, deviceNowAtResponse: number): number {
  const server = Date.parse(serverTime);
  if (Number.isNaN(server)) throw new Error("server_time inválido");
  return server - deviceNowAtResponse;
}

export function needsClockWarning(skewMs: number): boolean {
  return Math.abs(skewMs) > SKEW_WARN_MS;
}

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

// The city's offset in minutes, from the suffix of server_time ("Z" or "±hh:mm").
export function cityOffsetMinutes(serverTime: string): number {
  const suffix = OFFSET.exec(serverTime)?.[1];
  if (suffix === undefined || Number.isNaN(Date.parse(serverTime))) throw new Error("server_time sem fuso");
  if (suffix === "Z") return 0;
  const sign = suffix.startsWith("-") ? -1 : 1;
  return sign * (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6)));
}

const two = (n: number) => String(n).padStart(2, "0");

// "2026-11-13T09:15:00-03:00": the corrected instant, written in the city's offset, whole seconds.
export function cityNowIso(deviceNow: number, skewMs: number, offsetMin: number): string {
  // Shifted so the UTC getters read the city's wall clock.
  const wall = new Date(deviceNow + skewMs + offsetMin * 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${wall.getUTCFullYear()}-${two(wall.getUTCMonth() + 1)}-${two(wall.getUTCDate())}`
    + `T${two(wall.getUTCHours())}:${two(wall.getUTCMinutes())}:${two(wall.getUTCSeconds())}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

// The city's day (AAAA-MM-DD): what "today", the minimum date and the daily sheet compare with.
export function cityToday(deviceNow: number, skewMs: number, offsetMin: number): string {
  return cityNowIso(deviceNow, skewMs, offsetMin).slice(0, 10);
}

// An instant as the city reads it: "14/11/2026 09:30" and "14/11/2026". Null when there is nothing to show.
export function formatCityDateTime(iso: string | null, offsetMin: number): string | null {
  const at = iso === null ? NaN : Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const local = cityNowIso(at, 0, offsetMin);
  return `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} ${local.slice(11, 16)}`;
}
export function formatCityDate(iso: string | null, offsetMin: number): string | null {
  return formatCityDateTime(iso, offsetMin)?.slice(0, 10) ?? null;
}
