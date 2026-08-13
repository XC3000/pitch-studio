/**
 * LLM access — provider-abstracted. This is the ONE place model AND provider
 * choice lives: LLM_PROVIDER below picks OpenRouter (live multi-model
 * catalog) or DeepSeek's own API (direct, cheaper, no router hop). Every
 * caller (Q&A, scene generation) passes a model id string for whichever
 * provider is active — never hardcode a provider check or model list
 * elsewhere; import llmConfigured()/catalog()/QA_MODEL from here.
 */

export type LlmProvider = "openrouter" | "deepseek";

/**
 * Which backend serves LLM calls. Switch by editing this constant, or set
 * LLM_PROVIDER=openrouter|deepseek in .env.local to override without a code
 * change. DeepSeek direct is the cheaper default for this app's short
 * script-generation and Q&A calls; OpenRouter stays fully wired for its live
 * multi-model catalog and free-model fallback chain.
 */
const LLM_PROVIDER: LlmProvider = (process.env.LLM_PROVIDER as LlmProvider | undefined) || "deepseek";

const PROVIDER_BASE_URL: Record<LlmProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
};

/** Env var name for the active provider's key — used in user-facing error copy. */
export function llmKeyEnvVar(): string {
  return LLM_PROVIDER === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY";
}

export type ModelInfo = {
  id: string; // model id in the active provider's namespace, e.g. "deepseek-chat" (direct) or "deepseek/deepseek-chat" (OpenRouter)
  label: string;
  free: boolean;
  inPerM: number; // USD per 1M input tokens (0 for free models)
  outPerM: number; // USD per 1M output tokens
  contextLength: number | null;
};

/** Fallback default model per provider, used when LLM_DEFAULT_MODEL is unset. */
const FALLBACK_DEFAULT_MODEL: Record<LlmProvider, string> = {
  openrouter: "deepseek/deepseek-chat",
  // DeepSeek's current stable id; deprecates 2026-07-24 in favor of the
  // non-thinking mode of deepseek-v4-flash (same underlying model then).
  deepseek: "deepseek-chat",
};

export const QA_MODEL = process.env.LLM_DEFAULT_MODEL || FALLBACK_DEFAULT_MODEL[LLM_PROVIDER];

export function llmConfigured() {
  return LLM_PROVIDER === "deepseek" ? !!process.env.DEEPSEEK_API_KEY : !!process.env.OPENROUTER_API_KEY;
}

/**
 * DeepSeek has no public live-pricing catalog endpoint, so this list is
 * static — kept in sync with https://api-docs.deepseek.com/quick_start/pricing
 * (cache-miss input price; DeepSeek's own cache-hit discount isn't tracked
 * here since we don't have per-call cache-token counts).
 */
const DEEPSEEK_MODELS: ModelInfo[] = [
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat (→ V4 Flash non-thinking; id deprecates 2026-07-24)",
    free: false,
    inPerM: 0.14,
    outPerM: 0.28,
    contextLength: 128000,
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    free: false,
    inPerM: 0.14,
    outPerM: 0.28,
    contextLength: 1_000_000,
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    free: false,
    inPerM: 0.435,
    outPerM: 0.87,
    contextLength: 1_000_000,
  },
];

let cache: { at: number; models: ModelInfo[] } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Live model catalog. OpenRouter: fetched + cached for an hour. DeepSeek: static list (no discovery endpoint). */
export async function catalog(): Promise<ModelInfo[]> {
  if (LLM_PROVIDER === "deepseek") return DEEPSEEK_MODELS;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  const res = await fetch(`${PROVIDER_BASE_URL.openrouter}/models`);
  if (!res.ok) {
    if (cache) return cache.models; // serve stale rather than fail
    throw new Error(`OpenRouter model list failed (${res.status})`);
  }
  const data = (await res.json()) as {
    data: {
      id: string;
      name: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
    }[];
  };
  const models: ModelInfo[] = data.data.map((m) => {
    const inPerTok = Number(m.pricing?.prompt ?? "0");
    const outPerTok = Number(m.pricing?.completion ?? "0");
    const free = m.id.endsWith(":free") || (inPerTok === 0 && outPerTok === 0);
    return {
      id: m.id,
      label: m.name || m.id,
      free,
      inPerM: inPerTok * 1_000_000,
      outPerM: outPerTok * 1_000_000,
      contextLength: m.context_length ?? null,
    };
  });
  models.sort((a, b) => (a.free === b.free ? a.label.localeCompare(b.label) : a.free ? -1 : 1));
  cache = { at: Date.now(), models };
  return models;
}

export async function modelInfo(id: string): Promise<ModelInfo | null> {
  const models = await catalog();
  return models.find((m) => m.id === id) ?? null;
}

export function llmCostUsd(model: ModelInfo | null, inputTokens: number, outputTokens: number): number {
  if (!model) return 0;
  return (inputTokens / 1e6) * model.inPerM + (outputTokens / 1e6) * model.outPerM;
}

export type LlmUsage = { inputTokens: number; outputTokens: number; costUsd: number };

/**
 * Free OpenRouter models are frequently rate-limited upstream by their
 * hosting provider (e.g. "nousresearch/hermes-3-llama-3.1-405b:free is
 * temporarily rate-limited upstream"). Build a fallback chain — a couple of
 * other currently-free models, then the configured default — and pass it as
 * OpenRouter's `models` array so a 429 on the requested model automatically
 * fails over instead of erroring the whole request.
 */
async function fallbackChain(primary: string): Promise<string[]> {
  // OpenRouter caps `models` at 3 entries.
  const chain = [primary];
  if (!chain.includes(QA_MODEL)) chain.push(QA_MODEL);
  try {
    const models = await catalog();
    const other = models.find((m) => !chain.includes(m.id) && m.free);
    if (other) chain.push(other.id);
  } catch {
    // no catalog available — chain stays as-is
  }
  return chain;
}

function headers(): Record<string, string> {
  if (LLM_PROVIDER === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set");
    return {
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    };
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  return {
    authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://pitchstudio.app",
    "X-Title": "Pitch Studio",
  };
}

/** One-shot (non-streaming) chat completion. */
export async function chatComplete(opts: {
  model?: string;
  system: string;
  userContent: string;
  maxTokens?: number;
}): Promise<{ text: string; usage: LlmUsage; model: string }> {
  const model = opts.model || QA_MODEL;
  const body: Record<string, unknown> = {
    max_tokens: opts.maxTokens ?? 900,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.userContent },
    ],
  };
  // OpenRouter accepts a `models` fallback array (free-tier 429s are common upstream);
  // DeepSeek direct is a single-vendor call, so just pass the one model id.
  if (LLM_PROVIDER === "openrouter") body.models = await fallbackChain(model);
  else body.model = model;

  const res = await fetch(`${PROVIDER_BASE_URL[LLM_PROVIDER]}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${LLM_PROVIDER} chat completion failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    model?: string;
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const usedModel = data.model || model;
  const text = data.choices[0]?.message?.content ?? "";
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const info = await modelInfo(usedModel);
  return {
    text,
    usage: { inputTokens, outputTokens, costUsd: llmCostUsd(info, inputTokens, outputTokens) },
    model: usedModel,
  };
}

/**
 * Stream a grounded answer via the active provider's SSE chat endpoint. The
 * caller supplies the full system + user prompt (grounding lives in the user
 * turn so injection defenses in the system prompt stay authoritative).
 */
export async function streamAnswer(opts: {
  model?: string;
  system: string;
  userContent: string;
  maxTokens?: number;
  onText: (delta: string) => void;
}): Promise<{ text: string; usage: LlmUsage }> {
  const model = opts.model || QA_MODEL;
  const body: Record<string, unknown> = {
    max_tokens: opts.maxTokens ?? 1024,
    stream: true,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.userContent },
    ],
  };
  if (LLM_PROVIDER === "openrouter") {
    body.models = await fallbackChain(model);
    body.usage = { include: true };
  } else {
    body.model = model;
    // OpenAI-compatible flag DeepSeek uses to include a usage chunk in the stream.
    body.stream_options = { include_usage: true };
  }

  const res = await fetch(`${PROVIDER_BASE_URL[LLM_PROVIDER]}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`${LLM_PROVIDER} stream failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let usedModel = model;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      let parsed: {
        model?: string;
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.model) usedModel = parsed.model;
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        opts.onText(delta);
      }
      if (parsed.usage) {
        inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
        outputTokens = parsed.usage.completion_tokens ?? outputTokens;
      }
    }
  }

  const info = await modelInfo(usedModel);
  return { text, usage: { inputTokens, outputTokens, costUsd: llmCostUsd(info, inputTokens, outputTokens) } };
}
