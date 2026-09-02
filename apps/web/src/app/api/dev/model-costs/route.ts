import { getModelCostData, recordPricingSnapshot } from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDeveloperMode()) return NextResponse.json({ error: "开发者模式未开启" }, { status: 404 });
  try {
    const userId = await getSessionUserId();
    let data = await getModelCostData(userId);
    const refreshHours = Math.max(1, Number(process.env.MODEL_PRICING_REFRESH_HOURS ?? 24));
    const stale = !data.pricing.length || data.pricing.some((row: any) => Date.now() - new Date(row.fetched_at).getTime() > refreshHours * 3_600_000);
    if (stale && (process.env.MODEL_PROVIDER ?? "scripted") !== "scripted") {
      const gateway = getModelGateway();
      const models = await gateway.listModels();
      const selected = new Set([process.env.MODEL_DIALOGUE_NAME ?? "qwen-plus-character", process.env.MODEL_BACKGROUND_NAME ?? "qwen3.8-flash", process.env.MODEL_EMBEDDING_NAME ?? "qwen3.7-text-embedding"]);
      for (const model of models.filter((item: any) => selected.has(item.model))) {
        await recordPricingSnapshot({
          modelName: model.model,
          provider: model.inference_provider ?? model.provider ?? "aliyun-bailian",
          prices: model.prices ?? [],
          capabilities: model.features ?? [],
          contextWindow: model.model_info?.context_window,
          requestId: model.request_id,
        });
      }
      data = await getModelCostData(userId);
    }
    const runs = data.runs.map((run: any) => ({ ...run, estimated_cost_cny: estimateFromLatestPricing(run, data.pricing) }));
    const totals = runs.reduce((sum: any, run: any) => ({
      total_cost: sum.total_cost + Number(run.estimated_cost_cny ?? 0),
      input_tokens: sum.input_tokens + Number(run.input_tokens ?? 0),
      output_tokens: sum.output_tokens + Number(run.output_tokens ?? 0),
      cached_input_tokens: sum.cached_input_tokens + Number(run.cached_input_tokens ?? 0),
      reasoning_tokens: sum.reasoning_tokens + Number(run.reasoning_tokens ?? 0),
      search_calls: sum.search_calls + Number(run.search_calls ?? 0),
    }), { total_cost: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0, search_calls: 0 });
    return NextResponse.json({ ...data, runs, totals, searchPricing: { turboPerCallCny: 0.003, maxPerCallCny: 0.004 }, disclaimer: "费用估算，不等同于阿里云账单。" });
  } catch (error) {
    return jsonError(error);
  }
}

function estimateFromLatestPricing(run: any, pricing: any[]) {
  const snapshot = pricing.find((item) => item.model_name === run.model_name);
  const ranges = snapshot?.prices;
  const entries = Array.isArray(ranges) ? ranges[0]?.prices ?? [] : [];
  const price = (type: string) => Number(entries.find((entry: any) => entry.type === type)?.price ?? 0);
  const inputUnit = price(run.role === "embedding" ? "embedding_token" : "input_token");
  const outputUnit = price("output_token");
  const cachedUnit = price("input_token_cache") || inputUnit;
  if (!inputUnit && !outputUnit) return Number(run.estimated_cost_cny ?? 0);
  const inputTokens = Number(run.input_tokens ?? 0);
  const cachedTokens = Math.min(inputTokens, Number(run.cached_input_tokens ?? 0));
  const tokenCost = ((inputTokens - cachedTokens) * inputUnit + cachedTokens * cachedUnit + Number(run.output_tokens ?? 0) * outputUnit) / 1_000_000;
  const searchCost = Number(run.search_calls ?? 0) * 0.004;
  return Number((tokenCost + searchCost).toFixed(8));
}
