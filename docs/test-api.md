# 对话测试 API

正式入口：`POST https://zhiwei.yingblog.net/api/test/chat`

这是与网页共用的对话入口：保留实际 Skills、有限上下文、记忆检索、事实工具、风险处理、会话标题和后台记忆整理流程。接口将流式回复收集为 JSON，方便测试程序直接读取。无需填写模型密钥；模型配置由服务端管理。

## 单轮调用

```bash
curl --max-time 180 'https://zhiwei.yingblog.net/api/test/chat' \
  -H 'Content-Type: application/json' \
  --data '{"message":"我第一次做课程汇报，有点担心讲错。"}'
```

成功返回 HTTP 200，主要字段：

| 字段 | 含义 |
| --- | --- |
| `reply` | 知微的实际回复正文 |
| `conversationId` | 本段会话编号 |
| `messageId` / `userMessageId` | 助手回复和用户原文编号 |
| `status` | 成功时为 `completed` |
| `sources` | 实际查证来源；没有查证来源时为空数组 |
| `traceId` | 当前调用的运行记录编号 |
| `memoryUpdateQueued` | 是否已排入后台记忆整理任务，不表示任务已完成 |

## 多轮与跨会话记忆

以下示例需要 `curl` 和 `jq`。Cookie 是当前测试身份的访问凭证，请妥善保管，不要分享或提交到 Git。

```bash
ZHIWEI_COOKIE_JAR="$(mktemp)"
ZHIWEI_FIRST_REPLY="$(curl --silent --show-error --fail-with-body --max-time 180 \
  -c "$ZHIWEI_COOKIE_JAR" -b "$ZHIWEI_COOKIE_JAR" \
  'https://zhiwei.yingblog.net/api/test/chat' \
  -H 'Content-Type: application/json' \
  --data '{"message":"我第一次做课程汇报，有点担心讲错。"}')"
printf '%s\n' "$ZHIWEI_FIRST_REPLY" | jq .
ZHIWEI_CONVERSATION_ID="$(printf '%s' "$ZHIWEI_FIRST_REPLY" | jq -r '.conversationId')"
curl --silent --show-error --fail-with-body --max-time 180 \
  -c "$ZHIWEI_COOKIE_JAR" -b "$ZHIWEI_COOKIE_JAR" \
  'https://zhiwei.yingblog.net/api/test/chat' \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg id "$ZHIWEI_CONVERSATION_ID" \
    '{conversationId:$id,message:"最让我害怕的其实是现场突然被追问。"}')"
```

继续同一会话时，携带 Cookie 和 `conversationId`。携带同一 Cookie 但不传 `conversationId`，会新建会话并共享该身份已授权的记忆。没有 Cookie 时会创建独立游客身份，不能通过猜测编号访问其他身份的数据。

`message` 为 1–8000 字符。可选 `clientRequestId` 为调用方生成的 UUID；相同身份重复提交同一编号返回 HTTP 409，避免重复记录用户原文。

记忆、画像和相处方式由现有后台分批处理，回复完成不表示记忆已经更新；未形成具体、有用的新信息时可以不产生记忆。聊天按当前授权持久保存，已有授权关闭状态仍生效。测试不必先填写网页初识问卷。

## 状态、错误与费用

- `GET /api/test/chat`：接口说明，不调用模型。
- `GET /api/health`：服务与数据库健康检查，不调用模型。
- HTTP 400：输入格式错误；401：访问凭证无效；404：会话不可访问；409：重复请求。
- HTTP 502：本轮生成失败或中断。JSON 保留已经生成的 `reply`、会话和消息编号，并返回简体中文 `error`；不要将部分回复当作完整成功结果。
- HTTP 500：服务暂时无法完成操作，不返回内部配置或供应商原始错误。

POST 会调用当前服务端模型并产生相应费用，与网页调用一致。公开测试入口与网页使用相同的游客隔离，不返回模型密钥、内部系统提示词或其他用户资料。

更早的多接口调用方式仍可用：先获取 `/api/bootstrap` 的游客 Cookie，调用 `POST /api/conversations` 建立会话，再向 `POST /api/conversations/:id/messages` 发送 `{"content":"…"}` 并接收 SSE。新入口不替换网页协议。
