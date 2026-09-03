import { describe, expect, it } from "vitest";
import { competitionReplayDataset, withCompetitionReplays } from "./competition-replays";

describe("competition memory lifecycle replays", () => {
  it("publishes exactly ten versioned, synthetic real-model replays within budget", () => {
    expect(competitionReplayDataset.schemaVersion).toBe("zhiwei.memory-lifecycle-replays/v1");
    expect(competitionReplayDataset.datasetVersion).toMatch(/^1\.0\.0-qwen-/);
    expect(competitionReplayDataset.fixtures).toHaveLength(10);
    expect(new Set(competitionReplayDataset.fixtures.map((fixture) => fixture.id)).size).toBe(10);
    expect(competitionReplayDataset.provenance).toMatchObject({
      kind: "aliyun-bailian-real-replay",
      gateway: "aliyun-bailian-openai-v1",
      provider: "aliyun-bailian",
      synthetic: true,
      liveModel: true,
      billable: true,
    });
    expect(competitionReplayDataset.provenance.estimatedCostCny).toBeLessThanOrEqual(competitionReplayDataset.provenance.budgetCny!);
    expect(competitionReplayDataset.provenance.budgetCny).toBeLessThanOrEqual(5);
  });

  it("keeps every nested fixture object immutable at runtime", () => {
    expect(Object.isFrozen(competitionReplayDataset)).toBe(true);
    expect(Object.isFrozen(competitionReplayDataset.provenance)).toBe(true);
    expect(Object.isFrozen(competitionReplayDataset.fixtures)).toBe(true);
    expect(Object.isFrozen(competitionReplayDataset.fixtures[0])).toBe(true);
  });

  it("adds global fixtures without changing user-scoped competition records", () => {
    const scoped = { runs: [{ id: "current-user-run" }], risks: [], withdrawals: [], conversations: [] };
    const result = withCompetitionReplays(scoped);

    expect(result.runs).toEqual(scoped.runs);
    expect(result.replays).toBe(competitionReplayDataset.fixtures);
    expect(result.replayDataset).not.toHaveProperty("fixtures");
  });
});
