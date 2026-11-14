/**
 * The only place that writes logs. No personal data ever: only the event name
 * and the fields below (item uuid, type, code, sequence, HTTP status).
 */
export type LogEvent =
  | "sync.round.start"
  | "sync.round.end"
  | "sync.item.result"
  | "map.download.failed";

export type LogFields = {
  client_uuid?: string;
  type?: string;
  code?: string;
  seq?: number;
  status?: number;
};

const ALLOWED = ["client_uuid", "type", "code", "seq", "status"] as const;

export function log(event: LogEvent, fields: LogFields = {}): void {
  const line: Record<string, unknown> = { event };
  for (const key of ALLOWED) {
    if (fields[key] !== undefined) line[key] = fields[key];
  }
  console.log(JSON.stringify(line));
}
