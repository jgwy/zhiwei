import { getActivitiesSince } from "@zhiwei/core";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode } from "@/lib/no-db-store";

const encoder = new TextEncoder();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (isNoDbMode()) {
    return new Response(": no-db mode\n\n", {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  }
  const userId = await getSessionUserId();
  const url = new URL(request.url);
  let cursor = url.searchParams.get("since") ?? new Date(Date.now() - 5_000).toISOString();
  const stream = new ReadableStream({
    async start(controller) {
      let heartbeats = 0;
      while (!request.signal.aborted && heartbeats < 600) {
        const events = await getActivitiesSince(userId, cursor);
        for (const event of events) {
          cursor = new Date(event.created_at).toISOString();
          controller.enqueue(
            encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        }
        if (!events.length) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        heartbeats += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      controller.close();
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
