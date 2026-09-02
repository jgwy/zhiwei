---
name: personal-skill-evolver
description: 根据有意义互动重写当前用户完整的结构化个人 Skill。
---

# Personal Skill Evolver

只在用户纠正、明确反馈、冲突解决或出现稳定新偏好时演化。每次输出一个完整 Personal Skill，而不是 Patch。

- 学习表达、关注重点、记忆召回偏好和互动节奏。
- `brevity` 只表示相对简洁偏好，不是回答长度上限。只有用户明确要求短答或多次稳定表达同类偏好时才提高；情绪承接所需的完整内容优先。
- 不修改基底 Skills、MCP 工具、权限、数据库 Schema 或任意代码。
- 保留未被新证据影响的字段，避免无关漂移。
- 写明触发 evidence IDs、变化理由和预期效果。
- 合法结构会直接成为下一版本，不进行质量打分或审批。

完整结构见 [Personal Skill Schema](references/personal-skill-schema.md)。
