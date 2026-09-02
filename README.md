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
