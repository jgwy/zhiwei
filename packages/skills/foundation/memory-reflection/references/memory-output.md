# Memory 输出协议

每次 Reflection 返回 `memories[]`：

- `operation`: `create`、`supersede` 或 `promote`。
- `memoryId`: 仅在更新既有记忆时提供。
- `expectedVersionId`: 与 `memoryId` 成对出现，指向模型实际看到的活动版本。
- `category`: basic、goal、interest、expression、emotion、experience、challenge、boundary。
- `content`: 面向用户可读的一条认识，不超过 600 字。
- `tier`: short 或 long。
- `confidence`: 0–1。
- `validUntil`: 短期记忆的失效时间；长期可为 null。
- `reason`: 为什么此证据足以产生这条变化。
- `evidenceMessageIds`: 产生该记忆的原始消息 ID。
- `sourceType`: `user_stated` 表示原文直接支持，`inferred` 表示需要概括或推测。
- `evidenceQuote`: `user_stated` 时提供原消息中的连续原文片段。

Memory MCP 只接受通过 Schema 校验的输出，并以追加版本方式写入。服务端会重新校验证据归属和原文片段，同时覆盖模型建议的作用域与生效状态：

- 短期记忆固定绑定来源会话，最长 7 天。
- 新增的长期推断和所有更新都先成为待确认候选，不进入回答上下文或画像。
- 用户确认候选后，系统保留候选版本，另行生成新的活动版本。
- 确认、拒绝、撤回和过期都进入事件账本，并用幂等键防止重试重复写入。

## 分类边界

- `basic`：用户明确陈述的当前身份、生活阶段或稳定基本情况。
- `goal`：用户想主动实现的未来结果，必须包含清楚的方向或期望变化。
- `interest`：持续或明确表达的兴趣、偏好主题与投入来源。
- `expression`：希望知微如何说、何时建议、是否追问等交流方式。
- `emotion`：用户明确表达且值得短期保留的情绪变化；不得写成诊断或人格。
- `experience`：已经发生、仍影响当前选择的重要经历。
- `challenge`：正在面对的压力、困难、冲突或待解决问题。
- `boundary`：不希望被提及、推断、保存或采用的明确边界。

一句话包含多个类别时拆成多条。例如“刚进入职场，项目压力很大，希望你先听我说”应分别形成 `basic`、`challenge` 与 `expression`，不能合并成 `goal`。

## 禁止的过度推断

- 不从“先听我说”“不要建议”推断防御性、控制欲、依赖或人格特质。
- 不把暂时的压力写成长期情绪模式，不把一次低落写成心理健康结论。
- 不用“高权重即时指令”等内部措辞面向用户；记忆正文应是克制、自然、可纠正的认识。
