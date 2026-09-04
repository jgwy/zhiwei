export function shouldSubmitOnEnter(event: { key: string; shiftKey: boolean; nativeEvent: { isComposing?: boolean; keyCode?: number } }, composing = false) {
  return event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}
