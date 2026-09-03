import replayDataset from "../data/memory-lifecycle-replays.qwen.v1.json";

export type CompetitionReplayDataset = Readonly<{
  schemaVersion: string;
  datasetVersion: string;
  releasedAt: string;
  provenance: Readonly<{
    kind: "scripted-free-fixture" | "aliyun-bailian-real-replay";
    gateway: string;
    provider: "scripted" | "aliyun-bailian";
    synthetic: true;
    liveModel: boolean;
    billable: boolean;
    description: string;
    estimatedCostCny?: number;
    budgetCny?: number;
  }>;
  fixtures: readonly Readonly<Record<string, unknown>>[];
}>;

export type CompetitionDataWithReplays<T extends Record<string, unknown>> = T & Readonly<{
  replayDataset: Omit<CompetitionReplayDataset, "fixtures">;
  replays: CompetitionReplayDataset["fixtures"];
}>;

export const competitionReplayDataset = validateAndFreezeDataset(
  replayDataset as CompetitionReplayDataset,
);

export function withCompetitionReplays<T extends Record<string, unknown>>(
  competition: T,
): CompetitionDataWithReplays<T> {
  const { fixtures, ...metadata } = competitionReplayDataset;
  return Object.freeze({
    ...competition,
    replayDataset: metadata,
    replays: fixtures,
  }) as CompetitionDataWithReplays<T>;
}

function validateAndFreezeDataset(dataset: CompetitionReplayDataset): CompetitionReplayDataset {
  if (dataset.schemaVersion !== "zhiwei.memory-lifecycle-replays/v1") {
    throw new Error("不支持的比赛回放数据格式");
  }
  if (dataset.fixtures.length !== 10) {
    throw new Error("比赛回放数据必须恰好包含十组夹具");
  }
  const provenance = dataset.provenance;
  const validScripted = provenance.kind === "scripted-free-fixture"
    && provenance.provider === "scripted"
    && provenance.synthetic === true
    && provenance.liveModel === false
    && provenance.billable === false;
  const validReal = provenance.kind === "aliyun-bailian-real-replay"
    && provenance.provider === "aliyun-bailian"
    && provenance.synthetic === true
    && provenance.liveModel === true
    && provenance.billable === true
    && typeof provenance.estimatedCostCny === "number"
    && typeof provenance.budgetCny === "number"
    && provenance.estimatedCostCny >= 0
    && provenance.estimatedCostCny <= provenance.budgetCny
    && provenance.budgetCny <= 5;
  if (!validScripted && !validReal) throw new Error("比赛回放数据的来源标记无效");
  const ids = dataset.fixtures.map((fixture) => fixture.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new Error("比赛回放夹具 ID 必须存在且保持唯一");
  }
  return deepFreeze(dataset);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
