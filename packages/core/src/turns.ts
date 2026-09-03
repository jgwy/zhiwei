import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, withTransaction } from "./db";
import { assessRisk } from "./risk";
import { mapMessage } from "./repository";
import type { ChatMessage, QuestionDefinition, RiskAssessment } from "./types";

export const REFLECTION_BATCH_SIZE = 3;
export const REFLECTION_IDLE_MS = 10 * 60_000;

export function isMemoryControl(content: string): boolean {
  return /(?:请|帮我|以后)?(?:记住|记下来|别再提|忘掉|忘记|不再引用|不要记|别记|撤回)|(?:你)?记错了|我想修正|更正一下|纠正一下/u.test(
    content,
  );
}

export async function getConversation(userId: string, conversationId: string) {
  const result = await getPool().query(
    `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (!result.rowCount) throw new Error("conversation_not_found");
  return result.rows[0];
}

export type MessagePage = {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
};
export async function getMessagePage(
  userId: string,
  conversationId: string,
  before?: string | null,
): Promise<MessagePage> {
  await getConversation(userId, conversationId);
  let cursor: { id: string } | null = null;
  if (before) {
    try {
      cursor = JSON.parse(Buffer.from(before, "base64url").toString());
    } catch {
      throw new Error("invalid_cursor");
    }
    if (!cursor?.id || !/^[a-f0-9-]{36}$/i.test(cursor.id))
      throw new Error("invalid_cursor");
    const anchor = await getPool().query(
      `SELECT id FROM messages WHERE id=$1 AND user_id=$2 AND conversation_id=$3`,
      [cursor.id, userId, conversationId],
    );
    if (!anchor.rowCount) throw new Error("invalid_cursor");
  }
  const result = await getPool().query(
    `SELECT * FROM messages WHERE user_id = $1 AND conversation_id = $2 AND is_current_reply
     AND ($3::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM messages WHERE id=$3 AND user_id=$1 AND conversation_id=$2))
     ORDER BY created_at DESC, id DESC LIMIT 81`,
    [userId, conversationId, cursor?.id ?? null],
  );
  const rows = result.rows.slice(0, 80).reverse();
  const first = rows[0];
  return {
    messages: rows.map(mapMessage),
    hasMore: result.rows.length > 80,
    nextCursor:
      result.rows.length > 80 && first
        ? Buffer.from(JSON.stringify({ id: first.id })).toString("base64url")
        : null,
  };
}

async function insertJob(
  client: PoolClient,
  userId: string,
  type: string,
  payload: Record<string, unknown>,
  key: string,
  runAfter = new Date(),
) {
  const result = await client.query(
    `INSERT INTO jobs (id,user_id,type,payload,idempotency_key,run_after) VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT (user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING id`,
    [randomUUID(), userId, type, JSON.stringify(payload), key, runAfter],
  );
  return result.rows[0].id as string;
}

async function appendReflection(
  client: PoolClient,
  input: {
    userId: string;
    conversationId: string;
    message: ChatMessage;
    traceId: string;
    kind: "chat" | "onboarding";
    question?: QuestionDefinition;
  },
) {
  const immediate = isMemoryControl(input.message.content);
  const found = await client.query(
    `SELECT * FROM jobs WHERE user_id = $1 AND type = 'reflection' AND status = 'pending'
     AND payload->>'conversationId' = $2 AND payload->>'sealed' = 'false' FOR UPDATE`,
    [input.userId, input.conversationId],
  );
  const open = found.rows[0];
  const sourceMessageIds = [
    ...(open?.payload.sourceMessageIds ?? []),
    input.message.id,
  ];
  const sealed = immediate || sourceMessageIds.length >= REFLECTION_BATCH_SIZE;
  const payload = {
    ...(open?.payload ?? {}),
    conversationId: input.conversationId,
    sourceMessageIds,
    messageId: input.message.id,
    content: input.message.content,
    kind: input.kind,
    questionId: input.question?.id,
    questionCategory: input.question?.category,
    traceId: input.traceId,
    sealed,
    immediate,
  };
  if (immediate) {
    // Earlier open conversations cannot learn old facts after this control command.
    await client.query(
      `UPDATE jobs SET payload = jsonb_set(payload,'{sealed}','true'), run_after = now()
      WHERE user_id = $1 AND type = 'reflection' AND status = 'pending' AND payload->>'sealed' = 'false' AND id <> COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
      [input.userId, open?.id ?? null],
    );
  }
  const runAfter = new Date(Date.now() + (sealed ? 0 : REFLECTION_IDLE_MS));
  if (open) {
    await client.query(
      `UPDATE jobs SET payload = $2::jsonb, run_after = $3 WHERE id = $1`,
      [open.id, JSON.stringify(payload), runAfter],
    );
    return open.id as string;
  }
  return insertJob(
    client,
    input.userId,
    "reflection",
    payload,
    `reflection-batch:${input.message.id}:v1`,
    runAfter,
  );
}

async function insertAssistant(
  client: PoolClient,
  userId: string,
  conversationId: string,
  userMessageId: string,
  traceId: string,
  attempt: number,
) {
  const result = await client.query(
    `INSERT INTO messages
    (id,user_id,conversation_id,role,content,metadata,reply_to_message_id,attempt_number,created_at)
    VALUES ($1,$2,$3,'assistant','',$4::jsonb,$5,$6,clock_timestamp()) RETURNING *`,
    [
      randomUUID(),
      userId,
      conversationId,
      JSON.stringify({ traceId, status: "streaming", streaming: true }),
      userMessageId,
      attempt,
    ],
  );
  return mapMessage(result.rows[0]);
}

export async function submitTurn(input: {
  userId: string;
  conversationId: string;
  content: string;
  clientRequestId?: string;
  kind?: "chat" | "onboarding";
  question?: QuestionDefinition;
}) {
  return withTransaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [
      input.userId,
    ]);
    const c = await client.query(
      `SELECT * FROM conversations WHERE user_id=$1 AND id=$2 FOR UPDATE`,
      [input.userId, input.conversationId],
    );
    if (!c.rowCount) throw new Error("conversation_not_found");
    if (input.clientRequestId) {
      const prior = await client.query(
        `SELECT id FROM messages WHERE user_id=$1 AND client_request_id=$2`,
        [input.userId, input.clientRequestId],
      );
      if (prior.rowCount) throw new Error("message_already_submitted");
    }
    const traceId = randomUUID();
    const kind = input.kind ?? "chat";
    if (kind === "onboarding" && input.question) {
      const duplicate = await client.query(
        `SELECT id FROM messages WHERE user_id=$1 AND conversation_id=$2 AND metadata->>'questionId'=$3`,
        [input.userId, input.conversationId, input.question.id],
      );
      if (duplicate.rowCount)
        throw new Error("这道题已经回答过了，请刷新后继续。");
    }
    const inserted = await client.query(
      `INSERT INTO messages (id,user_id,conversation_id,role,content,metadata,client_request_id)
      VALUES ($1,$2,$3,'user',$4,$5::jsonb,$6) RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.conversationId,
        input.content,
        JSON.stringify({
          traceId,
          kind: kind === "onboarding" ? "onboarding-answer" : "chat",
          questionId: input.question?.id,
          questionCategory: input.question?.category,
        }),
        input.clientRequestId ?? null,
      ],
    );
    const userMessage = mapMessage(inserted.rows[0]);
    const riskAssessment = assessRisk(input.content);
    await client.query(
      `INSERT INTO risk_events(id,user_id,conversation_id,message_id,level,reason,response_path,evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        randomUUID(),
        input.userId,
        input.conversationId,
        userMessage.id,
        riskAssessment.level,
        riskAssessment.reason,
        riskAssessment.responsePath,
        JSON.stringify(riskAssessment.evidence),
      ],
    );
    const jobId =
      riskAssessment.level === "ordinary"
        ? await appendReflection(client, {
            ...input,
            message: userMessage,
            traceId,
            kind,
          })
        : "";
    if (kind === "chat") {
      const first = await client.query(
        `SELECT count(*)::int AS count FROM messages WHERE conversation_id=$1 AND role='user'`,
        [input.conversationId],
      );
      if (first.rows[0].count === 1)
        await insertJob(
          client,
          input.userId,
          "conversation_title",
          {
            conversationId: input.conversationId,
            content: input.content,
            traceId,
          },
          `conversation_title:${input.conversationId}:v1`,
        );
    }
    await client.query(
      `UPDATE conversations SET updated_at=now() WHERE id=$1`,
      [input.conversationId],
    );
    const assistant =
      kind === "chat"
        ? await insertAssistant(
            client,
            input.userId,
            input.conversationId,
            userMessage.id,
            traceId,
            1,
          )
        : null;
    return { userMessage, assistant, traceId, jobId, riskAssessment };
  });
}

export async function retryTurn(
  userId: string,
  conversationId: string,
  assistantId: string,
) {
  return withTransaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    const c = await client.query(
      `SELECT id FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [conversationId, userId],
    );
    if (!c.rowCount) throw new Error("conversation_not_found");
    const latest = await client.query(
      `SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 AND is_current_reply ORDER BY created_at DESC,id DESC LIMIT 1`,
      [conversationId, userId],
    );
    const previous = latest.rows[0];
    if (
      !previous ||
      previous.id !== assistantId ||
      previous.role !== "assistant"
    )
      throw new Error("retry_latest_only");
    if (previous.metadata?.status === "streaming")
      throw new Error("reply_in_progress");
    const source = await client.query(
      `SELECT * FROM messages WHERE user_id=$1 AND conversation_id=$2 AND role='user'
      AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND created_at <= $4)) ORDER BY created_at DESC,id DESC LIMIT 1`,
      [
        userId,
        conversationId,
        previous.reply_to_message_id,
        previous.created_at,
      ],
    );
    if (!source.rowCount) throw new Error("retry_source_missing");
    await client.query(
      `UPDATE messages SET is_current_reply=false WHERE id=$1`,
      [assistantId],
    );
    const userMessage = mapMessage(source.rows[0]);
    const traceId = randomUUID();
    const assistant = await insertAssistant(
      client,
      userId,
      conversationId,
      userMessage.id,
      traceId,
      Number(previous.attempt_number) + 1,
    );
    return {
      userMessage,
      assistant,
      traceId,
      jobId: "",
      riskAssessment: assessRisk(userMessage.content),
    };
  });
}

export async function finishReplyAttempt(input: {
  userId: string;
  messageId: string;
  content: string;
  metadata: Record<string, unknown>;
}) {
  await getPool().query(
    `UPDATE messages SET content=$3,metadata=metadata || $4::jsonb WHERE id=$1 AND user_id=$2 AND role='assistant'`,
    [
      input.messageId,
      input.userId,
      input.content,
      JSON.stringify(input.metadata),
    ],
  );
}

export async function getBatchEvidence(
  userId: string,
  conversationId: string,
  ids: string[],
) {
  const result = await getPool().query(
    `SELECT * FROM messages WHERE id=ANY($1::uuid[]) AND user_id=$2 AND conversation_id=$3 AND role='user'`,
    [ids, userId, conversationId],
  );
  if (result.rowCount !== new Set(ids).size)
    throw new Error("memory_evidence_scope_invalid");
  const rows = new Map(result.rows.map((row) => [row.id, row]));
  return ids.map((id) => mapMessage(rows.get(id)));
}

export async function listMessagesThrough(
  userId: string,
  conversationId: string,
  sourceMessageId: string,
  limit = 24,
  eligibleOnly = false,
) {
  const result = await getPool().query(
    `SELECT msg.* FROM messages msg JOIN messages source ON source.id=$3 AND source.user_id=$1
    WHERE msg.user_id=$1 AND msg.conversation_id=$2 AND msg.is_current_reply
      AND (msg.created_at,msg.id)<=(source.created_at,source.id)
      AND ($5::boolean=false OR msg.metadata->>'summaryEligible'='true' OR (msg.role='assistant' AND EXISTS(SELECT 1 FROM messages u WHERE u.id=msg.reply_to_message_id AND u.metadata->>'summaryEligible'='true')))
    ORDER BY msg.created_at DESC,msg.id DESC LIMIT $4`,
    [userId, conversationId, sourceMessageId, limit, eligibleOnly],
  );
  return result.rows.reverse().map(mapMessage);
}

export async function markSummaryEvidence(
  userId: string,
  sourceIds: string[],
  eligibleIds: string[],
) {
  await getPool().query(
    `UPDATE messages SET metadata=jsonb_set(metadata,'{summaryEligible}',to_jsonb(id=ANY($3::uuid[])))
    WHERE user_id=$1 AND id=ANY($2::uuid[])`,
    [userId, sourceIds, eligibleIds],
  );
}

export type TurnAccepted = {
  userMessage: ChatMessage;
  assistant: ChatMessage | null;
  traceId: string;
  jobId: string;
  riskAssessment: RiskAssessment;
};
