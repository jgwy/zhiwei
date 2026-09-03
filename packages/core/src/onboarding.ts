import { randomUUID } from "node:crypto";
import { getPool, withTransaction } from "./db";
import { questionBank } from "./questions";
import type { QuestionDefinition } from "./types";

export async function getPreparedQuestion(
  userId: string,
  step: number,
): Promise<QuestionDefinition | null> {
  return withTransaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    const cached = await client.query(
      `SELECT question FROM onboarding_question_plans WHERE user_id=$1 AND step=$2`,
      [userId, step],
    );
    if (cached.rowCount) return cached.rows[0].question;
    let question: QuestionDefinition | null = null;
    let modelName = "common-questions-v1";
    if (step < 3) question = questionBank[step] ?? null;
    else {
      const candidate = await client.query(
        `SELECT * FROM onboarding_question_candidates WHERE user_id=$1 AND selected_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
        [userId],
      );
      if (candidate.rowCount) {
        question = candidate.rows[0].question;
        modelName = candidate.rows[0].model_name;
        await client.query(
          `UPDATE onboarding_question_candidates SET selected_at=now() WHERE id=$1`,
          [candidate.rows[0].id],
        );
      } else {
        const answered = await client.query(
          `SELECT metadata->>'questionId' AS id FROM messages WHERE user_id=$1 AND metadata->>'kind'='onboarding-answer'`,
          [userId],
        );
        const ids = new Set(answered.rows.map((row) => row.id));
        question = questionBank.slice(3).find((q) => !ids.has(q.id)) ?? null;
      }
    }
    if (question)
      await client.query(
        `INSERT INTO onboarding_question_plans(id,user_id,step,question,model_name)
      VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(user_id,step) DO NOTHING`,
        [randomUUID(), userId, step, JSON.stringify(question), modelName],
      );
    return question;
  });
}

export async function enqueueQuestionPlanning(userId: string) {
  await getPool().query(
    `INSERT INTO jobs(id,user_id,type,payload,idempotency_key)
    SELECT $1,u.id,'onboarding_plan','{}'::jsonb,$2 FROM users u
    WHERE u.id=$3 AND NOT u.onboarding_complete
      AND (SELECT count(*) FROM onboarding_question_candidates WHERE user_id=u.id AND selected_at IS NULL)<2
      AND EXISTS(SELECT 1 FROM messages WHERE user_id=u.id AND metadata->>'kind'='onboarding-answer')
    ON CONFLICT DO NOTHING`,
    [randomUUID(), `question-planner:${randomUUID()}`, userId],
  );
}

export async function publishQuestionCandidates(
  userId: string,
  questions: QuestionDefinition[],
  modelName: string,
  answerCount: number,
) {
  await withTransaction(async (client) => {
    const user = await client.query(
      `SELECT onboarding_complete FROM users WHERE id=$1 FOR UPDATE`,
      [userId],
    );
    if (!user.rowCount || user.rows[0].onboarding_complete) return;
    const existing = await client.query(
      `SELECT count(*)::int AS count FROM onboarding_question_candidates WHERE user_id=$1 AND selected_at IS NULL`,
      [userId],
    );
    for (const question of questions.slice(
      0,
      Math.max(0, 2 - existing.rows[0].count),
    )) {
      await client.query(
        `INSERT INTO onboarding_question_candidates(id,user_id,question,model_name,source_answer_count) VALUES($1,$2,$3::jsonb,$4,$5)`,
        [
          randomUUID(),
          userId,
          JSON.stringify(question),
          modelName,
          answerCount,
        ],
      );
    }
  });
}

export async function finishOnboarding(userId: string) {
  return withTransaction(async (client) => {
    const user = await client.query(
      `SELECT onboarding_complete FROM users WHERE id=$1 FOR UPDATE`,
      [userId],
    );
    if (!user.rowCount) throw new Error("user_not_found");
    const answers = await client.query(
      `SELECT count(*)::int AS count FROM messages WHERE user_id=$1 AND metadata->>'kind'='onboarding-answer'`,
      [userId],
    );
    if (answers.rows[0].count < 3)
      throw new Error("回答三题后就可以开始聊天。");
    if (user.rows[0].onboarding_complete) {
      const previous = await client.query(
        `SELECT id FROM conversations WHERE user_id=$1 AND kind='chat' ORDER BY created_at LIMIT 1`,
        [userId],
      );
      if (previous.rowCount) return previous.rows[0].id as string;
    }
    await client.query(
      `UPDATE users SET onboarding_complete=true,updated_at=now() WHERE id=$1`,
      [userId],
    );
    const conversationId = randomUUID();
    await client.query(
      `INSERT INTO conversations(id,user_id,kind,title) VALUES($1,$2,'chat','第一次聊天')`,
      [conversationId, userId],
    );
    return conversationId;
  });
}
