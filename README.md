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

真实模式按任务使用三种协议：普通陪伴回复走 Character Responses API 且不启用供应商长期记忆；高情绪浓度或身体不适与现实压力并存的回合由既有路由器识别，走 3.8 Flash 严格结构输出；其他结构化任务走 Chat Completions JSON Schema；事实查证走 DashScope 原生多模态接口以保留完整来源。向量仍使用 OpenAI 兼容 Embeddings。所有协议在上层统一为任务、流事件、usage、费用、延迟、来源与标准错误。

所有联网事实先经过独立 Check MCP 的 `check_claims` 工具，检查来源索引、来源质量，以及人物姓名与机构来源是否匹配；未通过的主张不会进入最终回答。科学问题还会额外加载只读的 `scientific-answering` 基底 Skill，并经过 Science MCP 进行更严格的科学来源与高影响主张审计。两个核验 MCP 都不调用生成模型，也不读写用户记忆。项目当前包含 11 个带版本与 SHA-256 清单的不可变基底 Skills。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run eval`
- `npm run test:e2e`

开发者模式由 `DEV_MODE=true` 开启，可查看运行追踪、记忆与画像、个人技能演化、比赛实验室和模型费用。费用按模型目录价格、实际 Token、缓存 Token 与搜索次数估算，不等同于阿里云账单，也不会触发产品停用。

## 比赛验证

本版本面向赛道三方向 1“从会回答到有温度”，在开发者模式增加“比赛实验室”：同一输入可依次运行直接回答、固定 Skills＋画像、Personal Skill 三种模式，并记录原子事实主张、来源状态和体验偏好。隐私控制支持单条记忆撤回与当前匿名用户全量数据清除；风险处理采用普通陪伴、澄清、紧急现实支持三条路径。

免费回归默认使用确定性的 `ScriptedGateway`、`ReplayGateway` 与 `FaultGateway`，不会产生模型费用。真实模式使用百炼千问多协议网关，已覆盖模型生成标题、动态问卷、长期记忆、人物综述、心情、滚动摘要、回访、Personal Skill 演化、科学事实查证与来源审计；真实模式失败时不会静默退回仿真回答。版本化观察值见 `docs/evidence/competition-baseline.json`。

运行 `npm run package:source` 会从当前 `HEAD` 生成 `submission/source/zhiwei-source.zip`。该压缩包只包含 Git 已跟踪文件，因此不会混入 `.env`、数据库、运行报告、报名材料或技术文档草稿。
