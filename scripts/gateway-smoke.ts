// 真模型网关冒烟测试：验证 API Key、三种模型和主要协议链路。不入库，仅本地诊断用。
import { assessRisk, compileContext } from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";

async function main() {
  const gateway = getModelGateway();
  console.log("gateway:", gateway.id);

  const embedded = await gateway.embed(["最近入职前有点焦虑，晚上总是睡不好"], {});
  console.log("✓ embed 维度:", embedded.data[0]?.length);

  const route = await gateway.routeFacts("黑洞是怎么形成的？", {});
  console.log("✓ routeFacts scientific:", route.data.scientific, "needsSearch:", route.data.needsSearch);

  const compiled = compileContext({
    foundationInstructions: composeFoundationInstructions(["zhiwei-persona", "dialogue-orchestrator"]),
    personalSkill: undefined,
    profile: null,
    memories: [],
    sessionSummary: undefined,
    messages: [],
    maxInputTokens: 8_000,
  });
  const chunks: string[] = [];
  const content = "最近入职前有点焦虑，晚上总是睡不好";
  for await (const event of gateway.streamDialogue({
    userId: "smoke-test-user",
    conversationId: "smoke-test",
    messageId: "smoke-m1",
    content,
    context: compiled,
    riskAssessment: assessRisk(content),
    factBrief: null,
    scienceMode: false,
    responsePlan: undefined,
  }, {})) {
    if (event.type === "text.delta") chunks.push(event.delta);
    if (event.type === "completed") {
      console.log("✓ streamDialogue 完成，usage:", JSON.stringify(event.meta.usage ?? {}).slice(0, 120));
    }
  }
  const reply = chunks.join("");
  console.log("✓ 回复长度:", reply.length, "字，开头:", reply.slice(0, 60));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("✗ 冒烟测试失败:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
