// PASS 1.7 — ALIAS AUDIT (the agentic verification loop). Runs AFTER the QA rounds, so it audits the
// COMPLETE map — including everything QA attached (v2 lesson: auditing before QA left QA's additions
// unchecked, and that is exactly where the foreign surnames snuck in).
//
// INTENTION: NO VERDICT WITHOUT A REASON. The model must ANSWER QUESTIONS about each alias — suggested
// full name, gender, occupation — before it may keep or discard it. A discard WITHOUT a reason is void.
// The stated gender is stamped into the alias's provenance for explicitness.
//
// INTENTION: DETERMINISM FIRST, LLM SECOND. A multi-word alias whose surname matches nothing the person
// carries is discarded BY CODE (tokensCompatible) before the model is even asked — "Олександр Наливайко"
// inside "Олександр Байдо" is not a judgement call.
//
// INTENTION: DISCARDED ≠ DELETED. A discarded alias is a REAL name of someone else; dropping it on the
// floor would leak it in the re-apply. Every discard is RE-HOMED: attached to the person it actually
// belongs to (by the model's suggested full name), or made a person of its own.
//
// INTENTION: GROUNDED, NOT IMAGINED. Every alias is audited WITH the real message it was seen in
// (provenance from the verbatim gate). The model judges evidence, not vibes.

import type { TgMessage, Person, DiscardedForm } from './types.ts';
import { prompts } from './prompts.ts';
import { askJson } from './ollama.ts';
import { tokensCompatible, nameRoot, personRoots, sameName } from './anonymize.ts';

const BATCH = 12;   // aliases per LLM call — big people get audited in several grounded batches

const flatten = (t: TgMessage['text']): string =>
  typeof t === 'string' ? t : Array.isArray(t) ? t.map((r) => (typeof r === 'string' ? r : r.text ?? '')).join('') : '';
const norm = (s: string) => s.toLowerCase().trim();

export type MessageIndex = Map<string, Map<number, string>>;   // doc → messageId → text

/** Build the doc→messageId→text lookup the audit uses to show each alias its real context. */
export function buildMessageIndex(chats: TgMessage[][], labels: string[]): MessageIndex {
  const idx: MessageIndex = new Map();
  chats.forEach((msgs, ci) => {
    const m = new Map<number, string>();
    for (const msg of msgs) { const t = flatten(msg.text); if (t.trim()) m.set(msg.id, `${msg.from ?? ''}: ${t}`.slice(0, 300)); }
    idx.set(labels[ci], m);
  });
  return idx;
}

export interface AuditResult { discarded: number; removed: Person[]; rehomed: number; deterministic: number }

/** Audit every person's alias list, then re-home everything that was discarded.
 *  Mutates people in place. Resumable per person via `resume.startPerson` / `onPerson`. */
export async function auditPass(
  ollamaIp: string, people: Person[], groups: string[], msgIndex: MessageIndex, log: (s: string) => void,
  resume?: { startPerson: number },
  onPerson?: (nextPerson: number, people: Person[]) => void,
): Promise<AuditResult> {
  let discardedTotal = 0, deterministic = 0;

  for (let pi = resume?.startPerson ?? 0; pi < people.length; pi++) {
    const p = people[pi];
    p.discarded ??= [];
    const verdicts = new Map<string, { verdict: string; reason: string; full_name?: string; gender?: string }>();

    // 1) DETERMINISTIC pre-pass — three rules, no model involved:
    //    a) multi-word alias with a foreign surname (tokensCompatible) → discard
    //    b) single-word alias whose FIRST-NAME ROOT clashes with every root the person carries
    //       ("Мішою"→Михайло inside an Олександр) → discard. Roots come from the diminutive
    //       dictionary — Саша≡Олександр passes, Міша≠Саша fails, decisively.
    //    c) AUTO-KEEP: an alias FULLY explained by the canonical (every word is a dictionary/declension
    //       match of a canonical word — "Олександра Байдо", "Саш", "Байдо" vs "Олександр Байдо") never
    //       reaches the model. Grammar is not a judgement call; the LLM only sees genuine ambiguity.
    // roots anchored on the CANONICAL only — computing them from all forms would let a bad alias
    // vouch for itself ("Мішою" contributing the very root it's checked against)
    const roots = personRoots({ ...p, forms: [] });
    const canonTokens = p.canonical.trim().split(/\s+/).map(norm).filter((t) => t.length >= 3);
    const explainedByCanonical = (form: string): boolean => {
      const words = form.trim().split(/\s+/).map(norm).filter((t) => t.length >= 3);
      return words.length > 0 && canonTokens.length > 0 && words.every((w) => canonTokens.some((c) => sameName(w, c)));
    };
    const askable: string[] = [];
    let autoKept = 0;
    for (const form of p.forms) {
      const words = form.trim().split(/\s+/);
      const soloRoot = words.length === 1 ? nameRoot(words[0]) : null;
      if (!tokensCompatible(p, form)) {
        verdicts.set(norm(form), { verdict: 'discard', reason: 'deterministic surname/token mismatch with this person', full_name: form });
        deterministic++;
      } else if (soloRoot !== null && roots.size > 0 && !roots.has(soloRoot)) {
        verdicts.set(norm(form), { verdict: 'discard', reason: 'deterministic first-name root clash (different given name)', full_name: form });
        deterministic++;
      } else if (explainedByCanonical(form)) {
        autoKept++;                                     // no verdict entry → default keep, LLM never asked
      } else askable.push(form);
    }
    if (autoKept) log(`   ✓ ${p.token}: ${autoKept} alias(es) auto-kept (declensions of canonical, no LLM)`);

    // 2) LLM audit for the rest, grounded in provenance context; one retry, loud failure
    for (let b = 0; b < askable.length; b += BATCH) {
      const batch = askable.slice(b, b + BATCH).map((form) => {
        const o = p.provenance?.[form];
        // inline context first (captured at witness time, survives merges); index lookup as fallback
        const context = o?.context
          ?? (o && o.messageId != null ? msgIndex.get(o.doc)?.get(o.messageId) : undefined)
          ?? (o ? `(sender field in ${o.doc})` : '(no recorded origin)');
        return { form, context };
      });
      let r: { aliases?: Array<Record<string, unknown>> } | null = null;
      for (let attempt = 1; attempt <= 2 && !r; attempt++) {
        try {
          r = await askJson(ollamaIp, prompts.aliasAudit({ CANONICAL: p.canonical, GROUP: p.group, ALIASES: JSON.stringify(batch) }));
        } catch (e) { if (attempt === 2) log(`   ⚠ audit batch FAILED twice for ${p.token} (${batch.length} aliases kept UNAUDITED): ${e}`); }
      }
      for (const a of r?.aliases ?? []) {
        const form = String(a.form ?? '').trim();
        const reason = String(a.reason ?? '').trim();
        const verdict = String(a.verdict ?? '').trim().toLowerCase();
        if (!form) continue;
        // THE CONTRACT: a discard without a reason is void — that is exactly the hallucination shape.
        if (verdict === 'discard' && !reason) { log(`   ⚠ ${p.token}: discard of "${form}" had NO reason — ignored`); continue; }
        verdicts.set(norm(form), { verdict, reason, full_name: a.full_name ? String(a.full_name) : undefined, gender: a.gender ? String(a.gender) : undefined });
      }
    }

    // 3) apply verdicts: keep (stamp gender) or move to discarded
    const kept: string[] = [];
    for (const form of p.forms) {
      const v = verdicts.get(norm(form));
      if (v?.verdict === 'discard') {
        p.discarded.push({ form, reason: v.reason, suggested_full_name: v.full_name, gender: v.gender } satisfies DiscardedForm);
        discardedTotal++;
      } else {
        kept.push(form);   // keep, or no verdict returned (fail-safe: keep coverage)
        if (p.provenance?.[form] && v?.gender) p.provenance[form].gender = v.gender;  // EXPLICIT gender per alias
      }
    }
    if (p.discarded.length) log(`   ✂ ${p.token} (${p.canonical}): discarded ${p.discarded.length} alias(es)`);
    p.forms = kept;

    // canonical hygiene: if the canonical itself was discarded, promote the best surviving form
    if (kept.length && !kept.some((f) => norm(f) === norm(p.canonical))) {
      const best = [...kept].sort((a, z) => (z.includes(' ') ? z.length + 100 : z.length) - (a.includes(' ') ? a.length + 100 : a.length))[0];
      log(`   ↷ ${p.token}: canonical "${p.canonical}" did not survive → now "${best}"`);
      p.canonical = best;
    }
    onPerson?.(pi + 1, people);
  }

  // 4) remove dissolved people (keep their records), then RE-HOME every discarded alias
  const removed: Person[] = [];
  for (let i = people.length - 1; i >= 0; i--) {
    if (people[i].forms.length === 0) {
      log(`   ✖ ${people[i].token} (${people[i].canonical}): every alias discarded → person removed`);
      removed.unshift(people[i]);
      people.splice(i, 1);
    }
  }

  const counters: Record<string, number> = Object.fromEntries(groups.map((g) => [g, 0]));
  for (const p of people) { const n = parseInt(p.token.replace(/^\D+/, ''), 10); if (!Number.isNaN(n)) counters[p.group] = Math.max(counters[p.group] ?? 0, n); }
  const rehomeGroup = groups[groups.length - 1];
  let rehomed = 0;
  const allDiscards: Array<{ owner: Person; d: DiscardedForm }> = [
    ...people.flatMap((p) => (p.discarded ?? []).map((d) => ({ owner: p, d }))),
    ...removed.flatMap((p) => (p.discarded ?? []).map((d) => ({ owner: p, d }))),
  ];
  for (const { owner, d } of allDiscards) {
    if (d.rehomed_to) continue;
    const key = d.suggested_full_name?.trim() || d.form;
    // find the real owner: suggested name or the form itself must match AND pass the surname guard
    let home = people.find((x) => x !== owner
      && (norm(x.canonical) === norm(key) || x.forms.some((f) => norm(f) === norm(key) || norm(f) === norm(d.form)))
      && tokensCompatible(x, d.form));
    if (!home) {
      home = { token: `${rehomeGroup}${++counters[rehomeGroup]}`, group: rehomeGroup, canonical: key, forms: [], provenance: {} };
      people.push(home);
    }
    if (!home.forms.includes(d.form)) home.forms.push(d.form);
    home.provenance ??= {};
    home.provenance[d.form] ??= { ...(owner.provenance?.[d.form] ?? { doc: '(rehomed)', messageId: null }), gender: d.gender };
    delete owner.provenance?.[d.form];
    d.rehomed_to = home.token;
    rehomed++;
  }
  if (rehomed) log(`   ⌂ re-homed ${rehomed} discarded alias(es) to their real owners (nothing leaks on re-apply)`);

  return { discarded: discardedTotal, removed, rehomed, deterministic };
}