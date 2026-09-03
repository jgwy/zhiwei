import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    getPool: vi.fn(() => ({ query })),
    withTransaction: vi.fn(async (callback: (client: { query: typeof query }) => unknown) => callback({ query })),
  };
});

vi.mock("./db", () => ({
  getPool: dbMock.getPool,
  withTransaction: dbMock.withTransaction,
}));

import { addUserMessageWithReflectionJob } from "./repository";

describe("atomic user-message persistence", () => {
  beforeEach(() => {
    dbMock.query.mockReset();
    dbMock.withTransaction.mockClear();
    dbMock.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes("INSERT INTO messages")) {
        return {
          rowCount: 1,
          rows: [{
            id: values[0],
            role: "user",
            content: values[3],
            metadata: JSON.parse(String(values[4])),
            created_at: new Date().toISOString(),
          }],
        };
      }
      if (sql.includes("INSERT INTO jobs")) return { rowCount: 1, rows: [{ id: values[0] }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it("creates the reflection job in the same transaction before any reply work", async () => {
    const result = await addUserMessageWithReflectionJob({
      conversationId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      content: "我是华中科技大学药学院刘一民",
      traceId: crypto.randomUUID(),
    });

    expect(dbMock.withTransaction).toHaveBeenCalledTimes(1);
    expect(dbMock.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO messages"))).toBe(true);
    expect(dbMock.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO jobs"))).toBe(true);
    const jobCall = dbMock.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO jobs"));
    expect(String(jobCall?.[1]?.[3])).toBe(`reflection:${result.message.id}:v1`);
    expect(JSON.parse(String(jobCall?.[1]?.[2]))).toMatchObject({
      messageId: result.message.id,
      content: "我是华中科技大学药学院刘一民",
    });
    expect(result.jobId).toBeTruthy();
  });
});
