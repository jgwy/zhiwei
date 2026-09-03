export function assistantStreamDisposition(output: string, status: "completed" | "interrupted") {
  const hasValidOutput = output.trim().length > 0;
  return {
    persistAssistant: hasValidOutput,
    enqueueReflection: hasValidOutput && status === "completed",
  };
}
