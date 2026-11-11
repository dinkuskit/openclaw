import { resolvePlaygroundVisitorHash } from "./playground-env.js";
import { subscribeOpenClawEvents } from "./sse-bus.js";

export const prerender = false;

interface EmDashAuthLocals {
  user?: {
    id?: string;
    email?: string;
    name?: string | null;
    role?: number;
    disabled?: boolean;
  } | null;
}

const EDITOR_ROLE = 40;

/** Open live streams allowed per playground visitor (or per user) in one isolate. */
export const MAX_STREAMS_PER_AUDIENCE = 4;
const OPEN_STREAMS_SYMBOL = Symbol.for("dinkuskit.openclaw.openStreams");

function openStreams(): Map<string, number> {
  const g = globalThis as Record<symbol, Map<string, number> | undefined>;
  return (g[OPEN_STREAMS_SYMBOL] ??= new Map());
}

export async function GET(context: {
  request: Request;
  url: URL;
  locals: EmDashAuthLocals;
}): Promise<Response> {
  const user = context.locals?.user;
  if (!user || user.disabled) {
    return Response.json(
      {
        success: false,
        error: { code: "NOT_AUTHENTICATED", message: "Authentication required" },
      },
      { status: 401 },
    );
  }
  if ((user.role ?? 0) < EDITOR_ROLE) {
    return Response.json(
      {
        success: false,
        error: { code: "FORBIDDEN", message: "Editor or Administrator role required" },
      },
      { status: 403 },
    );
  }

  const filterConversationId = context.url.searchParams.get("conversationId") ?? undefined;
  // Playground visitors all share one EmDash user, so they are told apart by
  // their playground session. Undefined on ordinary sites.
  const subscriberScope = await resolvePlaygroundVisitorHash({ request: context.request });

  // The client may have gone while the scope was resolved; no slot for it.
  if (context.request.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  // Each stream holds a bus listener and a heartbeat timer, so cap how many
  // one visitor (or user) can hold open at once.
  const audienceKey = subscriberScope ? `pg:${subscriberScope}` : `user:${user.id ?? "anonymous"}`;
  const streams = openStreams();
  if ((streams.get(audienceKey) ?? 0) >= MAX_STREAMS_PER_AUDIENCE) {
    return Response.json(
      {
        success: false,
        error: { code: "TOO_MANY_STREAMS", message: "Too many open OpenClaw streams. Close a tab; this one retries shortly." },
      },
      { status: 429, headers: { "Retry-After": "15" } },
    );
  }
  streams.set(audienceKey, (streams.get(audienceKey) ?? 0) + 1);
  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    const left = (streams.get(audienceKey) ?? 1) - 1;
    if (left > 0) streams.set(audienceKey, left);
    else streams.delete(audienceKey);
  };
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: openclaw\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // Stream already closed.
        }
      };

      send({
        type: "connected",
        conversationId: filterConversationId,
        timestamp: new Date().toISOString(),
      });

      const unsubscribe = subscribeOpenClawEvents((event, audienceScope) => {
        if (event.type !== "gateway_status" && audienceScope !== subscriberScope) {
          // Another playground visitor's event, or an unscoped event reaching a
          // playground visitor: fail closed.
          return;
        }
        if (event.type !== "gateway_status") {
          if (event.visibility === "shared") {
            // Explicitly shared thread or site-wide connection update
          } else if (
            event.visibility === "personal" &&
            Boolean(event.ownerUserId) &&
            Boolean(user.id) &&
            event.ownerUserId === user.id
          ) {
            // Addressed to the personal conversation owner
          } else if (
            event.type === "exec_approval_updated" &&
            !event.visibility &&
            !event.ownerUserId &&
            (user.role ?? 0) >= 50
          ) {
            // Unbound Gateway execution approvals are restricted to Site Administrators
          } else {
            // Fail closed when audience metadata is missing or belongs to another user
            return;
          }
        }
        if (
          filterConversationId &&
          "conversationId" in event &&
          event.conversationId &&
          event.conversationId !== filterConversationId
        ) {
          return;
        }
        send(event);
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          // The stream is gone: free its listener and slot too.
          cleanup?.();
        }
      }, 15_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        releaseSlot();
      };

      context.request.signal.addEventListener("abort", () => {
        cleanup?.();
        try {
          controller.close();
        } catch {
          // ignore
        }
      });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
