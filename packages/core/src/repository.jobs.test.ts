import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({
  getPool: () => database,
  withTransaction: async (operation: (client: { query: typeof database.query }) => unknown) =>
    operation({ query: database.query }),
}));

import {
  claimJob,
  consolidateExpiringShortMemories,
  getMemoriesMissingEmbedding,
  pruneOldTraces,
  recordTrace,
  updateMemoryVersionEmbedding,
} from "./repository";

describe("job queue robustness", () => {
  beforeEach(() => database.query.mockReset());

  it("reclaims leases of stuck running jobs before claiming", async () => {
    database.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "job-1", user_id: "user-1", type: "reflection", payload: {}, attempts: 1 }],
      });

    const job = await claimJob();

    expect(job?.id).toBe("job-1");
    const [reaperSql, reaperParams] = database.query.mock.calls[0]!;
    expect(reaperSql).toContain("status = 'running'");
    expect(reaperSql).toContain("make_interval(mins =>");
    expect(Number(reaperParams[0])).toBeGreaterThan(0);
    expect(database.query.mock.calls[1]![0]).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("honours a custom lease window from the environment", async () => {
    process.env.JOB_LEASE_MINUTES = "45";
    database.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    try {
      await claimJob();
      const [, reaperParams] = database.query.mock.calls[0]!;
      expect(Number(reaperParams[0])).toBe(45);
    } finally {
      delete process.env.JOB_LEASE_MINUTES;
    }
  });

  it("returns null when no job is claimable", async () => {
    database.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await claimJob()).toBeNull();
  });
});

describe("trace hygiene", () => {
  beforeEach(() => database.query.mockReset());

  it("truncates oversized trace payloads instead of storing them verbatim", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const huge = { blob: "知".repeat(60_000) };

    await recordTrace({ userId: crypto.randomUUID(), traceId: "t", stage: "test", payload: huge });

    const [, parameters] = database.query.mock.calls[0]!;
    const stored = JSON.parse(parameters[4]);
    expect(stored.truncated).toBe(true);
    expect(stored.originalSize).toBeGreaterThan(60_000);
    expect((parameters[4] as string).length).toBeLessThan(40_000);
  });

  it("keeps small payloads verbatim", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const payload = { messageId: "m-1" };

    await recordTrace({ userId: crypto.randomUUID(), traceId: "t", stage: "test", payload });

    const [, parameters] = database.query.mock.calls[0]!;
    expect(JSON.parse(parameters[4])).toEqual(payload);
  });

  it("deletes traces older than the retention window", async () => {
    database.query.mockResolvedValue({ rowCount: 7, rows: [] });
    expect(await pruneOldTraces(30)).toBe(7);
    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM trace_events");
    expect(parameters[0]).toBe(30);
  });
});

describe("embedding backfill", () => {
  beforeEach(() => database.query.mockReset());

  it("lists active memory versions that miss an embedding, scoped to the user", async () => {
    database.query.mockResolvedValue({
      rowCount: 1,
      rows: [{ version_id: "v-1", content: "喜欢周末跑步" }],
    });
    const userId = crypto.randomUUID();

    const missing = await getMemoriesMissingEmbedding(userId, 20);

    expect(missing).toEqual([{ versionId: "v-1", content: "喜欢周末跑步" }]);
    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("embedding_v2 IS NULL");
    expect(parameters[0]).toBe(userId);
  });

  it("refuses to write embeddings with the wrong dimension", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    await updateMemoryVersionEmbedding(crypto.randomUUID(), crypto.randomUUID(), [0.1, 0.2]);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("writes 1024-dimensional embeddings within the user scope", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const userId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const vector = Array.from({ length: 1024 }, () => 0.5);

    await updateMemoryVersionEmbedding(userId, versionId, vector);

    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("WHERE id = $1 AND user_id = $2");
    expect(parameters[0]).toBe(versionId);
    expect(parameters[1]).toBe(userId);
    expect(String(parameters[2]).split(",")).toHaveLength(1024);
  });
});

describe("memory consolidation", () => {
  beforeEach(() => database.query.mockReset());

  it("promotes active short memories that meet the evidence and confidence bar", async () => {
    database.query.mockResolvedValue({ rowCount: 3, rows: [] });

    const promoted = await consolidateExpiringShortMemories({ horizonDays: 5, minConfidence: 0.85, minEvidence: 2 });

    expect(promoted).toBe(3);
    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("tier = 'long'");
    expect(sql).toContain("valid_until = NULL");
    expect(sql).toContain("mv.is_active = true");
    expect(sql).toContain("mv.tier = 'short'");
    expect(sql).toContain("memory_evidence");
    expect(parameters).toEqual([5, 0.85, 2]);
  });

  it("uses conservative defaults", async () => {
    database.query.mockResolvedValue({ rowCount: 0, rows: [] });

    await consolidateExpiringShortMemories();

    const [, parameters] = database.query.mock.calls[0]!;
    expect(parameters).toEqual([7, 0.8, 1]);
  });
});
