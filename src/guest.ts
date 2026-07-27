// GUEST GATE — this tool as a polite citizen of a SHARED GPU (the "one door" discipline).
//
// The host machine runs one LLM server shared by several applications, arbitrated by a resource
// gateway (POST /resource/llm): named authorities own the model; `guest` is the LOWEST authority —
// it uses the default chat model (shares it, so a guest grant swaps nothing) and only ever gets a
// grant when nobody else holds the resource.
//
// INTENTION: LEAST PRIORITY, ALWAYS YIELDS. Before every LLM call the pipeline calls ensure():
//   - we hold a fresh grant → proceed (refreshed every few minutes to slide the TTL);
//   - resource busy (a higher-priority app is using the GPU) → WAIT, polling until free. The
//     checkpointed pipeline makes waiting free — it just pauses between windows.
//   - we get preempted mid-run → the next ensure() sees `busy` and waits again. Nothing is lost.
// Fail-loud: if the gateway is unreachable while gating was requested, we crash — running ungated
// when gating was asked for would be a silent race with someone's live work.

const REFRESH_MS = 4 * 60 * 1000;   // re-enqueue cadence (grant TTL below is 10 min)
const GRANT_TTL_MS = 10 * 60 * 1000; // short grant → a killed run frees the resource quickly
const POLL_MS = 20_000;              // how often to knock while someone else holds the LLM

export class GuestGate {
  private token: string | null = null;
  private lastGrant = 0;
  private waitingOn: string | null = null;
  private readonly base: string;
  private readonly log: (s: string) => void;

  constructor(base: string, log: (s: string) => void) { this.base = base; this.log = log; }

  private async op(op: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, any>> {
    const res = await fetch(`${this.base}/resource/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(timeoutMs), // authority ops are quick; generate/embed pass a long one
    });
    if (!res.ok) throw new Error(`llm authority ${op}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, any>;
  }

  /** Hold-or-wait: returns only when we hold a live guest grant. Called before every LLM call. */
  async ensure(): Promise<void> {
    if (this.token && Date.now() - this.lastGrant < REFRESH_MS) return;   // fresh enough
    for (;;) {
      const r = await this.op('authority.enqueue', { holder: 'guest', ttlMs: GRANT_TTL_MS });
      const g = r.data ?? r;   // the bridge wraps the handler result in {ok, resource, op, data}
      if (g.granted) {
        this.token = String(g.token);
        this.lastGrant = Date.now();
        if (this.waitingOn) { this.log(`   ⛩ llm free again — guest grant restored (was yielding to ${this.waitingOn})`); this.waitingOn = null; }
        return;
      }
      if (g.denied) throw new Error(`guest not allowed by the llm resource: ${g.reason} (backend without the guest authority?)`);
      // busy: someone real owns the LLM — yield and wait our turn
      if (this.waitingOn !== g.holder) { this.log(`   ⛩ llm held by ${g.holder} — guest yields, waiting…`); this.waitingOn = String(g.holder); }
      this.token = null;
      await new Promise((r2) => setTimeout(r2, POLL_MS));
    }
  }

  /** Give the resource back (end of run). Safe to call when we hold nothing. */
  async release(): Promise<void> {
    if (!this.token) return;
    try { await this.op('authority.release', { token: this.token }); } catch { /* grant TTL will clean up */ }
    this.token = null;
    this.log('   ⛩ guest grant released — llm free');
  }

  /** Run a guarded op with SURVIVAL: the daemon restarting mid-call (a normal event on this box —
   *  deploys happen) drops the socket AND wipes the in-memory authority stack. So on a transient
   *  failure we void our token, back off, re-acquire the grant (ensure waits for the daemon to be
   *  back + our turn), and retry — bounded, then fail loud. Denied/permanent errors stay fatal. */
  private async guarded(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    const BACKOFF = [5_000, 15_000, 45_000, 90_000, 180_000];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensure();
        const r = await this.op(op, { authority: this.token, ...params }, timeoutMs);
        if (r.ok === false) {
          // stale/invalid token (e.g. stack wiped by a restart) → re-acquire and retry like a transient
          this.token = null;
          throw new Error(`gateway ${op} rejected: ${r.error}`);
        }
        return r;
      } catch (e) {
        if (attempt >= BACKOFF.length) throw e;   // bounded — then fail loud
        this.token = null;                        // whatever we held is suspect now
        this.log(`   ⛩ gateway ${op} failed (${e instanceof Error ? e.message.slice(0, 80) : e}) — retry ${attempt + 1}/${BACKOFF.length} in ${BACKOFF[attempt] / 1000}s`);
        await new Promise((r2) => setTimeout(r2, BACKOFF[attempt]));
      }
    }
  }

  /** Chat through the gateway with our guest token (never touches Ollama directly). Returns the text.
   *  opts.model targets an allowlisted UTILITY model (e.g. gemma-domains, the tuned query router) —
   *  it runs alongside the owner's model server-side, no swap. */
  async generate(prompt: string, opts: { temperature?: number; model?: string } = {}): Promise<string> {
    const r = await this.guarded('generate', { prompt, temperature: opts.temperature ?? 0, ...(opts.model ? { model: opts.model } : {}) }, 300_000);
    return String((r.data ?? r).text ?? '');
  }

  /** Embed through the gateway. nomic's asymmetric prefix is applied server-side by `task`. */
  async embed(inputs: string[], task: 'document' | 'query'): Promise<number[][]> {
    const r = await this.guarded('embed', { input: inputs, task }, 180_000);
    const embeddings = (r.data ?? r).embeddings as number[][] | undefined;
    if (!embeddings) throw new Error('gateway embed: no embeddings in response');
    return embeddings;
  }
}

// ── Gateway singleton ────────────────────────────────────────────────────────
// When the LLM_GATEWAY env var is set, every LLM call goes through the resource gateway as `guest` —
// the one door to the shared GPU. When it's UNSET (standalone: raw Ollama via --ollamaIp), this
// returns null and callers fall back to the direct path.
let shared: GuestGate | null = null;
let resolved = false;
export function labGate(): GuestGate | null {
  if (resolved) return shared;
  resolved = true;
  const base = process.env.LLM_GATEWAY;
  if (base) shared = new GuestGate(base.replace(/\/$/, ''), (s) => process.stderr.write(s + '\n'));
  return shared;
}