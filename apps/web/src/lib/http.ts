import { NextResponse } from "next/server";

export function jsonError(error: unknown, status = 500) {
  const raw = error instanceof Error ? error.message : String(error);
  const code = publicErrorCode(raw, status);
  return NextResponse.json(
    { code, error: publicErrorMessage(code, raw) },
    { status },
  );
}

export function isDeveloperMode() {
  return process.env.DEV_MODE === "true";
}

function publicErrorCode(raw: string, status: number) {
  if (/rate.?limit|429/i.test(raw)) return "rate_limited";
  if (/timeout|超时/i.test(raw)) return "timeout";
  if (/interrupt|中断/i.test(raw)) return "stream_interrupted";
  if (/auth|401|403/i.test(raw)) return "provider_authentication_failed";
  if (/invalid_response|json|schema/i.test(raw)) return "invalid_response";
  if (/conversation_not_found|对话已经不可用/.test(raw)) return "conversation_not_found";
  if (status >= 500) return "service_unavailable";
  return "request_invalid";
}

function publicErrorMessage(code: string, raw: string) {
  const messages: Record<string, string> = {
    rate_limited: "现在请求有点多，请稍后再试。",
    timeout: "这次等待有点久，请重试。",
    stream_interrupted: "回复中断了，可以从这里重试。",
    provider_authentication_failed: "模型服务暂时无法使用，请联系开发者检查配置。",
    invalid_response: "回复没有完整生成，请重试。",
    conversation_not_found: "这段对话已经不可用，请新建一段对话。",
    service_unavailable: "知微暂时无法完成这个操作，请稍后再试。",
    request_invalid: /^[\u3400-\u9fff]/u.test(raw) && !/sk-|Bearer|https?:\/\//i.test(raw) ? raw : "提交的内容不符合要求，请检查后重试。",
  };
  return messages[code] ?? messages.service_unavailable;
}
