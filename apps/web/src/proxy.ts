import { NextRequest, NextResponse } from "next/server";

const cookieName = "zhiwei_uid";
const fallbackCookieSecret = "local-development-cookie-secret-change-before-deploy";

// The proxy may run in an Edge-compatible runtime, so keep this guard Web API only.
function requireCookieSecret(): string {
  const secret = process.env.ANON_COOKIE_SECRET;
  const hardened = process.env.NODE_ENV === "production"
    || process.env.ZHIWI_FORCE_PRODUCTION_CHECKS === "true"
    || process.env.COMPETITION_MODE === "true";
  if (secret && (!hardened || (secret !== fallbackCookieSecret && secret.length >= 32))) return secret;
  if (hardened) throw new Error("生产或比赛环境缺少有效的 ANON_COOKIE_SECRET");
  return fallbackCookieSecret;
}

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const current = request.cookies.get(cookieName)?.value;
  if (!current || !(await valid(current))) {
    const id = crypto.randomUUID();
    const issuedAt = Date.now().toString();
    const signature = await sign(`${id}.${issuedAt}`);
    response.cookies.set(cookieName, `${id}.${issuedAt}.${signature}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

async function valid(value: string) {
  const [id, issuedAt, signature] = value.split(".");
  if (!id || !issuedAt || !signature) return false;
  return timingSafeEqualStrings(signature, await sign(`${id}.${issuedAt}`));
}

function timingSafeEqualStrings(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function sign(value: string) {
  const secret = requireCookieSecret();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(bytes));
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
