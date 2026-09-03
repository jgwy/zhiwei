import { getActivitiesAfter } from "@zhiwei/core";
import { getSessionUserId } from "@/lib/session";

const encoder = new TextEncoder();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = await getSessionUserId();
  const url = new URL(request.url);
  let cursorTime = url.searchParams.get("since") ?? new Date(Date.now() - 30_000).toISOString();
  let cursorId: string | null = request.headers.get("last-event-id");
  const stream = new ReadableStream({
    async start(controller) {
      let heartbeats = 0;
      while (!request.signal.aborted && heartbeats < 600) {
        const events = await getActivitiesAfter(userId, { since: cursorTime, afterId: cursorId });
        for (const event of events) {
          cursorTime = new Date(event.created_at).toISOString();
          cursorId = event.id;
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
