const errors = [];
const insecureSecrets = new Set([
  "local-development-cookie-secret-change-before-deploy",
  "local-development-mcp-token",
]);

function requireStrongSecret(name) {
  const value = process.env[name] ?? "";
  if (value.length < 32 || insecureSecrets.has(value) || /replace|change.?me|placeholder/i.test(value)) {
    errors.push(`${name} 必须是至少 32 字符的非默认随机密钥`);
  }
}

requireStrongSecret("ANON_COOKIE_SECRET");
requireStrongSecret("INTERNAL_MCP_TOKEN");

if (process.env.COMPETITION_MODE === "true") {
  if (!["aliyun", "bailian", "aliyun-bailian"].includes(process.env.MODEL_PROVIDER)) {
    errors.push("COMPETITION_MODE=true 时 MODEL_PROVIDER 必须是 aliyun-bailian");
  }
  if (!process.env.MODEL_API_KEY || process.env.MODEL_API_KEY.length < 16 || /replace|placeholder/i.test(process.env.MODEL_API_KEY)) {
    errors.push("比赛模式缺少可用的 MODEL_API_KEY");
  }
  try {
    const base = new URL(process.env.MODEL_BASE_URL ?? "");
    if (base.protocol !== "https:" || !base.hostname.endsWith("aliyuncs.com") || !base.pathname.endsWith("/compatible-mode/v1") || /YOUR_|placeholder/i.test(base.href)) {
      errors.push("MODEL_BASE_URL 必须是阿里云百炼 HTTPS OpenAI 兼容地址");
    }
  } catch {
    errors.push("比赛模式缺少合法的 MODEL_BASE_URL");
  }
  for (const name of ["MODEL_DIALOGUE_NAME", "MODEL_BACKGROUND_NAME", "MODEL_EMBEDDING_NAME"]) {
    if (!(process.env[name] ?? "").toLowerCase().startsWith("qwen")) errors.push(`${name} 必须配置为 Qwen 系列模型`);
  }
}

if (errors.length) {
  console.error("知微启动前检查失败：\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(process.env.COMPETITION_MODE === "true"
  ? "比赛模式检查通过：百炼/Qwen、Base URL 与服务端密钥配置完整。"
  : "本地模式检查通过：服务端密钥配置完整。");
