import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("model transport and cost precision migration", () => {
  const sql = readFileSync(new URL("../migrations/005_model_transport_and_cost_precision.sql", import.meta.url), "utf8");

  it("preserves sub-fen estimates and records the concrete transport", () => {
    expect(sql).toMatch(/estimated_cost_cny\s+TYPE\s+numeric\(16,\s*8\)/i);
    expect(sql).toMatch(/transport\s+text\s+NOT NULL\s+DEFAULT\s+'unknown'/i);
  });
});

describe("direct memory lifecycle migrations", () => {
  const lifecycle = readFileSync(new URL("../migrations/007_memory_lifecycle.sql", import.meta.url), "utf8");
  const direct = readFileSync(new URL("../migrations/008_direct_memory_lifecycle.sql", import.meta.url), "utf8");
  const modelTasks = readFileSync(new URL("../migrations/009_memory_model_tasks.sql", import.meta.url), "utf8");
  const modelAttempts = readFileSync(new URL("../migrations/010_model_attempt_metadata.sql", import.meta.url), "utf8");

  it("keeps the already-applied legacy lifecycle columns and states readable", () => {
    expect(lifecycle).toContain("'pending'");
    expect(lifecycle).toContain("source_type");
    expect(lifecycle).toContain("memory_operations");
  });

  it("moves short memories to user scope without deleting legacy columns", () => {
    expect(direct).toMatch(/SET scope = 'user', scope_key = NULL\s+WHERE tier = 'short'/);
    expect(direct).not.toMatch(/DROP COLUMN/i);
    expect(direct).toContain("memory_version_parents");
    expect(direct).toContain("source_memory_version_ids");
    expect(direct).toContain("score_change_reasons");
  });

  it("allows both consolidation model calls to be traced", () => {
    expect(modelTasks).toContain("memory-consolidation-plan");
    expect(modelTasks).toContain("memory-consolidation-review");
  });

  it("keeps every paid retry attempt inspectable without storing reasoning", () => {
    expect(modelAttempts).toMatch(/attempts\s+jsonb\s+NOT NULL\s+DEFAULT\s+'\[\]'::jsonb/i);
  });
});
