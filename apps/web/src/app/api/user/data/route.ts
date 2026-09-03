import { deleteAllUserData } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId, USER_COOKIE } from "@/lib/session";

const InputSchema = z.object({ confirmation: z.literal("删除知微中的全部数据") });

export async function DELETE(request: Request) {
  try {
    const userId = await getSessionUserId();
    InputSchema.parse(await request.json());
    await deleteAllUserData(userId);
    const response = NextResponse.json({ deleted: true });
    response.cookies.delete(USER_COOKIE);
    return response;
  } catch (error) {
    return jsonError(error, 400);
  }
}
