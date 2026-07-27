#!/usr/bin/env node
// HW3 — baseline vs improved, same 8 queries as HW2 (rubric: outputs/retrieval_comparison.md).
// Baseline = HW2's pure-cosine retrieve(). Improved = gemma-domains extractor → domain filter →
// hybrid BM25⊕cosine (RRF). Comments are appended by hand after inspecting results.
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/run-comparison.ts

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrieve } from './retrieve.ts';
import { improvedRetrieve } from './retrieval_improved.ts';
import { labGate } from '../src/guest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IP = '127.0.0.1:11434';

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

let table = `| Query | Baseline top-1 | Improved top-1 | Що змінилось |\n|---|---|---|---|\n`;
let detail = '';
for (const q of QUERIES) {
  const base = await retrieve(q, 3, IP);
  const imp = await improvedRetrieve(q, 3, IP);
  const b1 = base[0], i1 = imp.hits[0];
  const note = [
    `🧭 [${imp.filterDomains.join(', ') || '—'}] → ${imp.searched}/${imp.total}${imp.fellBack ? ' (fallback)' : ''}`,
    b1.chunk_id === i1.chunk_id ? 'top-1 unchanged' : `top-1 CHANGED`,
    `hybrid: cos#${i1.cosRank}·bm25#${i1.bm25Rank}`,
  ].join(' · ');
  table += `| ${q} | ${b1.chunk_id} | ${i1.chunk_id} | ${note} |\n`;
  detail += `\n### ${q}\n`;
  detail += `- baseline (cosine only): ${base.map((h: any) => `${h.chunk_id}(${h.score.toFixed(3)})`).join(' · ')}\n`;
  detail += `- improved (filter+hybrid): ${imp.hits.map((h) => `${h.chunk_id}(cos#${h.cosRank},bm25#${h.bm25Rank})`).join(' · ')}\n`;
  detail += `- routing: [${imp.filterDomains.join(', ') || 'none'}] → searched ${imp.searched}/${imp.total}${imp.fellBack ? ' — fallback' : ''}\n`;
  console.log(`${q}\n  base: ${b1.chunk_id} → improved: ${i1.chunk_id}  ${note}`);
}

const md = `# HW3 — Baseline vs Improved retrieval (same 8 queries as HW2)

**Baseline:** HW2 pipeline — pure cosine (nomic-embed-text) over all 18 chunks.
**Improved:** (1) metadata filtering by \`domain\` — the filter value is EXTRACTED FROM THE QUERY by a
fine-tuned Gemma-3-270M ("gemma-domains", 81% exact-match on held-out test), so the search space
narrows BEFORE ranking; (2) hybrid search — BM25 keyword score fused with cosine via Reciprocal Rank
Fusion. Over-narrow filters fall back to the full corpus VISIBLY (marked "fallback").

${table}
## Per-query detail
${detail}
## Analysis
_(filled after inspection)_
`;
writeFileSync(join(ROOT, 'outputs/retrieval_comparison.md'), md, 'utf8');
await labGate()?.release();
console.log('\n✅ outputs/retrieval_comparison.md');