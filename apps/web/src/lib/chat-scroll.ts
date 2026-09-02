export const CHAT_BOTTOM_THRESHOLD_PX = 96;

export function distanceFromBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isNearChatBottom(
  dimensions: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = CHAT_BOTTOM_THRESHOLD_PX,
) {
  return distanceFromBottom(dimensions) <= threshold;
}
