// Direct Ollama client — we talk to the local model straight over HTTP, no framework in between.
// For the homework we shut Maradel down and point this at raw Ollama (`--ollamaIp`), so the whole
// pipeline is provably "in-house LLM, no cloud, no internet" — which is the entire point of the bet.

const MODEL = 'gemma4:26b';

/**
 * Ask the local model and get back parsed JSON.
 * We pass a JSON **schema** as Ollama's `format` (structured outputs) — this constrains the model to
 * the EXACT keys we need, at the sampler level. Plain `format:"json"` only guarantees *valid* JSON,
 * so the model would happily return `full_name` instead of `forms` and quietly break the pipeline.
 * The schema forbids that. `temperature: 0` keeps the data-prep deterministic (reproducible KB).
 */
export async function askJson<T>(ollamaIp: string, prompt: string, schema?: object): Promise<T> {
  const url = `http://${ollamaIp}/api/generate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      format: schema ?? 'json',   // ← a JSON schema forces the exact shape; falls back to plain json
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { response?: string };
  return JSON.parse(body.response ?? '{}') as T;
}

/** Load the model into VRAM up front so the first real call isn't slow (nice for the live demo). */
export async function warmup(ollamaIp: string): Promise<void> {
  try { await askJson(ollamaIp, 'Return {"ok":true}'); } catch { /* non-fatal */ }
}
