import { getModelCostData, recordPricingSnapshot } from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDeveloperMode())
    return NextResponse.json({ error: "开发者模式未开启" }, { status: 404 });
  try {
    const userId = await getSessionUserId();
    let data = await getModelCostData(userId);
    const refreshHours = Math.max(
      1,
      Number(process.env.MODEL_PRICING_REFRESH_HOURS ?? 24),
    );
    const stale =
      !data.pricing.length ||
      data.pricing.some(
        (row: any) =>
          Date.now() - new Date(row.fetched_at).getTime() >
          refreshHours * 3_600_000,
      );
    if (stale && (process.env.MODEL_PROVIDER ?? "scripted") !== "scripted") {
      try {
        const gateway = getModelGateway();
        const models = await gateway.listModels({
          signal: AbortSignal.timeout(10_000),
        });
        const selected = new Set([
          process.env.MODEL_DIALOGUE_NAME ?? "qwen-plus-character",
          process.env.MODEL_BACKGROUND_NAME ?? "qwen3.8-flash",
          process.env.MODEL_EMBEDDING_NAME ?? "qwen3.7-text-embedding",
        ]);
        for (const model of models.filter((item: any) =>
          selected.has(item.model),
        )) {
          await recordPricingSnapshot({
            modelName: model.model,
            provider:
              model.inference_provider ?? model.provider ?? "aliyun-bailian",
            prices: model.prices ?? [],
            capabilities: model.features ?? [],
            contextWindow: model.model_info?.context_window,
            requestId: model.request_id,
          });
        }
        data = await getModelCostData(userId);
      } catch {
        /* Keep the last available price snapshots and historical totals. */
      }
    }
    return NextResponse.json({
      ...data,
      searchPricing: { turboPerCallCny: 0.003, maxPerCallCny: 0.004 },
      disclaimer: "费用估算，不等同于阿里云账单。",
    });
  } catch (error) {
    return jsonError(error);
  }
}
