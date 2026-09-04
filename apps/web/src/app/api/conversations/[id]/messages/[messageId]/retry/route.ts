import { retryTurn } from "@zhiwei/core";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { streamAcceptedTurn } from "@/lib/dialogue-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const userId = await getSessionUserId();
    const { id, messageId } = await context.params;
    const turn = await retryTurn(userId, id, messageId);
    return streamAcceptedTurn(request, userId, id, turn, true);
  } catch (error) {
    return jsonError(error, 409);
  }
}
