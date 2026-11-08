import { installNodeGatewayBridge } from "./gateway-bridge.js";
import { subscribeOpenClawEvents } from "./sse-bus.js";

installNodeGatewayBridge();

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

      const unsubscribe = subscribeOpenClawEvents(event => {
        if (
          "visibility" in event &&
          event.visibility === "personal" &&
          event.ownerUserId &&
          user.id &&
          event.ownerUserId !== user.id
        ) {
          return;
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
          clearInterval(heartbeat);
        }
      }, 15_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
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
