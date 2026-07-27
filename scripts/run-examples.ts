#!/usr/bin/env node
// HW2 — run the test queries and write outputs/retrieval_examples.md in the required format.
// Queries are in the KB's language (uk/ru) and target different chunks, incl. a person-router query and
// a deliberately weak one, so the analysis has something honest to say.
//
//   node scripts/run-examples.ts [--ollamaIp host:port]

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrieve } from './retrieve.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ollamaIp = (() => { const i = args.indexOf('--ollamaIp'); return i >= 0 && args[i + 1] ? args[i + 1] : '127.0.0.1:11434'; })();

const QUERIES = [
  'скільки коштує гігієна для пацієнта на брекетах?',
  'коли гігієна коштує 1800 грн?',
  'чи можна називати ціну імпланта по телефону?',
  'що входить у вартість для пацієнтів з імплантами?',
  'яка знижка для пенсіонерів?',
  'як діяти якщо пацієнт тисне на ціну?',
  'розкажи все про patient1',
  'яка політика щодо телефонних консультацій?',
];

let md = `# HW2 — semantic retrieval examples\n\nEmbedding model: **nomic-embed-text** (local, Ollama) · store: brute-force cosine over a saved matrix (\`index/index.json\`) · k=3.\n\nEach query is embedded with the same model as the chunks, scored by cosine against all 18 chunks (12 propositions + 6 person cards), top-3 returned. Comments added after inspecting results.\n`;

for (const q of QUERIES) {
  const results = await retrieve(q, 3, ollamaIp);
  md += `\n---\n\n**Query:** ${q}\n\n`;
  results.forEach((r, i) => {
    md += `Top-${i + 1}: \`${r.chunk_id}\` | score: ${r.score.toFixed(3)} | ${r.chunk_type}\n`;
    md += `  Text: ${r.text.slice(0, 140).replace(/\n/g, ' ')}${r.text.length > 140 ? '…' : ''}\n`;
    md += `  Source: ${r.source_file}\n`;
  });
  md += `\nComment: _(fill)_\n`;
}

writeFileSync(join(ROOT, 'outputs/retrieval_examples.md'), md, 'utf8');
console.log(`✅ outputs/retrieval_examples.md — ${QUERIES.length} queries`);
