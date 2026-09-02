import {
  checkAtomicClaims,
  compileContext,
  createBenchmarkRun,
  defaultPersonalSkill,
  getActiveMemories,
  getActiveSkill,
  getLatestProfile,
  type BenchmarkMode,
  type BenchmarkOutput,
} from "@zhiwei/core";
import { getModelAdapter } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  scenario: z.string().trim().min(1).max(100).default("太阳耀斑课程讲稿"),
});

export async function POST(request: Request) {
  try {
    if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
    const userId = await getSessionUserId();
    const input = InputSchema.parse(await request.json());
    const adapter = getModelAdapter();
    const [profile, memories, activeSkill] = await Promise.all([
      getLatestProfile(userId),
      getActiveMemories(userId),
      getActiveSkill(userId),
    ]);
    const foundation = composeFoundationInstructions([
      "zhiwei-persona",
      "dialogue-orchestrator",
      "fact-and-tool-use",
      "risk-and-boundary",
      "privacy-and-withdrawal",
    ]);
    const modes: BenchmarkMode[] = ["direct", "profile", "adaptive"];
    const outputs: BenchmarkOutput[] = [];
    for (const mode of modes) {
      const context = compileContext({
        foundationInstructions: mode === "direct" ? "" : foundation,
        personalSkill:
          mode === "adaptive" ? activeSkill?.content ?? defaultPersonalSkill : defaultPersonalSkill,
        profile: mode === "direct" ? null : profile,
        memories: mode === "direct" ? [] : memories,
        sessionSummary: null,
        messages: [],
        maxInputTokens: 18_000,
      });
      const started = Date.now();
      let content = "";
      for await (const delta of adapter.streamDialogue({
        userId,
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        content: input.prompt,
        context,
        benchmarkMode: mode,
      })) content += delta;
      outputs.push({
        mode,
        content,
        claims: checkAtomicClaims(content),
        latencyMs: Date.now() - started,
        estimatedTokens: Math.ceil((context.estimatedTokens + content.length) / 2.4),
      });
    }
    const run = await createBenchmarkRun({
      userId,
      prompt: input.prompt,
      scenario: input.scenario,
      adapterId: adapter.id,
      outputs,
    });
    return NextResponse.json(run);
  } catch (error) {
    return jsonError(error, 400);
  }
}
