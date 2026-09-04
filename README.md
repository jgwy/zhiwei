# 知微

知微是一个通过长期对话逐步形成用户画像、管理模型生成记忆并演化个人交互 Skill 的网页端 AI 陪伴应用。

## 运行与部署

主部署环境为 Linux，使用 Docker Engine 和 Compose 插件。项目 Node.js 基线为 `24.20.0` LTS，版本记录在 `.node-version`；不要求修改系统全局 Node。macOS 本地开发可使用 OrbStack 提供相同的 Docker CLI 和 Compose 命令。

在仓库根目录运行：

```sh
npm ci
npm run setup:env
docker compose up -d --build
```

打开 `http://localhost:3000`。`setup:env` 在 `.env` 不存在时从示例创建配置，只为缺失或空白的 `ANON_COOKIE_SECRET`、`INTERNAL_MCP_TOKEN` 生成随机值；已有配置保留，密钥不输出到终端。默认模型为零费用仿真模式。

服务器部署时，在 `.env` 中配置 `ZHIWEI_DOMAIN`，完成域名解析后运行：

```sh
docker compose --profile production up -d --build
```

生产 profile 启用 Caddy 反向代理和 TLS，使用 80、443 端口。Web 默认仅绑定服务器本机的 3000 端口；反向代理关闭流式缓冲。Compose 启动时先执行前向数据库迁移，然后启动 MCP、Worker 和 Web，继续使用现有 PostgreSQL 卷。

### 源码开发与构建

本机只运行数据库容器时，先运行 `docker compose up -d postgres` 和 `npm run db:migrate`，再在不同终端分别运行：

```sh
npm run dev:mcp
npm run dev:science-mcp
npm run dev:worker
npm run dev
```

`.env.example` 使用本机 PostgreSQL 和 MCP 地址；Compose 会覆盖为容器内部地址。后台开发入口使用 Node 原生环境文件加载和 watch，配合 `tsx` 执行 TypeScript。Next.js 在配置入口使用 Node 原生 `process.loadEnvFile` 读取根 `.env`，已有环境变量优先。

工具链采用 TypeScript `7.0.2`、Turbopack 与稳定版 React Compiler `1.0.0`，保留现有 Next.js、React、Tailwind 和 npm workspace。`npm run build` 构建 Web 及后台；`npm run build:server` 使用 esbuild `0.28.2` 预编译 Worker、两个 MCP 和迁移入口，并复制迁移 SQL。

生产后台由 Node 直接运行 `.mjs` 产物，不依赖运行时 TypeScript 转换；后台镜像通过 `npm ci --omit=dev` 安装所需生产依赖。Web 使用 Next.js standalone。构建上下文排除 `.env`、`submission/` 和测试报告，后台运行镜像不携带开发依赖；开发环境仍可热更新源码。

## 模型与对话

默认使用零费用的 `ScriptedGateway`。接入阿里云百炼时，在服务端设置：

- `MODEL_PROVIDER=aliyun-bailian`
- `MODEL_DIALOGUE_NAME=qwen-plus-character`
- `MODEL_BACKGROUND_NAME=qwen3.8-flash`
- `MODEL_EMBEDDING_NAME=qwen3.7-text-embedding`
- `MODEL_API_KEY` 与工作空间专属 `MODEL_BASE_URL`

真实模式按任务使用多种协议：普通陪伴与高情绪回复优先走 Character 的 Chat Completions；Flash 正文使用 Responses 文本流。标题、问卷规划、Reflection、画像、摘要与 Personal Skill 等结构化任务使用 Chat Completions JSON Schema；事实查证使用 DashScope 原生接口保留来源；向量使用 OpenAI 兼容 Embeddings。各协议统一记录任务、尝试、流事件、usage、费用、耗时、来源与标准错误。

Character 和 Flash 共用基底 Skills，不维护另一套独立人格提示。实际发送的 system/messages、Skill 版本、尝试编号、估算上下文预算和实际使用的记忆版本可在开发者运行记录中查看；认证信息与密钥被隐藏，推理过程不保存。最终请求预算包括任务说明、事实主张和重试提示，超限时缩减旧上下文，不扩大最近十二条消息的窗口。

陪伴先跟随用户的具体处境：忧伤时先安静承接，喜悦时自然回应，用户指出语气不合适时直接修复。明确请求更多陪伴时以 200–400 字、2–4 段为生成目标，不用字数规则改写已显示的内容。真实质量通过代表性对话人工复核，不把提示要求本身当作已经达到的效果。

用户消息持久化后立即建立 SSE，准备上下文和查证事实时发送阶段事件。正文直接转发上游增量：首次缓冲 32 个非空白字符检查明显技术异常，之后保留 8 字尾缓冲检查跨分块乱码；正常短答结束时直接放行，不强求达到前缀长度。记忆控制回合还在首段放行前检查是否把待处理操作说成已经完成。陪伴正文开头出现明确的内部思路前导时，在尚未显示前使用原有重试；正常术语括注保留，供应商独立推理字段不进入正文。字数、段落、追问数量和建议时机用于提示与运行诊断，不再等待整篇验收或改写已经显示的正文。

在正文尚未显示时，Character 可重试一次，再降级 Flash；已经显示正文后发生断流，不自动重放、拼接其他模型或替换原文。停止、断流与截断保留已显示内容并标记状态，完成事件立即解锁输入。前端按动画帧合并增量，避免人为增加长时间的打字延迟。

最新一条回复支持重试或重新生成，包括已完成、已停止和失败状态。服务端复用原用户消息并建立新的助手尝试，旧尝试保留在开发者记录；不会重复创建用户证据、记忆批次或标题任务。新回复可更新会话摘要，但不因措辞变化重新学习用户画像。

科学问题会额外加载只读的 `scientific-answering` 基底 Skill，并经过独立 Science MCP：先审查来源等级和原子主张，最后由 Flash 流式表达，来源卡片保留真实检索和审计链。写作正文同样直接走文本流，不等待完整 `content` JSON。Science MCP 提供 `science_source_assess` 与 `science_claim_audit`，不联网、不调用模型、不读写用户记忆；高影响主张缺少权威一手证据时会转为需要人工复核。项目当前包含 11 个带版本与 SHA-256 清单的不可变基底 Skills。

外部事实优先查证，但用户只是提到歌曲或人物并表达感受时，可以直接陪伴。“来源呢”等事实追问根据上一问题与回答还原核验对象，上一轮回答不作为证据。来源链接去重后重排索引，没有有效绑定的主张不会作为已核实事实传给正文模型。核验不可用时可明确补充未核实的一般常识，但不猜具体履历、发行时间、最新信息或高影响结论。搜索计时从实际检索开始，到检索完成即结束，不把之后的事实整理算入搜索时长。

## 记忆生命周期

首次认识的前三题直接使用通用题，回答提交不等待模型规划。第一题提交后，后台为第四题及以后准备两道候选，按 80% 画像缺口、20% 相邻探索选题；未准备好时使用通用备用题，后台结果顺延，不替换已显示的问题。三题后可立即进入聊天，记忆和画像异步整理。

原始问卷和对话是 evidence，记忆正文由 Reflection 模型生成。同一会话累计三条用户消息，或最后一条之后空闲十分钟，触发一次固定批次；明确记住、纠正、忘记指令立即进入后台处理。停止或回复失败不丢弃已提交的用户证据。

每批一次 Reflection 同时判断批内和新旧内容，通常输出 0–2 个动作，硬上限 3 个。模型使用 `E1`–`E3` 选择真正支持各动作的证据，系统映射为消息 ID，不把最后一条强加给所有动作。只记录具体、新增且对后续交流有用的信息；只有“最近有点烦”之类未说明具体处境的表达，保留原文，不派生记忆、心情、画像、摘要、回访或相处方式。

Reflection 最多读取 12 条相关旧认识候选；同一事件的细化替代原版本，无新事实则不写入，独立事件分别保留。向量与关键词负责找候选，模型负责语义判断。本次机制约束新增写入，不批量清理历史条目。

合法的 `create`、`supersede`、`promote` 和 `withdraw` 动作经过用户范围、授权、证据归属、版本 CAS 和幂等校验后直接生效，不存在候选确认队列。

- 近期记忆在同一用户的多个会话中共享，模型给出 1–30 天有效期，异常值回落为 7 天。
- 长期记忆不自动过期；“关于你的长期认识”只由活动长期原子记忆合成，不把情绪和边界原子写进长文。
- 每次回答最多取 5 条长期和 3 条近期记忆；向量失败时先用中文关键词检索，再由后台任务幂等补齐向量。
- 每批最多产生一个有具体依据的最后整体心情，使用实际证据时间，不平均三条消息的情绪，也不使用后台执行时间。
- 长期原子记忆达到 48 条或约 12k Token 时，模型在同类别、同主题内收拢，再由独立结构化调用核对遗漏、矛盾和过度推断。
- 了解度只使用活动长期记忆、独立会话、时间跨度和用户反馈；近期记忆、消息数、使用时长和模型 confidence 不直接加分。

完整状态机、收拢与失败语义见 [`docs/memory-lifecycle.md`](docs/memory-lifecycle.md)。用户的授权范围与全量数据删除集中在左下角“设置”页；右侧洞察栏只展示了解度、心情、长期认识与近期认识。

游客身份由服务端签名 Cookie 管理，也可在右侧栏底部绑定账号和密码。恢复账号会将历史会话、记忆和画像与当前游客数据合并，保留每段聊天的消息、ID 和顺序，不把旧聊天正文拼进当前对话。初识页也可直接恢复已有账号。数据库和 MCP 操作始终限定已验证的当前用户范围。

授权取两侧较保守的组合；任一侧已关闭的项目不会自动打开。相处方式先沿用原账号，游客版本保存在版本史；画像通过后台重新整理。回复或后台任务执行中暂不合并，完成后可重试；重复恢复不会重复导入。当前已绑定另一账号时不允许直接合并两个账号。密码以随机盐加 scrypt（N=32768、r=8、p=3）保存，不发送给模型，也不写入 Trace。账号暂不提供忘记密码找回，合并后不提供拆分入口。

设置中的总记忆开关只暂停，不改变近期、长期两个分层偏好；停用某层后停止该层新增与召回，已有内容仍可查看。关闭情绪后停止心情与情绪类记忆的新增和召回。全量删除作用于当前完整档案，包含绑定账号、已合并的游客数据和设备身份关联，不影响其他账号。部署使用既有前向迁移流程执行 `012_accounts.sql`，无需操作数据卷。

## 数据加载与后台调度

- bootstrap 返回会话元信息及当前会话最近 80 条消息，不再装载所有会话原文；向上滚动分页读取历史，并保持原滚动位置。浏览器缓存最近三个会话，空闲时预取近期会话。
- Activity 更新合并当前生成中回合，使用请求身份隔离，避免后台更新覆盖未完成消息；开发者组件和各标签数据按需加载，费用调用明细折叠后不创建整页重型内容。
- Web 进程共享 PostgreSQL `LISTEN/NOTIFY` 连接，通过持久事件游标补读 Activity，避免每个浏览器持续按秒查询。Worker 按通知和最近到期任务唤醒，问卷规划与顺序记忆任务分别处理。
- 单 Worker 启动时恢复遗留 `running` 任务；退出时停止领取、传播取消并关闭连接。数据库幂等结果用于避免重试产生重复业务版本。
- 输入框、稳定历史和生成中的消息分离更新，复用时间格式化器。输入法组合期间确认候选的 Enter 不发送，输入框自动增高至约 180px，触屏操作按钮保持可访问。

消息分页为 `GET /api/conversations/:id/messages?before=...`；最新回复重试为 `POST /api/conversations/:id/messages/:messageId/retry`，与普通发送共用 SSE 协议。普通界面错误使用简体中文，运行追踪保留内部诊断。页头提示为“记忆会在授权后用于个性化对话；AI 生成内容请注意核查”。

`GET /api/bootstrap` 与 `GET /api/mood` 接受浏览器的 IANA `timeZone`，缺失或无效时使用 `Asia/Shanghai`。心情按设备时区聚合为 `YYYY-MM-DD` 日期键，图表 Tooltip 使用该日期；原始样本保持 UTC，换时区只改变按日展示，不修改历史记录。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run eval`
- `ALLOW_PAID_MODEL_TESTS=true REAL_TEST_BUDGET_CNY=5 npm run eval:real-memory`（显式付费测试）
- `ALLOW_PAID_MODEL_TESTS=true REAL_TEST_BUDGET_CNY=5 npm run eval:real-experience`（需提供独立测试服务的 `EXPERIENCE_BASE_URL` 和 `INTEGRATION_DATABASE_URL`）
- `ALLOW_PAID_MODEL_TESTS=true COMPANION_BUDGET_CNY=20 npm run eval:real-companion`（需提供独立端口的 `COMPANION_BASE_URL` 与测试库 `INTEGRATION_DATABASE_URL`）
- `ALLOW_PAID_MODEL_TESTS=true COMPANION_BUDGET_CNY=20 npm run eval:real-companion-direct`（直接验证真实 Character；检索不可用状态明确标为测试注入）
- `npm run test:e2e`

数据库生命周期集成测试默认跳过，需为独立测试库设置 `INTEGRATION_DATABASE_URL` 后单独运行。

开发者模式由 `DEV_MODE=true` 开启，可查看运行追踪、记忆与画像、个人技能演化、比赛实验室和模型费用。费用总计独立于调用记录分页，按全部历史 usage、缓存 Token、搜索次数与对应价格估算；价格目录失败时保留最近快照。供应商首 Token、用户首字和总耗时分别记录，未返回 usage 的失败或取消尝试不标为真实零消耗。费用估算不等同于阿里云账单，也不会触发产品停用。

默认测试、构建和离线评测不调用付费模型。真实测试必须显式启用，并受命令指定预算约束。陪伴测试使用合成场景，不读取原用户会话；每次运行生成独立 JSON 记录，可通过 `COMPANION_ALREADY_SPENT_CNY` 传入本批已用额度，通过 `COMPANION_REMAINING_CNY` 限制本次余量。费用按实际 usage、检索费用和未知 usage 预留累计，质量目标只作人工复核与诊断。测试结果、浏览器检查和性能对比以实际运行记录为准。

## 比赛验证

本版本面向赛道三方向 1“从会回答到有温度”，在开发者模式增加“比赛实验室”：同一输入可依次运行直接回答、固定 Skills＋画像、Personal Skill 三种模式，并记录原子事实主张、来源状态和体验偏好。隐私控制支持单条记忆撤回与当前匿名用户全量数据清除；风险处理采用普通陪伴、澄清、紧急现实支持三条路径。

免费回归使用确定性的 `ScriptedGateway`、`ReplayGateway` 与 `FaultGateway`。比赛实验室保留真实千问脱敏 Replay，供查看历史对话、模型路由、记忆变化和来源链；回放不会导入当前用户画像，也不作为当前版本测试已通过的证明。真实模式失败时不会静默退回仿真回答。

运行 `npm run package:source` 会从当前 `HEAD` 生成 `submission/source/zhiwei-source.zip`。该压缩包只包含 Git 已跟踪文件，因此不会混入 `.env`、数据库、运行报告、报名材料或技术文档草稿。
