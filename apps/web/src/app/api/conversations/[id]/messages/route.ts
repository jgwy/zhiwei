import { getMessagePage, submitTurn } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { streamAcceptedTurn } from "@/lib/dialogue-service";

const InputSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
  clientRequestId: z.string().uuid().optional(),
});
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getSessionUserId();
    const { id } = await context.params;
    return NextResponse.json(
      await getMessagePage(
        userId,
        id,
        new URL(request.url).searchParams.get("before"),
      ),
    );
  } catch (error) {
    return jsonError(error, 400);
  }
}
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getSessionUserId();
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json());
    const turn = await submitTurn({ userId, conversationId: id, ...input });
    return streamAcceptedTurn(request, userId, id, turn);
  } catch (error) {
    console.error(
      "[messages]",
      error instanceof Error ? error.name : "request_failed",
    );
    return jsonError(error, 400);
  }
}
