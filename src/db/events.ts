// Who changed which table: the repositories emit after a commit and the
// screens re-read. No payload — the reader goes back to the database.
import { useEffect, useState } from "react";
import { useServices } from "../app/services";
import type { Db } from "./types";

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export const dbEvents = {
  emit(table: string): void {
    for (const listener of [...(listeners.get(table) ?? [])]) listener();
  },
  on(table: string, listener: Listener): () => void {
    const set = listeners.get(table) ?? new Set<Listener>();
    listeners.set(table, set);
    set.add(listener);
    return () => { set.delete(listener); };
  },
};

// Reads now and again whenever one of `tables` changes. `read` must be stable
// (useCallback) or the hook re-reads on every render. An answer that arrives
// after a newer read started is dropped.
export function useLive<T>(tables: string[], read: (db: Db) => Promise<T>): T | undefined {
  const { db } = useServices();
  const [value, setValue] = useState<T | undefined>(undefined);
  const key = tables.join(",");

  useEffect(() => {
    let turn = 0;
    let alive = true;
    const load = () => {
      const mine = ++turn;
      read(db).then((next) => { if (alive && mine === turn) setValue(next); }).catch(() => undefined);
    };
    load();
    const stops = key.split(",").filter(Boolean).map((table) => dbEvents.on(table, load));
    return () => { alive = false; for (const stop of stops) stop(); };
  }, [db, key, read]);

  return value;
}
