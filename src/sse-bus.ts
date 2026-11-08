import type { OpenClawStreamEvent } from "./protocol.js";

type Listener = (event: OpenClawStreamEvent) => void;

const BUS_SYMBOL = Symbol.for("dinkuskit.openclaw.sseBus");

interface BusState {
  listeners: Set<Listener>;
  locks: Map<string, Promise<void>>;
}

function getBusState(): BusState {
  const g = globalThis as Record<symbol, BusState | undefined>;
  if (!g[BUS_SYMBOL]) {
    g[BUS_SYMBOL] = { listeners: new Set(), locks: new Map() };
  } else if (!g[BUS_SYMBOL]!.locks) {
    g[BUS_SYMBOL]!.locks = new Map();
  }
  return g[BUS_SYMBOL]!;
}

/**
 * Serializes read-modify-write storage mutations across concurrent requests
 * and routes (`/chat` and `/pair`) without holding locks across network I/O.
 */
export async function withOpenClawStorageLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { locks } = getBusState();
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = prev.then(() => current, () => current);
  locks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

export function publishOpenClawEvent(event: OpenClawStreamEvent): void {
  const { listeners } = getBusState();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Listener errors never break publisher turns.
    }
  }
}

export function subscribeOpenClawEvents(listener: Listener): () => void {
  const { listeners } = getBusState();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
