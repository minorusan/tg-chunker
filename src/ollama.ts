// Direct Ollama client — we talk to the local model straight over HTTP, no framework in between.
// For the homework we shut Maradel down and point this at raw Ollama (`--ollamaIp`), so the whole
// pipeline is provably "in-house LLM, no cloud, no internet" — which is the entire point of the bet.

const MODEL = 'gemma4:26b';

/**
 * Ask the local model and get back parsed JSON.
 * We call /api/chat (proper chat templating) and DO NOT use Ollama's `format` constraint. Grammar-
 * constrained decoding (both `format:"json"` and a JSON schema) pushes the sampler into a repetition
 * collapse here — a decoding artefact, not a model-capability limit (unconstrained, the model returns
 * clean, correct JSON). So we ask for JSON in the prompt, parse it out of the text, and cap tokens as a
 * runaway backstop. `temperature: 0` keeps the data-prep deterministic (reproducible KB).
 * The `schema` arg is accepted but unused (kept so call sites can document their intended shape).
 */
export async function askJson<T>(ollamaIp: string, prompt: string, _schema?: object): Promise<T> {
  // IMPORTANT: use /api/chat (not /api/generate). gemma is an instruct model; the chat endpoint applies
  // its chat template so it follows instructions properly. Raw /api/generate skips the template and the
  // model degenerates (repeats a token forever). This one detail is the difference between garbage and
  // clean JSON.
  const url = `http://${ollamaIp}/api/chat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: false,              // gemma is a thinking model; keep the hot path lean
      // NOTE: we deliberately DO NOT use format:"json". Ollama's JSON mode constrains decoding with a
      // GBNF grammar, and that grammar (not the model — it's plenty capable) pushes the sampler into a
      // repetition collapse ("error error error…"). Unconstrained, the model returns clean JSON; we just
      // ask for JSON in the prompt and parse it out of the text. temperature 0 = reproducible.
      options: { temperature: 0, num_predict: 2048 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return parseLoose<T>(body.message?.content ?? '{}');
}

/** Pull JSON out of the model's text: strip ```fences, take the first {…last }, then parse — salvaging
 *  a truncated tail by closing any dangling array/object so one runaway field doesn't lose the rest. */
function parseLoose<T>(raw: string): T {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s) as T; } catch { /* salvage below */ }
  let t = s;
  const lastComplete = Math.max(t.lastIndexOf('"]'), t.lastIndexOf('"}'), t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (lastComplete > 0) t = t.slice(0, lastComplete + 1);
  const open = (c: string) => (t.match(new RegExp('\\' + c, 'g')) ?? []).length;
  t += ']'.repeat(Math.max(0, open('[') - open(']')));
  t += '}'.repeat(Math.max(0, open('{') - open('}')));
  try { return JSON.parse(t) as T; } catch { return {} as T; }
}

/** Load the model into VRAM up front so the first real call isn't slow (nice for the live demo). */
export async function warmup(ollamaIp: string): Promise<void> {
  try { await askJson(ollamaIp, 'Return {"ok":true}'); } catch { /* non-fatal */ }
}
