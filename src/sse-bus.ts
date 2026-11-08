import type { OpenClawStreamEvent } from "./protocol.js";

type Listener = (event: OpenClawStreamEvent) => void;

const BUS_SYMBOL = Symbol.for("dinkuskit.openclaw.sseBus");

interface BusState {
  listeners: Set<Listener>;
}

function getBusState(): BusState {
  const g = globalThis as Record<symbol, BusState | undefined>;
  if (!g[BUS_SYMBOL]) {
    g[BUS_SYMBOL] = { listeners: new Set() };
  }
  return g[BUS_SYMBOL]!;
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
