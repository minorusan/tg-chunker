// PASS 1 — ANONYMISE.
// Turn every real person into a stable role token (employee1, patient1, patient2…). Employees are the
// chat's own participants; patients are the clients they talk about. Placeholders like "Vasya Pupkin",
// brands and cities are left alone.
//
// Design choice worth noting: the MODEL only DECIDES (who is a person, which spellings, staff vs
// client). The CODE APPLIES the swap deterministically. We never let the model rewrite messages —
// that avoids it silently changing wording or mixing content between messages, and it makes the swap
// exact and reproducible.

import type { TgMessage, Person } from './types.ts';
import { prompts } from './prompts.ts';
import { askJson } from './ollama.ts';

// JSON schema handed to Ollama so gemma MUST return {people:[{canonical,class,forms:[…]}]} — no more
// inventing keys like `full_name` and silently dropping people.
const DISCOVER_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          class: { type: 'string', enum: ['employee', 'patient'] },
          forms: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonical', 'class', 'forms'],
      },
    },
  },
  required: ['people'],
};

const norm = (s: string) => s.toLowerCase().trim();
const flatten = (t: TgMessage['text']): string =>
  typeof t === 'string' ? t : Array.isArray(t) ? t.map((r) => (typeof r === 'string' ? r : r.text ?? '')).join('') : '';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Discover people across ALL chats into one shared map (so a patient is the same tokenN everywhere).
 *  Returns the people list; also seeds employees from the combined roster of chat participants. */
export async function discoverPeople(ollamaIp: string, chats: TgMessage[][], windowN: number, log: (s: string) => void): Promise<Person[]> {
  const roster = [...new Set(chats.flat().flatMap((m) => [m.from, m.actor].filter((x): x is string => !!x && x.trim() !== '')))];
  const people: Person[] = roster.map((name, i) => ({ token: `employee${i + 1}`, class: 'employee', canonical: name, forms: [name] }));
  let patientCount = 0;

  const peopleView = () => people.length ? people.map((p) => `${p.token} = ${p.canonical} (${p.forms.join(', ')})`).join('\n') : '(none yet)';

  for (const messages of chats) {
    for (let start = 0; start < messages.length; start += windowN) {
      const window = messages.slice(start, start + windowN);
      const msgs = window.map((m) => ({ id: m.id, from: m.from ?? null, text: flatten(m.text) }));
      const prompt = prompts.anonymizeDiscover({
        ROSTER: JSON.stringify(roster),
        PEOPLE: peopleView(),
        MESSAGES: JSON.stringify(msgs),
      });
      let found: { people?: Array<{ canonical?: string; class?: string; forms?: string[] }> };
      try { found = await askJson(ollamaIp, prompt, DISCOVER_SCHEMA); } catch { continue; }

      for (const p of found.people ?? []) {
        if (!p.canonical) continue;
        // Belt-and-suspenders: if forms somehow comes back empty, fall back to the canonical name so
        // the person is never silently dropped (a dropped person = a leaked real name).
        if (!Array.isArray(p.forms) || p.forms.length === 0) p.forms = [p.canonical];
        const formsN = p.forms.map(norm);
        // same person if the canonical matches, or any spelling overlaps one we already know
        let e = people.find((x) => norm(x.canonical) === norm(p.canonical) || x.forms.some((f) => formsN.includes(norm(f))));
        if (!e) {
          // NEW people are always patients — employees only come from the seeded roster, which keeps
          // the staff list honest (the model can't invent extra "employees").
          e = { token: `patient${++patientCount}`, class: 'patient', canonical: p.canonical, forms: [] };
          people.push(e);
          log(`   + patient: ${p.canonical} → ${e.token}`);
        }
        e.forms = [...new Set([...e.forms, ...p.forms])];
      }
    }
  }
  return people;
}

/** Build the real→token replacement pairs, plus name-part derivation (so a lone surname is caught),
 *  longest-first so full names are replaced before their parts. */
function buildPairs(people: Person[]): Array<{ real: string; token: string }> {
  const pairs = people.flatMap((p) => p.forms.map((f) => ({ real: f, token: p.token })));
  const seen = new Set(pairs.map((p) => norm(p.real)));
  for (const p of [...pairs]) for (const part of p.real.trim().split(/\s+/))
    if (part.length >= 3 && !seen.has(norm(part))) { pairs.push({ real: part, token: p.token }); seen.add(norm(part)); }
  return pairs.sort((a, b) => b.real.length - a.real.length);
}

/** Replace names with tokens IN PLACE. Uses whole-word matching (Unicode \p{L}) so a name is never
 *  swapped inside another word — e.g. "Якщо" must not become "employee8кщо". */
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
    replaced += (JSON.stringify([m.from, m.actor, flatten(m.text)]).match(/\b(employee|patient)\d+\b/g) ?? []).length;
  }
  return replaced;
}
