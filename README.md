# 知微

知微是一个通过长期对话逐步形成用户画像、管理模型生成记忆并演化个人交互 Skill 的网页端 AI 陪伴应用。

## 本地运行

1. 启动 OrbStack。
2. 复制 `.env.example` 为 `.env`，为两个 secret 填入随机值。
3. 运行 `npm install`。
4. 运行 `docker compose up --build`。
5. 打开 `http://localhost:3000`。

默认使用零费用的 `ScriptedGateway`。接入阿里云百炼时，在服务端设置：

- `MODEL_PROVIDER=aliyun-bailian`
- `MODEL_DIALOGUE_NAME=qwen-plus-character`
- `MODEL_BACKGROUND_NAME=qwen3.8-flash`
- `MODEL_EMBEDDING_NAME=qwen3.7-text-embedding`
- `MODEL_API_KEY` 与工作空间专属 `MODEL_BASE_URL`

真实模式按任务使用多种协议：普通陪伴与高情绪回复优先走 Character 的 Chat Completions；每次候选先在服务端完整接收并通过正文质量检查，再以 SSE 增量发送。Character 连续两次不合格时，降级到 3.8 Flash 的 Responses 纯文本通道，不会退回仿真内容。标题、问卷、Reflection、画像、摘要与 Personal Skill 等结构化任务走 Chat Completions JSON Schema；事实查证走 DashScope 原生多模态接口以保留完整来源；向量使用 OpenAI 兼容 Embeddings。所有协议在上层统一为任务、尝试记录、流事件、usage、费用、延迟、来源与标准错误。

科学问题会额外加载只读的 `scientific-answering` 基底 Skill，并经过独立 Science MCP：先审查来源等级和原子主张，再把通过审查的主张交给回答模型。它提供 `science_source_assess` 与 `science_claim_audit`，不联网、不调用模型、不读写用户记忆；高影响主张缺少权威一手证据时会转为需要人工复核。项目当前包含 11 个带版本与 SHA-256 清单的不可变基底 Skills。

## 记忆生命周期

原始问卷和对话是 evidence，记忆正文由 Reflection 模型生成。合法的 `create`、`supersede`、`promote` 和 `withdraw` 动作经过用户范围、授权、证据归属、版本 CAS 和幂等校验后直接生效，不存在隐式候选或确认队列。当前触发消息 ID 由系统绑定，模型不负责抄写数据库证据 ID；明确撤回使用窄结构化选择器，只让模型从当前候选中选择精确版本。

- 近期记忆在同一用户的多个会话中共享，模型给出 1–30 天有效期，异常值回落为 7 天。
- 长期记忆不自动过期；“关于你的长期认识”只由活动长期原子记忆合成，不把情绪和边界原子写进长文。
- 每次回答最多取 5 条长期和 3 条近期记忆；向量失败时先用中文关键词检索，再由后台任务幂等补齐向量。
- 长期原子记忆达到 48 条或约 12k Token 时，模型在同类别、同主题内收拢，再由独立结构化调用核对遗漏、矛盾和过度推断。
- 了解度只使用活动长期记忆、独立会话、时间跨度和用户反馈；近期记忆、消息数、使用时长和模型 confidence 不直接加分。

完整状态机、收拢与失败语义见 [`docs/memory-lifecycle.md`](docs/memory-lifecycle.md)。用户的授权范围与全量数据删除集中在左下角“设置”页；右侧洞察栏只展示了解度、心情、长期认识与近期认识。

所有陪伴回复都先经过质量门再进入 SSE。系统在发送和入库前检查有效文字比例、连续标点、重复段落、词汇多样性、控制字符、原句照抄和追问数量；高情绪回合还检查篇幅、分段与建议时机。退化输出会携带具体原因重试或降级为纯文本生成，仍不合格时返回稳定错误，不会保存为助手消息或触发记忆反思。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run eval`
- `ALLOW_PAID_MODEL_TESTS=true REAL_TEST_BUDGET_CNY=5 npm run eval:real-memory`（显式付费测试）
- `npm run test:e2e`

数据库生命周期集成测试默认跳过，需为独立测试库设置 `INTEGRATION_DATABASE_URL` 后单独运行。

开发者模式由 `DEV_MODE=true` 开启，可查看运行追踪、记忆与画像、个人技能演化、比赛实验室和模型费用。费用按模型目录价格、实际 Token、缓存 Token 与搜索次数估算，不等同于阿里云账单，也不会触发产品停用。

## 比赛验证

本版本面向赛道三方向 1“从会回答到有温度”，在开发者模式增加“比赛实验室”：同一输入可依次运行直接回答、固定 Skills＋画像、Personal Skill 三种模式，并记录原子事实主张、来源状态和体验偏好。隐私控制支持单条记忆撤回与当前匿名用户全量数据清除；风险处理采用普通陪伴、澄清、紧急现实支持三条路径。

免费回归默认使用确定性的 `ScriptedGateway`、`ReplayGateway` 与 `FaultGateway`，不会产生模型费用。真实模式使用百炼千问多协议网关，已覆盖模型生成标题、动态问卷、长期记忆、人物综述、心情、滚动摘要、回访、Personal Skill 演化、科学事实查证与来源审计；真实模式失败时不会静默退回仿真回答。比赛实验室内置 10 组、31 轮真实千问脱敏 Replay，本次最终生成的估算费用为 ¥0.111812。版本化观察值见 `docs/evidence/competition-baseline.json`。

运行 `npm run package:source` 会从当前 `HEAD` 生成 `submission/source/zhiwei-source.zip`。该压缩包只包含 Git 已跟踪文件，因此不会混入 `.env`、数据库、运行报告、报名材料或技术文档草稿。
