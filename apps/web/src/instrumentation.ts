export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build") return;
  // The Compose deployment owns one Web process; a new process can recover its
  // predecessor's interrupted attempts before accepting fresh requests.
  const { recoverReplyAttempts } = await import("@zhiwei/core");
  await recoverReplyAttempts();
}
