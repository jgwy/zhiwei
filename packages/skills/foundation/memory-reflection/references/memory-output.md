# Memory 输出协议

每次 Reflection 返回 `memories[]`，数组硬上限为 3。

## 公共字段

- `operation`: `create`、`supersede`、`promote` 或 `withdraw`。
- `reason`: 此证据为什么足以产生该动作。
- `evidenceMessageIds`: 支持该动作的原始用户消息 ID；必须包含当前源消息。

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

一句话包含多个类别时拆成多条。例如“刚进入职场，项目压力很大，希望你先听我说”应分别形成 `basic`、`challenge` 与 `expression`，不能合并成 `goal`。

## 语义粒度

- 将“先听我说”“现在不要建议”保存为具体的交流偏好，不延伸为稳定人格特质。
- 将暂时的压力保存为近期处境，稳定的长期认识需要更持久或更明确的证据。
- 记忆正文面向用户可读，采用克制、自然、可纠正的表述，把并发、权重和任务状态留在开发记录中。
