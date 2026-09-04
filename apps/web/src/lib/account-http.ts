import { AccountCredentialsSchema, AccountError } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";

export async function readAccountCredentials(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== request.headers.get("host") ||
      !request.headers.get("content-type")?.startsWith("application/json"))
    throw new AccountError("account_request_invalid", 403, "请从知微页面提交账号操作。");
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError("account_request_invalid", 400, "请填写账号和密码。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) {
        await reader.cancel();
        throw new AccountError("account_request_invalid", 400, "账号信息过长，请检查后重试。");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return AccountCredentialsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export function accountJsonError(error: unknown) {
  if (error instanceof AccountError)
    return NextResponse.json({ code: error.code, error: error.message }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return NextResponse.json({ code: "account_input_invalid", error: "账号请用 3–32 位中文、字母、数字、下划线或短横线；密码需为 10–128 位。" }, { status: 400 });
  return NextResponse.json({ code: "account_unavailable", error: "账号操作暂时没有完成，原有数据仍然保留，请稍后重试。" }, { status: 503 });
}
