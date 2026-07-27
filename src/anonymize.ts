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

import type { TgMessage, Person, FormOrigin } from './types.ts';
import { prompts } from './prompts.ts';
import { askJson } from './ollama.ts';

const norm = (s: string) => s.toLowerCase().trim();

// INTENTION: FIRST NAMES ARE A DICTIONARY, NOT AN EDIT DISTANCE. "Саша" ≡ "Олександр" at distance ∞;
// "Міша" ≠ "Саша" at distance 2. Slavic diminutives are a closed, well-known set — THAT part is
// deterministic. Each row: one name-root with its UA/RU full forms + diminutives (+ declined short
// forms that stemming can't reach). Unknown names fall through to the generic lev rule / LLM audit.
const NAME_ROOTS: string[][] = [
  // male+female Alexander share one root ON PURPOSE: "Олександра" is BOTH the female name and the
  // genitive of the male name — that ambiguity is the LLM audit's job (gender question), not stemming's.
  ['олександр', 'александр', 'олександра', 'александра', 'олекса', 'саша', 'сашко', 'сашечка', 'сашенька', 'шура', 'санёк', 'санек', 'саня', 'сані', 'саню', 'санею', 'саші', 'сашу', 'сашею', 'сашою', 'сашо'],
  ['михайло', 'михаил', 'міша', 'миша', 'мишко', 'мішко', 'міші', 'мішу', 'мішою', 'мишею'],
  ['микола', 'николай', 'коля', 'колі', 'колю', 'колею', 'миколка'],
  ['євген', 'евгений', 'женя', 'жені', 'женю', 'женею', 'жека'],
  ['максим', 'макс', 'максу', 'макса', 'максим', 'максиму'],
  ['володимир', 'владимир', 'вова', 'володя', 'вови', 'вові', 'вовою', 'вован'],
  ['дмитро', 'дмитрий', 'діма', 'дима', 'дімі', 'діму', 'дімою', 'дімон'],
  ['наталія', 'наталья', 'наташа', 'ната', 'наталі', 'наташі', 'наташу', 'наташею'],
  ['ольга', 'оля', 'олі', 'олю', 'олею', 'олечка', 'ольгою'],
  ['олена', 'елена', 'лена', 'лєна', 'лени', 'лені', 'леною', 'оленка'],
  ['катерина', 'екатерина', 'катя', 'каті', 'катю', 'катею', 'катруся'],
  ['тетяна', 'татьяна', 'таня', 'тані', 'таню', 'танею'],
  ['ірина', 'ирина', 'іра', 'ира', 'ірі', 'іру', 'ірою', 'іринка'],
  ['світлана', 'светлана', 'свєта', 'света', 'свєті', 'свєту', 'свєтою', 'світлані'],
  ['анна', 'ганна', 'аня', 'ані', 'аню', 'анею', 'анька'],
  ['марія', 'мария', 'маша', 'маші', 'машу', 'машею', 'марійка', 'маруся'],
  ['юлія', 'юлия', 'юля', 'юлі', 'юлю', 'юлею'],
  ['андрій', 'андрей', 'андрію', 'андрія', 'андрієм', 'дрон'],
  ['сергій', 'сергей', 'серьожа', 'сірьожа', 'сірожа', 'серж', 'сергію', 'сергія'],
  ['віктор', 'виктор', 'вітя', 'витя', 'віті', 'вітю', 'вітею'],
  ['ігор', 'игорь', 'ігорю', 'ігоря', 'ігорем', 'гоша'],
  ['павло', 'павел', 'паша', 'паші', 'пашу', 'пашею'],
  ['петро', 'петр', 'петя', 'петі', 'петю', 'петею'],
  ['юрій', 'юрий', 'юра', 'юри', 'юрі', 'юрою', 'юрчик'],
  ['денис', 'дєн', 'ден', 'денису', 'дениса'],
  ['артем', 'тьома', 'тёма', 'артему', 'артема'],
  ['кирило', 'кирилл', 'кирилу', 'кирила'],
  ['костянтин', 'константин', 'костя', 'кості', 'костю', 'костею'],
  ['станіслав', 'станислав', 'стас', 'стасу', 'стаса'],
  ["в'ячеслав", 'вячеслав', 'слава', 'славік', 'славик', 'слави', 'славі'],
  ['ярослав', 'ярославу', 'ярослава', 'ярик'],
  ['людмила', 'люда', 'люди', 'люді', 'людою', 'мила'],
  ['оксана', 'оксані', 'оксану', 'оксаною', 'ксюша', 'ксюші'],
  ['ілля', 'илья', 'іллі', 'іллю', 'іллею'],
  ['роман', 'рома', 'роми', 'ромі', 'ромою'],
  ['віталій', 'виталий', 'віталик', 'виталик', 'віталію'],
  ['валентин', 'валентина', 'валя', 'валі', 'валю', 'валею'],
  ['надія', 'надежда', 'надя', 'наді', 'надю', 'надею'],
  ['любов', 'любовь', 'люба', 'люби', 'любі', 'любою'],
  ['галина', 'галя', 'галі', 'галю', 'галею'],
  ['софія', 'софия', 'соня', 'соні', 'соню', 'сонею'],
  ['анастасія', 'анастасия', 'настя', 'насті', 'настю', 'настею'],
  ['олексій', 'алексей', 'льоша', 'лёша', 'леша', 'льоші', 'льошу', 'олексію', 'лёха', 'льоха'],
  ['вадим', 'вадиму', 'вадима'],
  ['богдан', 'богдану', 'богдана', 'боді', 'бодя'],
  ['тарас', 'тарасу', 'тараса'],
  ['олег', 'олегу', 'олега', 'олегом', 'олежка'],
  ['гліб', 'глеб', 'глібу', 'гліба', 'глебу'],
];
const ROOT_BY_VARIANT = new Map<string, number>();
NAME_ROOTS.forEach((row, i) => row.forEach((v) => { if (!ROOT_BY_VARIANT.has(v)) ROOT_BY_VARIANT.set(v, i); }));

/** Resolve a name token to its dictionary root index, declension-tolerant, or null if unknown.
 *  Exact variant match first; then stem match (variant minus final vowel, ≥4 chars) for declined forms. */
export function nameRoot(tokenRaw: string): number | null {
  const t = norm(tokenRaw);
  if (ROOT_BY_VARIANT.has(t)) return ROOT_BY_VARIANT.get(t)!;
  for (const [v, i] of ROOT_BY_VARIANT) {
    if (v.length < 4) continue;
    const stem = v.slice(0, -1);
    if (t.startsWith(stem) && t.length <= v.length + 3) return i;
  }
  return null;
}

/** Are two name tokens "the same name"? Dictionary roots are DECISIVE in both directions; only
 *  unknown names fall back to declension-tolerant edit distance. */
export function sameName(a: string, b: string): boolean {
  const ra = nameRoot(a), rb = nameRoot(b);
  if (ra !== null && rb !== null) return ra === rb;         // Саша≡Олександр; Міша≢Саша — decisive
  if (ra !== null || rb !== null) {
    // one is a known first name, the other isn't (likely a surname) → different words
    const d = lev(norm(a), norm(b));
    return d <= 2 && d <= Math.min(a.length, b.length) * 0.34;
  }
  const d = lev(norm(a), norm(b));
  return d <= 2 && d <= Math.min(a.length, b.length) * 0.34;
}

/** INTENTION: DETERMINISTIC SURNAME GUARD — no LLM needed for "Олександр Наливайко" vs "Олександр
 *  Байдо". A multi-word candidate may only attach to an existing person if EVERY word of it matches
 *  (dictionary-aware: diminutive≡full name; unknowns via declension-tolerant edit distance) some word
 *  the person already carries. One shared first name is NOT enough — the unmatched surname vetoes the
 *  attach. Splitting is the safe error: the fuzzy+LLM merge pass can rejoin two halves of a real
 *  person; nothing can un-blob a false merge. */
export function tokensCompatible(person: Person, candidate: string): boolean {
  const cand = candidate.trim().split(/\s+/).map(norm).filter((t) => t.length >= 3);
  if (cand.length <= 1) return true;                       // single-word forms: overlap rule is enough
  const own = [...new Set([person.canonical, ...person.forms].flatMap((f) => f.trim().split(/\s+/)).map(norm).filter((t) => t.length >= 3))];
  return cand.every((c) => own.some((o) => sameName(c, o)));
}

/** All dictionary roots this person's name tokens resolve to (for single-word root-clash checks). */
export function personRoots(person: Person): Set<number> {
  const out = new Set<number>();
  for (const f of [person.canonical, ...person.forms]) for (const t of f.trim().split(/\s+/)) {
    const r = nameRoot(t); if (r !== null) out.add(r);
  }
  return out;
}
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
 *  Chat participants (senders) are seeded into the FIRST group; the model classifies the rest.
 *  RESUMABLE: pass `resume` to continue from a saved (unit, window, people); `onWindow` is called after
 *  each window so the caller can persist a checkpoint. Reprocessing a window is safe — discovery just
 *  re-finds the same people and dedups them, so a resumed in-flight window can't double-count. */
export async function discoverPeople(
  ollamaIp: string, chats: TgMessage[][], labels: string[], groups: string[], windowN: number, log: (s: string) => void,
  resume?: { startUnit: number; startWin: number; people: Person[] },
  onWindow?: (unit: number, nextStart: number, people: Person[]) => void,
): Promise<Person[]> {
  const counters: Record<string, number> = Object.fromEntries(groups.map((g) => [g, 0]));
  let people: Person[];
  if (resume) {   // continue an interrupted run: reuse the map, rebuild counters from its highest tokens
    people = resume.people;
    for (const p of people) { const n = parseInt(p.token.replace(/^\D+/, ''), 10); if (!Number.isNaN(n)) counters[p.group] = Math.max(counters[p.group] ?? 0, n); }
  } else {        // fresh run: seed chat participants into the first group (provenance: first message sent)
    const seen = new Map<string, FormOrigin>();
    chats.forEach((msgs, ci) => { for (const m of msgs) for (const name of [m.from, m.actor])
      if (name && name.trim() && !seen.has(name)) seen.set(name, { doc: labels[ci], messageId: m.id, context: `${name}: ${flatten(m.text)}`.slice(0, 220) }); });
    people = [...seen.entries()].map(([name, origin]) => ({
      token: `${groups[0]}${++counters[groups[0]]}`, group: groups[0], canonical: name, forms: [name],
      provenance: { [name]: origin },
    }));
  }
  const schema = discoverSchema(groups);
  const startUnit = resume?.startUnit ?? 0;
  const startWin = resume?.startWin ?? 0;

  const peopleView = () => people.length ? people.map((p) => `${p.token} = ${p.canonical} (${p.forms.join(', ')})`).join('\n') : '(none yet)';
  let dropped = 0;   // forms rejected by the verbatim gate

  for (let ci = startUnit; ci < chats.length; ci++) {
    const messages = chats[ci];
    for (let start = (ci === startUnit ? startWin : 0); start < messages.length; start += windowN) {
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

        // INTENTION: VERBATIM GATE + PROVENANCE. A reported spelling only counts if it literally occurs
        // in THIS window's text (or a sender field) — anything else is a hallucinated variant (latinised,
        // corrupted, invented) and is dropped on the spot. Every surviving form records WHERE it was seen
        // (doc + messageId), so a wrong alias is later fixable and the audit pass can show real context.
        const windowLow = msgs.map((m) => ({ id: m.id, from: m.from, raw: m.text, text: `${m.from ?? ''}\n${m.text}`.toLowerCase() }));
        const witnessed: Array<{ form: string; origin: FormOrigin }> = [];
        for (const f of forms) {
          const hit = windowLow.find((m) => m.text.includes(f.toLowerCase()));
          if (hit) witnessed.push({ form: f, origin: { doc: labels[ci], messageId: hit.id, context: `${hit.from ?? ''}: ${hit.raw}`.slice(0, 220) } });
          else dropped++;
        }
        if (witnessed.length === 0) continue;      // nothing verifiable → the whole report is noise

        const group = groups.includes(String(raw.group)) ? String(raw.group) : groups[groups.length - 1];
        const formsN = witnessed.map((w) => norm(w.form));
        // same person only if canonical matches or a spelling overlaps one we already know —
        // AND the deterministic surname guard agrees (a shared first name never overrides a foreign surname)
        let e = people.find((x) => (norm(x.canonical) === norm(canonical) || x.forms.some((f) => formsN.includes(norm(f))))
          && tokensCompatible(x, canonical));
        if (!e) {
          e = { token: `${group}${++counters[group]}`, group, canonical, forms: [], provenance: {} };
          people.push(e);
          log(`   + ${group}: ${canonical} → ${e.token}`);
        }
        e.provenance ??= {};
        for (const w of witnessed) {
          if (!tokensCompatible(e, w.form)) { dropped++; continue; }   // foreign surname riding along → veto
          if (!e.forms.includes(w.form)) e.forms.push(w.form);
          e.provenance[w.form] ??= w.origin;       // first sighting wins — stable evidence
        }
      }
      onWindow?.(ci, start + windowN, people);   // checkpoint: next window to process
    }
  }
  if (dropped) log(`   ✂ verbatim gate dropped ${dropped} hallucinated form(s) (not present in their window)`);
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
    // dictionary first: Саша ↔ Олександр are a candidate pair at edit-distance ∞
    const rx = nameRoot(x), ry = nameRoot(y);
    if (rx !== null && ry !== null && rx === ry) return true;
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
        a.provenance = { ...(b.provenance ?? {}), ...(a.provenance ?? {}) };  // keep a's origins on clashes
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

export async function qaPass(
  ollamaIp: string, chats: TgMessage[][], labels: string[], people: Person[], groups: string[], windowN: number, log: (s: string) => void,
  resume?: { startUnit: number; startWin: number },
  onWindow?: (unit: number, nextStart: number) => void,
): Promise<number> {
  const leakGroup = groups[groups.length - 1]; // a missed person defaults to the last group (e.g. patient)
  const counters: Record<string, number> = {};
  for (const p of people) { const n = parseInt(p.token.replace(/^\D+/, ''), 10); counters[p.group] = Math.max(counters[p.group] ?? 0, Number.isNaN(n) ? 0 : n); }
  const startUnit = resume?.startUnit ?? 0;
  const startWin = resume?.startWin ?? 0;
  let added = 0;
  for (let ci = startUnit; ci < chats.length; ci++) {
    const messages = chats[ci];
    for (let start = (ci === startUnit ? startWin : 0); start < messages.length; start += windowN) {
      const msgs = messages.slice(start, start + windowN).map((m) => ({ id: m.id, text: flatten(m.text) })).filter((m) => m.text.trim());
      if (msgs.length === 0) continue;
      let r: { leaks?: Array<{ canonical?: string; forms?: string[] }> };
      try { r = await askJson(ollamaIp, prompts.qaLeakScan({ MESSAGES: JSON.stringify(msgs) })); } catch { continue; }
      for (const L of r.leaks ?? []) {
        const canonical = String(L.canonical ?? '').trim();
        if (!canonical || looksLikeToken(canonical)) continue;              // ignore tokens reported by mistake
        const rawForms = [...new Set([...(Array.isArray(L.forms) ? L.forms.map(String) : []), canonical].map((s) => s.trim()).filter((s) => s && !looksLikeToken(s)))];
        // same verbatim gate as discovery: a leak must actually OCCUR in this window's text
        const winLow = msgs.map((m) => ({ id: m.id, raw: m.text, text: m.text.toLowerCase() }));
        const witnessed: Array<{ form: string; origin: FormOrigin }> = [];
        for (const f of rawForms) {
          const hit = winLow.find((m) => m.text.includes(f.toLowerCase()));
          if (hit) witnessed.push({ form: f, origin: { doc: labels[ci], messageId: hit.id, context: hit.raw.slice(0, 220) } });
        }
        if (witnessed.length === 0) continue;
        const formsN = witnessed.map((w) => norm(w.form));
        // deterministic surname guard here too — QA additions must not glue onto a foreign person
        let e = people.find((x) => (norm(x.canonical) === norm(canonical) || x.forms.some((f) => formsN.includes(norm(f))))
          && tokensCompatible(x, canonical));
        if (!e) {
          e = { token: `${leakGroup}${++counters[leakGroup]}`, group: leakGroup, canonical, forms: [], provenance: {} };
          people.push(e); added++;
          log(`   ✗ QA leak caught: ${canonical} → ${e.token}`);
        }
        e.provenance ??= {};
        for (const w of witnessed) {
          if (!tokensCompatible(e, w.form)) continue;   // foreign surname riding along → veto
          if (!e.forms.includes(w.form)) e.forms.push(w.form);
          e.provenance[w.form] ??= w.origin;
        }
      }
      onWindow?.(ci, start + windowN);   // checkpoint: next window in this round
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
