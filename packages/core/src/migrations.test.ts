import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("model transport and cost precision migration", () => {
  const sql = readFileSync(new URL("../migrations/005_model_transport_and_cost_precision.sql", import.meta.url), "utf8");

  it("preserves sub-fen estimates and records the concrete transport", () => {
    expect(sql).toMatch(/estimated_cost_cny\s+TYPE\s+numeric\(16,\s*8\)/i);
    expect(sql).toMatch(/transport\s+text\s+NOT NULL\s+DEFAULT\s+'unknown'/i);
  });
});

describe("temporal memory and message migration", () => {
  const sql = readFileSync(new URL("../migrations/007_temporal_memory_and_messages.sql", import.meta.url), "utf8");

  it("backfills deterministic per-conversation order and evidence timestamps", () => {
    expect(sql).toMatch(/row_number\(\)\s+OVER\s*\(\s*PARTITION BY conversation_id\s+ORDER BY created_at, id/is);
    expect(sql).toMatch(/UNIQUE INDEX[^;]+conversation_id, sequence_no/is);
    expect(sql).toMatch(/min\(message\.created_at\) AS first_observed_at/i);
    expect(sql).toMatch(/max\(message\.created_at\) AS last_confirmed_at/i);
  });

  it("does not backfill an inferred event occurrence time", () => {
    const backfill = sql.slice(sql.indexOf("WITH evidence_times"));
    expect(backfill).not.toMatch(/event_time_start\s*=/i);
    expect(backfill).not.toMatch(/event_time_end\s*=/i);
  });
});
