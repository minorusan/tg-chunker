// PASS 1 — ANONYMISE.
// Turn every real person into a stable token built from a caller-defined GROUP (--groupingTags).
// With the default groups `employee,patient` you get employee1, patient1, patient2… but the tool is
// generic: pass `goodies,baddies` (or any set) and you get goodie1, baddie2… The FIRST group is the
// chat's own participants (the senders); everyone else is classified by the model. Placeholders like
// "Vasya Pupkin", brands and cities are left alone.
//
// Design choice worth noting: the MODEL only DECIDES (who is a person, which spellings, which group).
// The CODE APPLIES the swap deterministically and never lets the model rewrite messages — so the swap
// is exact, reproducible, and can't drift.

import type { TgMessage, Person } from './types.ts';
import { prompts } from './prompts.ts';
import { askJson } from './ollama.ts';

const norm = (s: string) => s.toLowerCase().trim();
const flatten = (t: TgMessage['text']): string =>
  typeof t === 'string' ? t : Array.isArray(t) ? t.map((r) => (typeof r === 'string' ? r : r.text ?? '')).join('') : '';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the JSON schema handed to Ollama so gemma MUST return {people:[{canonical,group,forms}]}
 *  with `group` constrained to the caller's tags — no invented keys, no invented groups. */
const discoverSchema = (groups: string[]) => ({
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          group: { type: 'string', enum: groups },
          forms: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonical', 'group', 'forms'],
      },
    },
  },
  required: ['people'],
});

/** Discover people across ALL chats into one shared map (so a person is the same tokenN everywhere).
 *  Chat participants (senders) are seeded into the FIRST group; the model classifies the rest. */
export async function discoverPeople(ollamaIp: string, chats: TgMessage[][], groups: string[], windowN: number, log: (s: string) => void): Promise<Person[]> {
  const roster = [...new Set(chats.flat().flatMap((m) => [m.from, m.actor].filter((x): x is string => !!x && x.trim() !== '')))];
  const counters: Record<string, number> = Object.fromEntries(groups.map((g) => [g, 0]));
  const people: Person[] = roster.map((name) => ({ token: `${groups[0]}${++counters[groups[0]]}`, group: groups[0], canonical: name, forms: [name] }));
  const schema = discoverSchema(groups);

  const peopleView = () => people.length ? people.map((p) => `${p.token} = ${p.canonical} (${p.forms.join(', ')})`).join('\n') : '(none yet)';

  for (const messages of chats) {
    for (let start = 0; start < messages.length; start += windowN) {
      const window = messages.slice(start, start + windowN);
      const msgs = window.map((m) => ({ id: m.id, from: m.from ?? null, text: flatten(m.text) }));
      const prompt = prompts.anonymizeDiscover({
        GROUPS: groups.join(', '), GROUP0: groups[0], PEOPLE: peopleView(), MESSAGES: JSON.stringify(msgs),
      });
      let found: { people?: Array<Record<string, unknown>> };
      try { found = await askJson(ollamaIp, prompt, schema); } catch { continue; }

      for (const raw of found.people ?? []) {
        const canonical = String(raw.canonical ?? raw.name ?? raw.full_name ?? '').trim();
        if (!canonical) continue;
        // Tolerant: gemma sometimes returns the spellings under a different key (full_name/names/…).
        // Collect from every plausible key; if still empty, fall back to the canonical so a detected
        // person is NEVER dropped (a dropped person = a leaked real name).
        let forms: string[] = [];
        for (const k of ['forms', 'names', 'aliases', 'spellings', 'full_name', 'name']) {
          const v = raw[k];
          if (Array.isArray(v)) forms.push(...v.map(String));
          else if (typeof v === 'string' && k !== 'name' && k !== 'full_name') forms.push(v);
        }
        forms = [...new Set(forms.map((s) => s.trim()).filter(Boolean))];
        if (forms.length === 0) forms = [canonical];
        const group = groups.includes(String(raw.group)) ? String(raw.group) : groups[groups.length - 1];
        const p = { canonical, group, forms };
        const formsN = p.forms.map(norm);
        // same person only if canonical matches or a spelling overlaps one we already know
        let e = people.find((x) => norm(x.canonical) === norm(p.canonical) || x.forms.some((f) => formsN.includes(norm(f))));
        if (!e) {
          e = { token: `${group}${++counters[group]}`, group, canonical: p.canonical, forms: [] };
          people.push(e);
          log(`   + ${group}: ${p.canonical} → ${e.token}`);
        }
        e.forms = [...new Set([...e.forms, ...p.forms])];
      }
    }
  }
  return people;
}

// ── PASS 1.5 — ENTITY-MERGE VERIFICATION (the 3rd LLM loop) ─────────────────────────────────────────
// INTENTION: FUZZY STRING PROPOSES, LLM DISPOSES. We tried vector clustering here; the local embedder
// couldn't separate names on domain-homogeneous chat (every person ≈ one point). The duplicates that are
// ACTUALLY in this data are ORTHOGRAPHIC — spelling variants ("Пискуновська"/"Піскуновська", one letter)
// and declensions ("Оксана"/"Оксані"). Those are exactly what edit-distance catches. So we nominate any
// pair whose name-tokens are near-identical, then the strict LLM verify makes the final call (so a wife
// is never merged into her husband — a shared surname alone never merges).
const MERGE_SCHEMA = { type: 'object', properties: { same: { type: 'boolean' }, reason: { type: 'string' } }, required: ['same', 'reason'] };
const MAX_MERGE_CHECKS = 500;  // hard cap on LLM calls; if exceeded we log it (never a silent truncation)

/** Levenshtein edit distance between two strings (how many single-char edits to turn one into the other). */
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const tokensOf = (p: Person) => [...new Set([...p.forms, p.canonical].flatMap((f) => f.trim().split(/\s+/)).map(norm).filter((t) => t.length >= 4))];
/** Two people are worth checking if any of their name-tokens are equal or a 1–2 char near-miss
 *  (spelling variant / declension of the same surname or first name). */
function fuzzyCandidate(a: Person, b: Person): boolean {
  for (const x of tokensOf(a)) for (const y of tokensOf(b)) {
    if (x === y) return true;
    const min = Math.min(x.length, y.length);
    if (min >= 4 && lev(x, y) <= 2 && lev(x, y) <= min * 0.34) return true;
  }
  return false;
}

export async function mergePass(ollamaIp: string, people: Person[], log: (s: string) => void): Promise<Person[]> {
  let checks = 0, merges = 0, capped = false;
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i], b = people[j];
      if (!fuzzyCandidate(a, b)) continue;                 // cheap string pre-filter → few LLM calls
      if (checks >= MAX_MERGE_CHECKS) { capped = true; continue; }
      checks++;
      let r: { same?: boolean; reason?: string };
      try {
        r = await askJson(ollamaIp, prompts.mergeVerify({
          A: JSON.stringify({ canonical: a.canonical, forms: a.forms }),
          B: JSON.stringify({ canonical: b.canonical, forms: b.forms }),
        }), MERGE_SCHEMA);
      } catch { continue; }
      if (r.same === true) {
        a.forms = [...new Set([...a.forms, ...b.forms])];
        log(`   ⇄ merged ${b.canonical} → ${a.token}  (${r.reason ?? 'same person'})`);
        people.splice(j, 1); j--; merges++;
      }
    }
  }
  const counters: Record<string, number> = {};
  for (const p of people) { counters[p.group] = (counters[p.group] ?? 0) + 1; p.token = `${p.group}${counters[p.group]}`; }
  log(`   fuzzy-merge: ${checks} pair(s) verified, ${merges} merged → ${people.length} people${capped ? ` (⚠ capped at ${MAX_MERGE_CHECKS})` : ''}`);
  return people;
}

// ── PASS 1.9 — QA LEAK SCAN ─────────────────────────────────────────────────────────────────────────
// INTENTION: VERIFY, DON'T ASSUME. The mapped-name check is BLIND to a person we never discovered. So we
// re-read the ALREADY-TOKENISED text and ask the model for any real name that is still NOT a token —
// those are misses. They get added to the map (and the caller re-applies + re-scans until clean). Without
// this a missed person's real name ships in the clear and nothing notices.
const looksLikeToken = (s: string) => /^[a-z]+\d+$/i.test(s.trim());

export async function qaPass(ollamaIp: string, chats: TgMessage[][], people: Person[], groups: string[], windowN: number, log: (s: string) => void): Promise<number> {
  const leakGroup = groups[groups.length - 1]; // a missed person defaults to the last group (e.g. patient)
  const counters: Record<string, number> = {};
  for (const p of people) { const n = parseInt(p.token.replace(/^\D+/, ''), 10); counters[p.group] = Math.max(counters[p.group] ?? 0, Number.isNaN(n) ? 0 : n); }
  let added = 0;
  for (const messages of chats) {
    for (let start = 0; start < messages.length; start += windowN) {
      const msgs = messages.slice(start, start + windowN).map((m) => ({ id: m.id, text: flatten(m.text) })).filter((m) => m.text.trim());
      if (msgs.length === 0) continue;
      let r: { leaks?: Array<{ canonical?: string; forms?: string[] }> };
      try { r = await askJson(ollamaIp, prompts.qaLeakScan({ MESSAGES: JSON.stringify(msgs) })); } catch { continue; }
      for (const L of r.leaks ?? []) {
        const canonical = String(L.canonical ?? '').trim();
        if (!canonical || looksLikeToken(canonical)) continue;              // ignore tokens reported by mistake
        const forms = [...new Set([...(Array.isArray(L.forms) ? L.forms.map(String) : []), canonical].map((s) => s.trim()).filter((s) => s && !looksLikeToken(s)))];
        const formsN = forms.map(norm);
        let e = people.find((x) => norm(x.canonical) === norm(canonical) || x.forms.some((f) => formsN.includes(norm(f))));
        if (!e) {
          e = { token: `${leakGroup}${++counters[leakGroup]}`, group: leakGroup, canonical, forms: [] };
          people.push(e); added++;
          log(`   ✗ QA leak caught: ${canonical} → ${e.token}`);
        }
        e.forms = [...new Set([...e.forms, ...forms])];
      }
    }
  }
  return added;
}

/** real→token pairs + name-part derivation (so a lone surname is caught), longest-first.
 *  INTENTION: AMBIGUITY-SAFE — a bare name-part is only derived if it maps to EXACTLY ONE person. If a
 *  surname/first-name is shared by two people (e.g. two "Головко"), we do NOT guess which token a lone
 *  mention means; the full-name mentions still resolve. Prevents cross-person mis-assignment. */
function buildPairs(people: Person[]): Array<{ real: string; token: string }> {
  const pairs = people.flatMap((p) => p.forms.map((f) => ({ real: f, token: p.token })));
  const seen = new Set(pairs.map((p) => norm(p.real)));
  // count which token(s) each candidate part belongs to
  const partTokens = new Map<string, Set<string>>();
  for (const p of people) for (const f of p.forms) for (const part of f.trim().split(/\s+/))
    if (part.length >= 3) (partTokens.get(norm(part)) ?? partTokens.set(norm(part), new Set()).get(norm(part))!).add(p.token);
  for (const [part, tokens] of partTokens)
    if (tokens.size === 1 && !seen.has(part)) { pairs.push({ real: part, token: [...tokens][0] }); seen.add(part); }
  return pairs.sort((a, b) => b.real.length - a.real.length);
}

/** Replace names with tokens IN PLACE, whole-word (Unicode \p{L}) so a name is never swapped inside
 *  another word — e.g. "Якщо" must not become "employee8кщо". */
export function applyTokens(messages: TgMessage[], people: Person[]): number {
  const pairs = buildPairs(people);
  const rx = pairs.map((p) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p.real)}(?![\\p{L}\\p{N}])`, 'gu'), token: p.token }));
  const swap = (s: string) => rx.reduce((t, { re, token }) => t.replace(re, token), s);
  let replaced = 0;
  for (const m of messages) {
    for (const field of ['from', 'actor', 'forwarded_from'] as const)
      if (typeof m[field] === 'string') m[field] = swap(m[field] as string) as never;
    const nt = swap(flatten(m.text));
    if (nt !== flatten(m.text)) { m.text = nt; delete m.text_entities; }
    replaced += (JSON.stringify([m.from, m.actor, flatten(m.text)]).match(/\b[a-z]+\d+\b/g) ?? []).length;
  }
  return replaced;
}
