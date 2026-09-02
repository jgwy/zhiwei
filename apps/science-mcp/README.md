# Science MCP

Science MCP 是知微内部使用的确定性科学证据审计服务。它不调用模型、不访问互联网，也不直接生成科学结论；服务只评估调用方提供的来源，并检查原子主张的证据引用是否满足最低质量要求。

## 工具

- `science_source_assess`：评估每条来源的权威等级和理由。
- `science_claim_audit`：校验主张的来源索引与来源质量。`sourceIndices` 使用 `sources` 数组中从 0 开始的索引；越界索引会被移除并返回在 `invalidSourceIndices`。高影响主张没有可识别的权威一手来源或原始研究时，即使输入状态是 `supported`，也会转为 `human_review`。

服务使用无会话 JSON-RPC over HTTP。除健康检查外，请求必须携带内部 Bearer Token；工具调用还必须携带有效的 `x-zhiwei-user`，用于隔离并记录当前匿名用户的运行 Trace。服务不写入记忆、画像或其他用户业务数据。
