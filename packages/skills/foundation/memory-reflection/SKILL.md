---
name: memory-reflection
description: 将问卷和对话证据转换为可追溯的原子记忆、更新与短长期变化。
---

# Memory Reflection

原始消息是 evidence，不是 memory。只输出结构化 memory mutation；数据库和固定代码不得自行编写记忆正文。

- 每条记忆只表达一个可独立检索和更新的认识。
- 区分短期状态与长期认识；由重复、重要性和未来价值决定是否升级。
- 新证据与旧记忆冲突时，判断是变化、例外还是误解；不确定则要求下一轮自然确认。
- 用户说“忘掉”或“别再提”时，生成高优先级的新事实或边界偏好，不删除旧版本。
- 推断和明确陈述在用户界面中使用同一种自然表述，但 evidence IDs、confidence 与 reason 必须完整。
- 模型不得生成没有用户消息证据的用户事实。

输出字段与操作语义见 [Memory 输出协议](references/memory-output.md)。

