import type { ModelSource, ModelUsage } from "@zhiwei/core";

export type DashScopeStreamState = {
  content: string;
  sources: ModelSource[];
  usage: ModelUsage;
  usageReported: boolean;
  requestId?: string;
  finishReason: string;
  httpStatus?: number;
  providerCode?: string;
  startedAtMs?: number;
  firstTokenMs?: number;
};

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,180}$/.test(value) ? value : undefined;
}

function retainUsage(state: DashScopeStreamState, raw: any) {
  if (!raw || typeof raw !== "object") return;
  state.usageReported = true;
  const values: Partial<ModelUsage> = {
    inputTokens: raw.input_tokens ?? raw.prompt_tokens,
    outputTokens: raw.output_tokens ?? raw.completion_tokens,
    cachedInputTokens: raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens,
    reasoningTokens: raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens,
    searchCalls: raw.x_tools?.web_search?.count ?? raw.plugins?.search?.count,
  };
  for (const key of Object.keys(values) as Array<keyof ModelUsage>) {
    const value = Number(values[key]);
    if (Number.isFinite(value) && value >= 0) state.usage[key] = Math.max(state.usage[key], value);
  }
}

function retainMetadata(state: DashScopeStreamState, frame: any) {
  state.requestId = identifier(frame?.request_id) ?? state.requestId;
  state.providerCode = identifier(frame?.code) ?? state.providerCode;
  retainUsage(state, frame?.usage);
}

function acceptFrame(state: DashScopeStreamState, frame: any) {
  if (state.firstTokenMs === undefined && state.startedAtMs !== undefined) state.firstTokenMs=Date.now()-state.startedAtMs;
  retainMetadata(state, frame);
  if (frame?.code) throw Object.assign(new Error("dashscope_request_failed"), { status: state.httpStatus });
  const results = frame?.output?.search_info?.search_results;
  if (Array.isArray(results)) {
    const found = results.filter((row: any) => typeof row?.url === "string").map((row: any) => ({
      title: String(row.title ?? row.url), url: row.url,
      ...(typeof row.site_name === "string" ? { siteName: row.site_name } : {}),
    }));
    state.sources = [...new Map([...state.sources, ...found].map(source => [source.url, source])).values()];
    state.usage.searchCalls = Math.max(1, state.usage.searchCalls);
  }
  const choice = frame?.output?.choices?.[0];
  const content = choice?.message?.content;
  if (Array.isArray(content)) {
    state.content += content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
  } else if (typeof content === "string") state.content += content;
  if (choice?.finish_reason && choice.finish_reason !== "null") state.finishReason = String(choice.finish_reason);
}

export async function readDashScopeStream(response: Response, state: DashScopeStreamState): Promise<void> {
  state.httpStatus = response.status;
  state.requestId = identifier(response.headers.get("x-request-id")) ?? identifier(response.headers.get("x-dashscope-request-id"));
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    retainMetadata(state, body);
    throw Object.assign(new Error("dashscope_request_failed"), { status: response.status });
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const acceptEvent = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let frame: unknown;
    try { frame = JSON.parse(data); } catch { throw new Error("invalid_response"); }
    acceptFrame(state, frame);
  };
  let exhausted = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        acceptEvent(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (done) { exhausted = true; break; }
    }
    if (pending.trim()) acceptEvent(pending);
    if (state.finishReason !== "stop" || !state.content.trim()) throw new Error("stream_interrupted");
    state.usage.searchCalls = Math.max(1, state.usage.searchCalls);
  } finally {
    if (!exhausted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
