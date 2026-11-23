// The outbox table as rows of the app. JSON columns are parsed here and
// nowhere else. Every write emits "outbox" so the screens re-read.
import type { ItemType } from "../../contract";
import type { ConflictField } from "../../sync/merge";
import { dbEvents } from "../events";
import type { Db, SqlParam } from "../types";

export type OutboxState = "pending" | "sending" | "needs_attention" | "conflict" | "blocked";
export interface Dep { client_uuid: string; kind: "cite" | "version" }
type Body = Record<string, unknown>;

export interface OutboxItem {
  seq: number; client_uuid: string; type: ItemType; body: Body; target_id: string | null;
  edit_base_version: number | null; edit_base_body: Body | null; depends_on: Dep[]; state: OutboxState;
  error: string | null; path: string | null; candidates: unknown[] | null; confirmable: boolean | null; conflicts: ConflictField[] | null;
  sent_version: number | null; attempts: number; created_at: string; updated_at: string;
}

interface Row {
  seq: number; client_uuid: string; type: string; body: string; target_id: string | null; edit_base_version: number | null;
  edit_base_body: string | null; depends_on: string; state: string; error: string | null; path: string | null; candidates: string | null;
  confirmable: number | null; conflicts: string | null; sent_version: number | null; attempts: number; created_at: string; updated_at: string;
}

const parse = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));
const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

function toItem(row: Row): OutboxItem {
  return {
    seq: row.seq, client_uuid: row.client_uuid, type: row.type as ItemType, body: JSON.parse(row.body) as Body, target_id: row.target_id,
    edit_base_version: row.edit_base_version, edit_base_body: parse<Body>(row.edit_base_body), depends_on: JSON.parse(row.depends_on) as Dep[],
    state: row.state as OutboxState, error: row.error, path: row.path, candidates: parse<unknown[]>(row.candidates),
    confirmable: row.confirmable === null ? null : row.confirmable === 1, conflicts: parse<ConflictField[]>(row.conflicts),
    sent_version: row.sent_version, attempts: row.attempts, created_at: row.created_at, updated_at: row.updated_at,
  };
}

const nowIso = () => new Date().toISOString();

export const outboxRepo = {
  async insert(db: Db, input: {
    clientUuid: string; type: ItemType; body: Body; targetId: string | null; editBase: { version: number; body: Body } | null; deps: Dep[]; at?: string;
  }): Promise<OutboxItem> {
    const at = input.at ?? nowIso();
    const result = await db.run(
      `INSERT INTO outbox (client_uuid, type, body, target_id, edit_base_version, edit_base_body, depends_on, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [input.clientUuid, input.type, JSON.stringify(input.body), input.targetId, input.editBase?.version ?? null,
        json(input.editBase?.body), JSON.stringify(input.deps), at, at]);
    dbEvents.emit("outbox");
    return (await this.bySeq(db, result.lastInsertRowId))!;
  },

  async all(db: Db): Promise<OutboxItem[]> {
    return (await db.all<Row>("SELECT * FROM outbox ORDER BY seq")).map(toItem);
  },
  async bySeq(db: Db, seq: number): Promise<OutboxItem | null> {
    const row = await db.get<Row>("SELECT * FROM outbox WHERE seq = ?", [seq]);
    return row ? toItem(row) : null;
  },
  async byClientUuid(db: Db, clientUuid: string): Promise<OutboxItem | null> {
    const row = await db.get<Row>("SELECT * FROM outbox WHERE client_uuid = ?", [clientUuid]);
    return row ? toItem(row) : null;
  },
  async count(db: Db): Promise<number> {
    return (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))?.n ?? 0;
  },

  // Only the named columns change; `updated_at` always does.
  async update(db: Db, seq: number, patch: Partial<{
    body: Body; state: OutboxState; error: string | null; path: string | null; candidates: unknown[] | null; confirmable: boolean | null;
    conflicts: ConflictField[] | null; sent_version: number | null; attempts: number; edit_base_version: number | null; edit_base_body: Body | null;
    depends_on: Dep[];
  }>): Promise<void> {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    const set = (column: string, value: SqlParam) => { sets.push(`${column} = ?`); params.push(value); };
    if ("body" in patch) set("body", JSON.stringify(patch.body));
    if ("state" in patch) set("state", patch.state!);
    if ("error" in patch) set("error", patch.error ?? null);
    if ("path" in patch) set("path", patch.path ?? null);
    if ("candidates" in patch) set("candidates", json(patch.candidates));
    if ("confirmable" in patch) set("confirmable", patch.confirmable === null || patch.confirmable === undefined ? null : patch.confirmable ? 1 : 0);
    if ("conflicts" in patch) set("conflicts", json(patch.conflicts));
    if ("sent_version" in patch) set("sent_version", patch.sent_version ?? null);
    if ("attempts" in patch) set("attempts", patch.attempts!);
    if ("edit_base_version" in patch) set("edit_base_version", patch.edit_base_version ?? null);
    if ("edit_base_body" in patch) set("edit_base_body", json(patch.edit_base_body));
    if ("depends_on" in patch) set("depends_on", JSON.stringify(patch.depends_on));
    set("updated_at", nowIso());
    await db.run(`UPDATE outbox SET ${sets.join(", ")} WHERE seq = ?`, [...params, seq]);
    dbEvents.emit("outbox");
  },

  // A new idempotency key for an item the server never accepted (35a, sample_label_taken): see features/visits/relabel.ts.
  async rekey(db: Db, seq: number, clientUuid: string): Promise<void> {
    await db.run("UPDATE outbox SET client_uuid = ?, updated_at = ? WHERE seq = ?", [clientUuid, nowIso(), seq]);
    dbEvents.emit("outbox");
  },

  async remove(db: Db, seq: number): Promise<void> {
    await db.run("DELETE FROM outbox WHERE seq = ?", [seq]);
    dbEvents.emit("outbox");
  },

  // client_uuid → id of everything that already left the queue (contract §6.3).
  async mapClientId(db: Db, clientUuid: string, type: ItemType, id: string): Promise<void> {
    await db.run("INSERT INTO client_ids (client_uuid, type, id) VALUES (?, ?, ?) ON CONFLICT (client_uuid) DO UPDATE SET id = excluded.id", [clientUuid, type, id]);
  },
  async mappedIds(db: Db): Promise<Map<string, string>> {
    const rows = await db.all<{ client_uuid: string; id: string }>("SELECT client_uuid, id FROM client_ids");
    return new Map(rows.map((row) => [row.client_uuid, row.id]));
  },
};
