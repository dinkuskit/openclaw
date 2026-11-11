import type { OpenClawStreamEvent } from "./protocol.js";

/**
 * `audienceScope` is the playground visitor scope the event was published
 * under (see runWithOpenClawAudienceScope), or undefined outside a playground.
 */
type Listener = (event: OpenClawStreamEvent, audienceScope?: string) => void;

interface ScopeStorage {
  run<R>(store: string, fn: () => R): R;
  getStore(): string | undefined;
}

const BUS_SYMBOL = Symbol.for("dinkuskit.openclaw.sseBus");

interface BusState {
  listeners: Set<Listener>;
  locks: Map<string, Promise<void>>;
  scope?: ScopeStorage | null;
  warnedNoScope?: boolean;
}

function createScopeStorage(): ScopeStorage | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const mod = proc?.getBuiltinModule?.("node:async_hooks") as
      | { AsyncLocalStorage?: new () => ScopeStorage }
      | undefined;
    return mod?.AsyncLocalStorage ? new mod.AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}

function getScopeStorage(): ScopeStorage | null {
  const state = getBusState();
  if (state.scope === undefined) state.scope = createScopeStorage();
  return state.scope;
}

/**
 * Runs `fn` so every event it publishes (including from awaited work) is
 * tagged with `scope`. Playground hosts give every anonymous visitor the same
 * EmDash user, so the stream endpoint uses this scope to keep one visitor's
 * events away from another's. Without a scope this is a plain call.
 */
export function runWithOpenClawAudienceScope<R>(scope: string | undefined, fn: () => R): R {
  if (!scope) return fn();
  const storage = getScopeStorage();
  if (storage) return storage.run(scope, fn);
  // No AsyncLocalStorage: events stay unscoped, and scoped subscribers drop
  // unscoped events, so this fails closed (no cross-visitor delivery), but
  // live streaming is off for playground visitors. Say so once.
  const state = getBusState();
  if (!state.warnedNoScope) {
    state.warnedNoScope = true;
    console.warn(
      "[openclaw] AsyncLocalStorage is unavailable (enable nodejs_compat); playground chat streaming is disabled to keep visitors apart.",
    );
  }
  return fn();
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

/**
 * `audienceScope`: pass a visitor scope, or null for "no scope", to override
 * the scope inherited from runWithOpenClawAudienceScope. Publishers whose
 * callbacks outlive the request that started them (gateway sockets) must pass
 * it explicitly.
 */
export function publishOpenClawEvent(
  event: OpenClawStreamEvent,
  audienceScope: string | null = getScopeStorage()?.getStore() ?? null,
): void {
  const { listeners } = getBusState();
  for (const listener of listeners) {
    try {
      listener(event, audienceScope ?? undefined);
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
