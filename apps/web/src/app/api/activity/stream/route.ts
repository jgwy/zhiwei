import { getActivitiesAfter, subscribeDatabase } from "@zhiwei/core";
import { getSessionUserId } from "@/lib/session";

const encoder = new TextEncoder();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = await getSessionUserId();
  const url = new URL(request.url);
  let cursorTime =
    url.searchParams.get("since") ??
    new Date(Date.now() - 30_000).toISOString();
  let cursorId: string | null = request.headers.get("last-event-id");
  const subscription = subscribeDatabase("zhiwei_activity", userId);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal]);
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!signal.aborted) {
          const changed = await subscription.wait(15_000, signal);
          if (signal.aborted) break;
          if (!changed) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            continue;
          }
          let more = true;
          while (more && !signal.aborted) {
            const events = await getActivitiesAfter(userId, {
              since: cursorTime,
              afterId: cursorId,
            });
            for (const event of events) {
              cursorTime = new Date(event.created_at).toISOString();
              cursorId = event.id;
              controller.enqueue(
                encoder.encode(
                  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
            }
            more = events.length === 100;
          }
        }
      } catch {
        /* A disconnected client no longer accepts SSE data. */
      } finally {
        subscription.close();
        try {
          controller.close();
        } catch {
          /* Already closed. */
        }
      }
    },
    cancel() {
      cancellation.abort();
      subscription.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
