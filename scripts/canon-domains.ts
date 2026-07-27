#!/usr/bin/env node
// HW3 groundwork — CANONICAL DOMAINS via the shrinking synonym loop (the user's spec).
//
// foreach over the domain pool (highest bulk-count first):
//   anchor = next unused domain; present its 10 NEAREST unused domains (cosine — vector proposes);
//   gemma picks which are synonyms of the anchor (LLM disposes; minimal instruction, one simple task);
//   picked synonyms merge into the anchor and are EXCLUDED from the pool → the loop shrinks
//   dynamically until nothing is left to look at.
//
// Input: data/domains/domains-merged.json (118, untouched). Output: domains-canon.{md,json}.
// Every decision is appended to canon-log.jsonl → a crash resumes by replaying the log.
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/canon-domains.ts

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/domains');
// --pass N reads the previous pass's output and writes suffixed files (pass 1 = original behavior)
// --variant vN picks the prompt (prompt-engineering experiments); --tag isolates an experiment's files
const argv = process.argv.slice(2);
const flagv = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PASS = parseInt(flagv('pass', '1'), 10) || 1;
const VARIANT = flagv('variant', 'v1');
const TAG = flagv('tag', '');
const SUF = `${TAG ? `-${TAG}` : ''}${PASS === 1 ? '' : `-pass${PASS}`}`;
const IN = flagv('in', PASS === 1 ? join(DIR, 'domains-merged.json') : join(DIR, `domains-merged${SUF}-input.json`));
const LOG = join(DIR, `canon-log${SUF}.jsonl`);
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — one door only'); process.exit(1); }

// ── THE PROMPT VARIANTS (the only thing that differs between experiments) ─────────────────────────
// v1 is the PRODUCTION prompt, extracted to prompts/12_domain_synonyms.md (user's spec: "keep
// instruction minimal so full focus on simple task"). v2-v6 are the prompt-engineering sweep variants —
// kept inline because they are experiments, not production surface.
import { prompts as promptFiles } from '../src/prompts.ts';
const PROMPTS: Record<string, (anchor: string, cands: string[]) => string> = {
  v1: (anchor, cands) => promptFiles.domainSynonyms({ ANCHOR: anchor, CANDIDATES: cands.map((c, i) => `${i + 1}. ${c}`).join('\n') }),

  // v2 — tagging-equivalence criterion + one positive and one negative example
  v2: (anchor, cands) => `We are merging duplicate labels in a document-tagging taxonomy.
Two labels are THE SAME if any document tagged with one should always be tagged with the other too.
Example of same: "billing and payments" = "payment processing". Example of NOT same: "patient scheduling" ≠ "staff scheduling" (different subjects).

Label: "${anchor}"
Candidates:
${cands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Which candidates are THE SAME label as "${anchor}"? JSON array of numbers, [] if none.`,

  // v3 — per-candidate verdict WITH a reason (the alias-audit lesson: a reason kills hallucination)
  v3: (anchor, cands) => `Topic label: "${anchor}"

For EACH candidate below, decide: is it just another name for the same topic as "${anchor}"?
${cands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Answer with STRICT JSON, one entry per candidate, same order:
{"verdicts":[{"n":1,"same":true|false,"why":"few words"}...]}
A "same":true without a real reason does not count.`,

  // v4 — lumper with a subdomain guard: merge synonyms generously, never merge parent/child topics
  v4: (anchor, cands) => `We are canonicalising topic labels for a clinic knowledge base.
MERGE two labels only if they are interchangeable names for the same everyday activity.
DO NOT merge a subtopic into its parent: "laboratory orders" is PART of "laboratory coordination", not a synonym — keep such pairs separate. Wording variants ("employee management"/"staff management") ARE synonyms — merge those.

Label: "${anchor}"
Candidates:
${cands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

JSON array of the numbers that are true synonyms of "${anchor}". [] if none.`,

  // v6 — few-shot rich: three worked examples covering the three hard cases (wording variant,
  // different subject, subtopic-vs-parent), otherwise minimal
  v6: (anchor, cands) => `Merging duplicate topic labels. Examples of correct decisions:
- "employee management" vs "staff management" → SAME (wording variant)
- "patient scheduling" vs "staff scheduling" → NOT same (different subject)
- "laboratory orders" vs "laboratory coordination" → NOT same (subtopic vs parent)

Label: "${anchor}"
Candidates:
${cands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

JSON array of the numbers that are the SAME as "${anchor}". [] if none.`,

  // v5 — v2's criterion + v3's per-candidate reasons + v4's subdomain guard, all at once
  v5: (anchor, cands) => `We are merging duplicate labels in a clinic knowledge-base taxonomy.
SAME = interchangeable: any document tagged with one should always be tagged with the other.
NOT same = different subject ("patient scheduling" vs "staff scheduling") OR a subtopic vs its parent ("laboratory orders" is part of "laboratory coordination", not a synonym).

Label: "${anchor}"
For EACH candidate, decide with a short reason:
${cands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

STRICT JSON, one entry per candidate, same order:
{"verdicts":[{"n":1,"same":true|false,"why":"few words"}...]}
"same":true with no real reason is void.`,
};
const buildPrompt = PROMPTS[VARIANT];
if (!buildPrompt) { console.error(`unknown --variant ${VARIANT} (have: ${Object.keys(PROMPTS).join(', ')})`); process.exit(1); }
/** Parse either the simple array (v1/v2/v4) or the verdicts object (v3/v5) into candidate indices. */
function parsePicks(raw: string, nCands: number): number[] {
  const o = raw.indexOf('{'), oc = raw.lastIndexOf('}');
  if (o >= 0 && oc > o) {
    try {
      const j = JSON.parse(raw.slice(o, oc + 1)) as { verdicts?: Array<{ n?: number; same?: boolean; why?: string }> };
      if (Array.isArray(j.verdicts))
        return j.verdicts.filter((v) => v.same === true && String(v.why ?? '').trim()).map((v) => Number(v.n)).filter((n) => n >= 1 && n <= nCands);
    } catch { /* fall through */ }
  }
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return (JSON.parse(raw.slice(a, b + 1)) as unknown[]).map(Number).filter((n) => n >= 1 && n <= nCands); } catch { /* none */ } }
  return [];
}

const items = (JSON.parse(readFileSync(IN, 'utf8')) as Array<{ domain: string; count: number }>)
  .sort((a, b) => b.count - a.count);
const count = new Map(items.map((d) => [d.domain, d.count]));

console.log(`embedding ${items.length} domains (gateway, guest)…`);
const vecs = await gate.embed(items.map((d) => d.domain), 'document');
const vec = new Map(items.map((d, i) => [d.domain, vecs[i]]));
const cos = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9); };

// pool + canon state; replay a previous crash's log so we never redo a decision
const pool = new Set(items.map((d) => d.domain));
const canon: Array<{ domain: string; count: number; merged: string[] }> = [];
if (existsSync(LOG)) {
  for (const l of readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)) {
    const e = JSON.parse(l) as { anchor: string; synonyms: string[] };
    if (!pool.has(e.anchor)) continue;
    pool.delete(e.anchor);
    const merged = e.synonyms.filter((s) => pool.has(s));
    merged.forEach((s) => pool.delete(s));
    canon.push({ domain: e.anchor, count: (count.get(e.anchor) ?? 0) + merged.reduce((n, s) => n + (count.get(s) ?? 0), 0), merged });
  }
  if (canon.length) console.log(`resumed: ${canon.length} anchors already decided, ${pool.size} left in pool`);
}

// ═══ THE SHRINKING SYNONYM LOOP — OPTIMIZATION AUTHORED BY THE USER ═══════════════════════════════
// His spec, implemented verbatim: for each domain (highest-count first) present its 10 nearest
// unused neighbours (vector proposes); the model picks which are just other names for the SAME topic
// (LLM disposes); picked synonyms are EXCLUDED from the pool — "so it is dynamic and shrinks till
// nothing to look at". Iterated to near-fixpoint over 3 passes: 118 → 56 → 37 → 30 canonical domains.
while (pool.size > 0) {
  // anchor = highest-count domain still in the pool
  const anchor = items.find((d) => pool.has(d.domain))!.domain;
  pool.delete(anchor);
  // vector proposes: its 10 nearest still-unused domains
  const cands = [...pool]
    .map((d) => ({ d, s: cos(vec.get(anchor)!, vec.get(d)!) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map((x) => x.d);
  let synonyms: string[] = [];
  if (cands.length) {
    const raw = await gate.generate(buildPrompt(anchor, cands));
    synonyms = parsePicks(raw, cands.length).map((n) => cands[n - 1]).filter(Boolean);
  }
  synonyms.forEach((s) => pool.delete(s));   // consumed — the loop shrinks
  appendFileSync(LOG, JSON.stringify({ anchor, synonyms }) + '\n', 'utf8');
  canon.push({ domain: anchor, count: (count.get(anchor) ?? 0) + synonyms.reduce((n, s) => n + (count.get(s) ?? 0), 0), merged: synonyms });
  console.log(`  ${anchor}${synonyms.length ? ` ← ${synonyms.join(' · ')}` : ''}   (pool: ${pool.size})`);
}
await gate.release();

canon.sort((a, b) => b.count - a.count);
let md = `# Canonical domains — shrinking synonym loop, pass ${PASS} (vector proposes 10, gemma disposes)\n\n${items.length} in → **${canon.length} canonical domains**. Sources untouched.\n\n| # | domain | bulk-hits (merged) | absorbed synonyms |\n|---|---|---|---|\n`;
canon.forEach((c, i) => { md += `| ${i + 1} | ${c.domain} | ${c.count} | ${c.merged.join(' · ') || '—'} |\n`; });
writeFileSync(join(DIR, `domains-canon${SUF}.md`), md, 'utf8');
writeFileSync(join(DIR, `domains-canon${SUF}.json`), JSON.stringify(canon, null, 2), 'utf8');
console.log(`\n✅ pass ${PASS}: ${items.length} → ${canon.length} canonical domains → data/domains/domains-canon${SUF}.{md,json}`);