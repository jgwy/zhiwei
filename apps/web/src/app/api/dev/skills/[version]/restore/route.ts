import { restorePersonalSkill, addActivity } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function POST(
  _request: Request,
  context: { params: Promise<{ version: string }> },
) {
  try {
    if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
    const userId = await getSessionUserId();
    const { version } = await context.params;
    const restored = await restorePersonalSkill(userId, version);
    await addActivity({
      userId,
      type: "skill.evolved",
      payload: { version: restored.version, message: "已恢复所选个人技能版本。" },
    });
    return NextResponse.json({ restored });
  } catch (error) {
    return jsonError(error, 400);
  }
}
