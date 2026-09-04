import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "./db";
import { addMessage, createConversation, deleteAllUserData, ensureUser, getMoodSeries, getUserState } from "./repository";

const integration = process.env.INTEGRATION_DATABASE_URL ? describe : describe.skip;

integration("mood calendar days with isolated PostgreSQL", () => {
  const users: string[] = [];
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let userId: string;
  const samples = [
    { observedAt: "2026-09-03T15:50:00.000Z", score: -3, summary: "展示前感到紧张。" },
    { observedAt: "2026-09-03T16:10:00.000Z", score: -1, summary: "完成准备，稍微放松了。" },
    { observedAt: "2026-09-03T17:00:00.000Z", score: 3, summary: "收到同学的鼓励，心情好了一些。" },
  ];

  beforeAll(async () => {
    const target = new URL(process.env.INTEGRATION_DATABASE_URL!);
    if (!/test/iu.test(target.pathname)) throw new Error("mood integration requires a dedicated test database");
    await closePool();
    process.env.DATABASE_URL = target.toString();
    for (let index = 0; index < 2; index += 1) {
      const id = crypto.randomUUID();
      users.push(id);
      await ensureUser(id);
      const conversation = await createConversation(id);
      for (const sample of index === 0 ? samples : samples.slice(0, 1)) {
        const message = await addMessage({ userId: id, conversationId: conversation.id, role: "user", content: sample.summary });
        await getPool().query(
          `INSERT INTO mood_samples (id,user_id,conversation_id,message_id,score,summary,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [crypto.randomUUID(), id, conversation.id, message.id, index === 0 ? sample.score : 5, sample.summary, sample.observedAt],
        );
      }
    }
    userId = users[0]!;
  });

  afterAll(async () => {
    for (const id of users) await deleteAllUserData(id);
    await closePool();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("splits UTC+8 midnight, keeps day averages and latest summaries, and isolates users", async () => {
    const mood = await getMoodSeries(userId, "Asia/Shanghai");
    expect(mood).toEqual([
      { day: "2026-09-03", score: -3, summary: samples[0]!.summary },
      { day: "2026-09-04", score: 1, summary: samples[2]!.summary },
    ]);
    expect((await getUserState(userId, "Asia/Shanghai")).mood).toEqual(mood);
  });

  it("regroups the same samples for another device zone without changing their UTC timestamps", async () => {
    expect(await getMoodSeries(userId, "UTC")).toEqual([
      { day: "2026-09-03", score: -0.3, summary: samples[2]!.summary },
    ]);
    const stored = await getPool().query(`SELECT observed_at FROM mood_samples WHERE user_id=$1 ORDER BY observed_at`, [userId]);
    expect(stored.rows.map((row) => row.observed_at.toISOString())).toEqual(samples.map((sample) => sample.observedAt));
  });

  it("uses the same Shanghai fallback for absent and invalid zones without filling missing days", async () => {
    const expected = await getMoodSeries(userId, "Asia/Shanghai");
    expect(await getMoodSeries(userId)).toEqual(expected);
    expect(await getMoodSeries(userId, "invalid/place")).toEqual(expected);
    expect(await getMoodSeries(users[1]!, "UTC")).toHaveLength(1);
  });
});
