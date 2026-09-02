# Memory 输出协议

每次 Reflection 返回 `memories[]`：

- `operation`: `create`、`supersede` 或 `promote`。
- `memoryId`: 仅在更新既有记忆时提供。
- `category`: basic、goal、interest、expression、emotion、experience、challenge、boundary。
- `content`: 面向用户可读的一条认识，不超过 600 字。
- `tier`: short 或 long。
- `confidence`: 0–1。
- `validUntil`: 短期记忆的失效时间；长期可为 null。
- `reason`: 为什么此证据足以产生这条变化。
- `evidenceMessageIds`: 产生该记忆的原始消息 ID。

Memory MCP 只接受通过 Schema 校验的输出，并以追加版本方式写入。

