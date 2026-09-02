import { addFeedback, enqueueJob } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  messageId: z.string().uuid(),
  value: z.enum(["understood", "not-me"]),
  reason: z.string().max(400).optional(),
});

export async function POST(request: Request) {
  try {
    const userId = await getSessionUserId();
    const input = InputSchema.parse(await request.json());
    const feedbackId = await addFeedback({ userId, ...input });
    const jobId = await enqueueJob({
      userId,
      type: "evolve_skill",
      payload: {
        evidenceIds: [input.messageId],
        feedback: input.value,
        feedbackReason: input.reason,
        traceId: crypto.randomUUID(),
      },
    });
    return NextResponse.json({ feedbackId, jobId });
  } catch (error) {
    return jsonError(error, 400);
  }
}

