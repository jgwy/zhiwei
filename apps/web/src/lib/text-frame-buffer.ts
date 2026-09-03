/** At most one React update per animation frame. Never create a simulated typing backlog. */
export function createTextFrameBuffer(
  deliver: (text: string) => void,
  schedule = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancel = (id: number) => cancelAnimationFrame(id),
) {
  let pending = "";
  let frame: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (frame !== null) cancel(frame);
    if (deadline !== null) clearTimeout(deadline);
    frame = null;
    deadline = null;
    const text = pending;
    pending = "";
    if (text) deliver(text);
  };
  return {
    push(text: string) {
      pending += text;
      if (frame === null) {
        frame = schedule(flush);
        // Background tabs may suspend rAF. Keep the state current when timers can run.
        deadline = setTimeout(flush, 160);
      }
    },
    flush,
    dispose() {
      if (frame !== null) cancel(frame);
      if (deadline !== null) clearTimeout(deadline);
      frame = null;
      deadline = null;
      pending = "";
    },
  };
}
