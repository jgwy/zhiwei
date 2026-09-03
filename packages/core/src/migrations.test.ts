import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("model transport and cost precision migration", () => {
  const sql = readFileSync(new URL("../migrations/005_model_transport_and_cost_precision.sql", import.meta.url), "utf8");

  it("preserves sub-fen estimates and records the concrete transport", () => {
    expect(sql).toMatch(/estimated_cost_cny\s+TYPE\s+numeric\(16,\s*8\)/i);
    expect(sql).toMatch(/transport\s+text\s+NOT NULL\s+DEFAULT\s+'unknown'/i);
  });
});

describe("memory lifecycle migration", () => {
  const sql = readFileSync(new URL("../migrations/007_memory_lifecycle.sql", import.meta.url), "utf8");

  it("enforces scoped short memory and one active or pending version per memory", () => {
    expect(sql).toMatch(/tier = 'short'.*scope = 'conversation'.*scope_key IS NOT NULL.*valid_until IS NOT NULL/s);
    expect(sql).toMatch(/idx_memory_versions_one_active/);
    expect(sql).toMatch(/idx_memory_versions_one_pending/);
  });

  it("keeps audit and idempotency data user-owned and deletable", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS memory_events/);
    expect(sql).toMatch(/REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS memory_operations/);
    expect(sql).toMatch(/PRIMARY KEY \(user_id, idempotency_key\)/);
  });
});
