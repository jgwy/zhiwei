import { NextRequest, NextResponse } from "next/server";

const cookieName = "zhiwei_uid";

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
  return signature === (await sign(`${id}.${issuedAt}`));
}

async function sign(value: string) {
  const secret =
    process.env.ANON_COOKIE_SECRET ??
    "local-development-cookie-secret-change-before-deploy";
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

