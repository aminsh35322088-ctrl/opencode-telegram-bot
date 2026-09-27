export interface QwenModelProbeResult {
  usable: boolean;
  outputChars: number;
  reason?: string;
}

/** Verify a completed answer through the same router and SSE surface as OpenCode. */
export async function probeQwenModel(
  baseURL: string,
  routerKey: string,
  model: string,
  request: typeof fetch = fetch,
): Promise<QwenModelProbeResult> {
  try {
    const response = await request(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${routerKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `qwen/${model}`,
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply only OK." }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    const rejected = /rgv587|risk-control|waf captcha|aliyun_waf/i.test(body);
    if (rejected) return { usable: false, outputChars: 0, reason: "Qwen rejected access (RGV587/WAF)." };
    if (!response.ok) return { usable: false, outputChars: 0, reason: `Qwen probe returned HTTP ${response.status}.` };
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      return { usable: false, outputChars: 0, reason: "Qwen probe did not return an event stream." };
    }
    let output = "";
    let completed = false;
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { completed = true; continue; }
      if (!data) continue;
      const event = JSON.parse(data) as {
        error?: unknown;
        choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
      };
      if (event.error) return { usable: false, outputChars: 0, reason: "Qwen stream returned a provider error." };
      for (const choice of event.choices ?? []) {
        if (typeof choice.delta?.content === "string") output += choice.delta.content;
      }
    }
    const outputChars = output.trim().length;
    return completed && outputChars > 0
      ? { usable: true, outputChars }
      : { usable: false, outputChars, reason: "Qwen stream did not complete with answer text." };
  } catch {
    return { usable: false, outputChars: 0, reason: "Qwen stream failed, timed out, or returned invalid data." };
  }
}
