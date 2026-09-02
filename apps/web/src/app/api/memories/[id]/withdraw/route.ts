import {
  addActivity,
  callMemoryMcp,
  compileContext,
  defaultPersonalSkill,
  getActiveMemories,
  getActiveSkill,
  getLatestProfile,
  withdrawMemory,
} from "@zhiwei/core";
import { getModelAdapter } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({ reason: z.string().max(300).optional() });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getSessionUserId();
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json().catch(() => ({})));
    const withdrawal = await withdrawMemory({ userId, memoryId: id, reason: input.reason });
    const [memories, profile, activeSkill] = await Promise.all([
      getActiveMemories(userId),
      getLatestProfile(userId),
      getActiveSkill(userId),
    ]);
    const adapter = getModelAdapter();
    const syntheticMessageId = crypto.randomUUID();
    const reflection = await adapter.reflect({
      userId,
      conversationId: crypto.randomUUID(),
      messageId: syntheticMessageId,
      content: "用户撤回了一条记忆，请仅依据剩余活动记忆重建画像。",
      kind: "chat",
      context: compileContext({
        foundationInstructions: composeFoundationInstructions([
          "profile-synthesis",
          "privacy-and-withdrawal",
        ]),
        personalSkill: activeSkill?.content ?? defaultPersonalSkill,
        profile,
        memories,
        sessionSummary: null,
        messages: [],
        maxInputTokens: 8_000,
      }),
    });
    await callMemoryMcp({
      tool: "profile_commit_snapshot",
      userId,
      arguments: {
        summary: reflection.profileSummary,
        dimensionWeights: reflection.dimensionWeights,
      },
    });
    await addActivity({ userId, type: "memory.withdrawn", payload: withdrawal });
    return NextResponse.json({ withdrawn: true, ...withdrawal });
  } catch (error) {
    return jsonError(error, 400);
  }
}
