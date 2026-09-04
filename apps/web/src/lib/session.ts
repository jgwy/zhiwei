import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { resolveAccountUserId } from "@zhiwei/core";

export const USER_COOKIE = "zhiwei_uid";

export async function getSessionUserId(): Promise<string> {
  const cookie = (await cookies()).get(USER_COOKIE)?.value;
  if (!cookie) throw new Error("anonymous_session_missing");
  const [id, issuedAt, signature] = cookie.split(".");
  if (!id || !issuedAt || !signature) throw new Error("anonymous_session_invalid");
  const expected = sign(`${id}.${issuedAt}`);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("anonymous_session_invalid");
  }
  return resolveAccountUserId(id);
}

function sign(value: string): string {
  const secret =
    process.env.ANON_COOKIE_SECRET ??
    "local-development-cookie-secret-change-before-deploy";
  return createHmac("sha256", secret).update(value).digest("base64url");
}
