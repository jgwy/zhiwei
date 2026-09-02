# 知微

知微是一个通过长期对话逐步形成用户画像、管理模型生成记忆并演化个人交互 Skill 的网页端 AI 陪伴应用。

## 本地运行

1. 启动 OrbStack。
2. 复制 `.env.example` 为 `.env`，为两个 secret 填入随机值。
3. 运行 `npm install`。
4. 运行 `docker compose up --build`。
5. 打开 `http://localhost:3000`。

默认使用零费用的 `ScriptedAdapter`。真实模型接入时只在服务端设置 `MODEL_PROVIDER`、`MODEL_NAME`、`MODEL_API_KEY` 与可选的 `MODEL_BASE_URL`。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run eval`
- `npm run test:e2e`

开发者模式由 `DEV_MODE=true` 开启，可查看运行 Trace、记忆与画像、Skill 演化过程。

## 比赛验证

本版本面向赛道三方向 1“从会回答到有温度”，在开发者模式增加“比赛实验室”：同一输入可依次运行直接回答、固定 Skills＋画像、Personal Skill 三种模式，并记录原子事实主张、来源状态和体验偏好。隐私控制支持单条记忆撤回与当前匿名用户全量数据清除；风险处理采用普通陪伴、澄清、紧急现实支持三条路径。

当前版本使用确定性的 `ScriptedAdapter` 验证 Harness 全链路，未把仿真结果表述为真实模型或真人效果。版本化观察值见 `docs/evidence/competition-baseline.json`。接入 Qwen/百炼时只新增 Model Gateway 适配器，上层编排、Memory MCP 和评测协议保持不变。

运行 `npm run package:source` 会从当前 `HEAD` 生成 `submission/source/zhiwei-source.zip`。该压缩包只包含 Git 已跟踪文件，因此不会混入 `.env`、数据库、运行报告、报名材料或技术文档草稿。
