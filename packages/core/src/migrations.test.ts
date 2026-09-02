import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("model transport and cost precision migration", () => {
  const sql = readFileSync(new URL("../migrations/005_model_transport_and_cost_precision.sql", import.meta.url), "utf8");

  it("preserves sub-fen estimates and records the concrete transport", () => {
    expect(sql).toMatch(/estimated_cost_cny\s+TYPE\s+numeric\(16,\s*8\)/i);
    expect(sql).toMatch(/transport\s+text\s+NOT NULL\s+DEFAULT\s+'unknown'/i);
  });
});
