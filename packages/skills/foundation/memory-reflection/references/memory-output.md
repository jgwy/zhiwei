# Memory 输出协议

每次 Reflection 对固定的一至三条有序证据返回 `memories[]`，数组硬上限为 3；不追加第二次语义去重调用。

## 公共字段

- `operation`: `create`、`supersede`、`promote` 或 `withdraw`。
- `reason`: 此证据为什么足以产生该动作。
- `evidenceMessageIds`: 真正支持该动作的本批 E1–E3 编号，网关精确映射为原始用户消息 ID。
- `triggerMessageId`: 本批使该动作成立的证据编号，必须包含在该动作的证据集合中。不能默认为批次末条。
- `mood.evidenceMessageIds`: 实际明确表达该心情的本批证据，记录原消息时间。
- `summaryEvidenceMessageIds`: 可进入会话摘要的具体证据；空数组不触发摘要更新。

## 创建与新版本字段

`create`、`supersede` 与 `promote` 需要：

- `category`: basic、goal、interest、expression、emotion、experience、challenge、boundary。
- `content`: 面向用户可读的一条认识，不超过 600 字。
- `tier`: `short` 或 `long`；`promote` 的目标必须为 `long`。
- `confidence`: 0–1，仅作开发诊断信息。
- `validUntil`: `short` 提供 1–30 天后的时间；`long` 为 null。

`supersede`、`promote` 与 `withdraw` 还需要：

- `memoryId`: 要改变的记忆根 ID。
- `expectedVersionId`: 模型在当前上下文中看到的活动版本 ID，用于并发保护。

`withdraw` 不提供新的 content、category、tier 或 validUntil。

Memory MCP 只接受通过 Schema、当前用户证据归属和版本检查的输出，并以追加版本方式写入。本协议不产生候选态，合法动作会直接生效。

## 长期记忆收拢

当活动长期记忆达到 48 条，或估算上下文超过 12k Token 时，将它们向约 32 条、8k Token 收拢。

- 收拢方案只合并同一 category、同一主题且语义兼容的记忆；每个输出仍是一条可独立更新的认识。
- 每个源版本只能进入一个收拢结果，输出保留全部 `sourceVersionIds`。
- 方案生成后由一次独立的结构化调用逐组核对遗漏、矛盾和过度归纳；三项均为空才可以提交。
- 方案与核对内容只进入 Trace，不作为记忆正文或新证据。
- 提交在一个版本 CAS 事务中完成；源版本已变化或核对未通过时整批不写入。

## 分类边界

- `basic`：用户明确陈述的当前身份、生活阶段或稳定基本情况。
- `goal`：用户想主动实现的未来结果，必须包含清楚的方向或期望变化。
- `interest`：持续或明确表达的兴趣、偏好主题与投入来源。
- `expression`：希望知微如何说、何时建议、是否追问等交流方式。
- `emotion`：用户明确表达且值得短期保留的情绪变化；不得写成诊断或人格。
- `experience`：已经发生、仍影响当前选择的重要经历。
- `challenge`：正在面对的压力、困难、冲突或待解决问题。
- `boundary`：不希望被提及、推断、保存或采用的明确边界。

同一句话包含真正独立的具体信息时可以拆分。例如“刚进入职场，项目验收将在周五截止，希望你先听我说”包含阶段、明确压力来源和交流偏好。但同一购物烦恼不能同时生成泛化的“生活琐事烦恼”和具体的“购物退货受阻”两条认识。

## 语义粒度

- 将“先听我说”“现在不要建议”保存为具体的交流偏好，不延伸为稳定人格特质。
- 将暂时的压力保存为近期处境，稳定的长期认识需要更持久或更明确的证据。
- 记忆正文面向用户可读，采用克制、自然、可纠正的表述，把并发、权重和任务状态留在开发记录中。
