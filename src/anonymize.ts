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
      let found: { people?: Array<{ canonical?: string; group?: string; forms?: string[] }> };
      try { found = await askJson(ollamaIp, prompt, schema); } catch { continue; }

      for (const p of found.people ?? []) {
        if (!p.canonical) continue;
        if (!Array.isArray(p.forms) || p.forms.length === 0) p.forms = [p.canonical]; // never drop a person
        const formsN = p.forms.map(norm);
        // same person only if canonical matches or a spelling overlaps one we already know
        let e = people.find((x) => norm(x.canonical) === norm(p.canonical) || x.forms.some((f) => formsN.includes(norm(f))));
        if (!e) {
          const group = groups.includes(p.group ?? '') ? p.group! : groups[groups.length - 1];
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

/** real→token pairs + name-part derivation (so a lone surname is caught), longest-first. */
function buildPairs(people: Person[]): Array<{ real: string; token: string }> {
  const pairs = people.flatMap((p) => p.forms.map((f) => ({ real: f, token: p.token })));
  const seen = new Set(pairs.map((p) => norm(p.real)));
  for (const p of [...pairs]) for (const part of p.real.trim().split(/\s+/))
    if (part.length >= 3 && !seen.has(norm(part))) { pairs.push({ real: part, token: p.token }); seen.add(norm(part)); }
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
