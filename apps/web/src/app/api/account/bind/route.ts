import { bindAccount } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { readAccountCredentials, accountJsonError } from "@/lib/account-http";
import { getSessionUserId } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const credentials = await readAccountCredentials(request);
    return NextResponse.json({ account: await bindAccount(await getSessionUserId(), credentials) });
  } catch (error) { return accountJsonError(error); }
}
