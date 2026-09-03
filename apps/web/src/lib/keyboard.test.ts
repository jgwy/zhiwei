import { describe, expect, it } from "vitest";
import { shouldSubmitOnEnter } from "./keyboard";

describe("Chinese input composition", () => {
  const enter = { key: "Enter", shiftKey: false, nativeEvent: {} };
  it("submits plain Enter but keeps Shift+Enter as a newline", () => {
    expect(shouldSubmitOnEnter(enter)).toBe(true);
    expect(shouldSubmitOnEnter({ ...enter, shiftKey: true })).toBe(false);
  });
  it("does not submit Enter while confirming an IME candidate", () => {
    expect(shouldSubmitOnEnter(enter, true)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, nativeEvent: { isComposing: true } })).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, nativeEvent: { keyCode: 229 } })).toBe(false);
  });
});
