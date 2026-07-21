#!/usr/bin/env node
// HW2 — retrieval daemon: search UI + full RAG answering, built to DIAGNOSE, not just show.
//
// Two flows, one page:
//   Search → ranked chunks with full metadata, score bars, and gap-to-previous (tight gaps are
//            exactly why "wrong" results win).
//   Ask    → retrieve top-k, INJECT them into the clinic-administrator prompt, gemma answers in
//            Ukrainian. SINGLE-SHOT: no chat session, every question stands alone. The UI shows the
//            answer, the EXACT resulting prompt that was sent, and the retrieved chunks — so you can
//            trace answer ← prompt ← chunks ← scores end to end.
//
//   node scripts/serve.ts [--port 3434] [--ollamaIp host:port]
//   GET /api/search?q=…&k=…  → ranked full chunks + scores
//   GET /api/ask?q=…&k=…     → {answer, prompt, hits}

import { createServer } from 'node:http';
import { retrieve } from './retrieve.ts';
import { askText } from '../src/ollama.ts';
import { prompts } from '../src/prompts.ts';

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = parseInt(flag('port', '3434'), 10);
const OLLAMA = flag('ollamaIp', '127.0.0.1:11434');

/** Render retrieved chunks into the {{CONTEXT}} block: text + the metadata the model needs (dates for
 *  recency conflicts, source for provenance). Person chunks add aliases/routes. */
function contextOf(hits: Array<Record<string, any>>): string {
  return hits.map((h, i) => {
    const tf = (h.timeframe ?? []) as string[];
    const when = tf.length ? tf[0].slice(0, 10) : 'дата невідома';
    return `[${i + 1}] (${h.chunk_id}, ${when}, джерело: ${h.document_id}) ${h.text}`;
  }).join('\n');
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tg-chunker — RAG search</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; background:#111; color:#ddd; }
  h1 { font-size: 1.15rem; color:#fff; }
  form { display: flex; gap: .5rem; margin: 1rem 0; }
  input[type=text] { flex: 1; padding: .6rem .8rem; font-size: 1rem; border-radius: 8px; border: 1px solid #444; background:#1c1c1c; color:#eee; }
  select { padding: .6rem .4rem; border-radius: 8px; border: 1px solid #444; background:#1c1c1c; color:#eee; }
  button { padding: .6rem 1.1rem; font-size: 1rem; border-radius: 8px; border: 0; cursor: pointer; }
  #bSearch { background:#3b6ef5; color:#fff; }
  #bAsk { background:#2f8f4e; color:#fff; }
  .answer { border:1px solid #2f8f4e; border-radius:10px; padding:.9rem 1.1rem; margin:.8rem 0; background:#12211a; color:#d9f2e2; font-size:1.05rem; }
  .answer .who { font-size:.75rem; color:#7bd88f; font-family:monospace; margin-bottom:.3rem; }
  details { margin:.6rem 0; }
  summary { cursor:pointer; color:#8ab4ff; font-size:.85rem; font-family:monospace; }
  pre.prompt { white-space:pre-wrap; font:12px/1.5 monospace; background:#181818; border:1px solid #333; border-radius:8px; padding: .8rem; color:#bbb; max-height:420px; overflow:auto; }
  .hit { border: 1px solid #333; border-radius: 10px; padding: .7rem 1rem .6rem; margin: .7rem 0; background:#191919; }
  .hit.person { border-color:#5a4a20; background:#1d1a12; }
  .head { display:flex; justify-content:space-between; align-items:baseline; gap:.6rem; font-size:.85rem; font-family:monospace; }
  .rank { color:#8ab4ff; }
  .type { color:#c99a3c; }
  .score { color:#7bd88f; font-weight:bold; }
  .gap { color:#e06c60; font-size:.78rem; }
  .bar { height: 4px; border-radius: 2px; background:#2a2a2a; margin:.4rem 0 .5rem; overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#2f6b3f,#7bd88f); }
  .text { margin:.2rem 0 .5rem; color:#eee; }
  .meta { display:flex; flex-wrap:wrap; gap:.35rem .5rem; font-size:.76rem; font-family:monospace; }
  .tag { background:#242424; border:1px solid #383838; border-radius:5px; padding:.1rem .45rem; color:#aaa; }
  .tag b { color:#ccc; font-weight:600; }
  .tag.actor { color:#8ab4ff; border-color:#31435f; }
  .tag.time { color:#c99a3c; border-color:#4d3d1e; }
  .tag.route { color:#b48ef0; border-color:#43315f; }
  .empty { color:#888; }
  .qinfo { font-size:.8rem; color:#888; font-family:monospace; margin:.4rem 0; }
</style>
<h1>tg-chunker — RAG search <span style="color:#666;font-weight:400">(retrieve · inject · answer)</span></h1>
<form id=f>
  <input type=text id=q placeholder="e.g. скільки коштує гігієна на брекетах?" autofocus>
  <select id=k><option value=3>top 3</option><option value=5 selected>top 5</option><option value=10>top 10</option><option value=18>all 18</option></select>
  <button id=bSearch type=submit>Search</button>
  <button id=bAsk type=button>Ask</button>
</form>
<div id=out class=empty>«Search» показує top-k чанки. «Ask» — повний RAG: чанки інжектяться у промпт, gemma відповідає українською як адміністратор клініки. Без сесії — кожне питання окремо.</div>
<script>
  const f=document.getElementById('f'), q=document.getElementById('q'), kSel=document.getElementById('k'), out=document.getElementById('out'), bAsk=document.getElementById('bAsk');
  const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const tag = (label, val, cls='') => val && String(val).length ? '<span class="tag '+cls+'"><b>'+label+'</b> '+esc(val)+'</span>' : '';

  function renderHits(hits) {
    if (!hits.length) return '<div class=empty>No results.</div>';
    const max = hits[0].score;
    return hits.map((h,i) => {
      const gap = i===0 ? '' : '<span class=gap>−'+(hits[i-1].score-h.score).toFixed(3)+' vs Top-'+i+'</span>';
      const tf = (h.timeframe||[]);
      const when = tf.length ? tf[0].slice(0,10)+(tf.length>1?' → '+tf[tf.length-1].slice(0,10):'') : '';
      return '<div class="hit '+(h.chunk_type==='person'?'person':'')+'">'
        + '<div class=head><span><span class=rank>Top-'+(i+1)+'</span> · '+esc(h.chunk_id)+' · <span class=type>'+esc(h.chunk_type)+'</span></span>'
        + '<span>'+gap+' <span class=score>'+h.score.toFixed(3)+'</span></span></div>'
        + '<div class=bar><i style="width:'+(h.score/max*100).toFixed(1)+'%"></i></div>'
        + '<div class=text>'+esc(h.text)+'</div>'
        + '<div class=meta>'
        + tag('doc', h.document_id) + tag('src', h.source_file) + tag('title', h.title)
        + tag('actors', (h.actors||[]).join(', '), 'actor')
        + tag('when', when, 'time')
        + tag('msgs', (h.message_ids||[]).join(','))
        + tag('aliases', (h.aliases||[]).join(' · '), 'actor')
        + tag('routes to', (h.mentioned_at||[]).join(', '), 'route')
        + '</div></div>';
    }).join('');
  }

  async function go(mode) {
    if (!q.value.trim()) return;
    out.className='empty'; out.textContent = mode==='ask' ? 'Retrieving + asking gemma… (перша відповідь може зайняти ~хвилину)' : 'Searching…';
    const r = await fetch('/api/'+mode+'?q='+encodeURIComponent(q.value)+'&k='+kSel.value);
    if (!r.ok) { out.textContent = 'Error: '+await r.text(); return; }
    const d = await r.json();
    out.className='';
    if (mode==='search') {
      const max=d.length?d[0].score:0, min=d.length?d[d.length-1].score:0;
      out.innerHTML = '<div class=qinfo>query: “'+esc(q.value)+'” · '+d.length+' results · top '+max.toFixed(3)+' · spread '+(max-min).toFixed(3)+'</div>' + renderHits(d);
    } else {
      out.innerHTML =
        '<div class=answer><div class=who>gemma4:26b · адміністратор клініки · single-shot (без сесії)</div>'+esc(d.answer)+'</div>'
        + '<details><summary>▸ resulting prompt (what was actually sent to the model)</summary><pre class=prompt>'+esc(d.prompt)+'</pre></details>'
        + '<div class=qinfo>injected chunks ('+d.hits.length+'):</div>'
        + renderHits(d.hits);
    }
  }
  f.onsubmit = (e) => { e.preventDefault(); go('search'); };
  bAsk.onclick = () => go('ask');
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const q = url.searchParams.get('q')?.trim();
  const k = Math.max(1, Math.min(50, parseInt(url.searchParams.get('k') ?? '5', 10) || 5));

  if (url.pathname === '/api/search' || url.pathname === '/api/ask') {
    if (!q) { res.writeHead(400).end('missing q'); return; }
    try {
      const hits = await retrieve(q, k, OLLAMA);
      if (url.pathname === '/api/search') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(hits));
        return;
      }
      // RAG: inject the retrieved chunks into the clinic-administrator prompt, single-shot, no session.
      const prompt = prompts.ragAnswer({ CONTEXT: contextOf(hits), QUESTION: q });
      const answer = await askText(OLLAMA, prompt);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ answer, prompt, hits }));
    } catch (e) {
      res.writeHead(500).end(String(e));   // fail loud — a broken index/model must be visible
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
}).listen(PORT, '0.0.0.0', () => console.log(`tg-chunker RAG UI → http://0.0.0.0:${PORT} (ollama @ ${OLLAMA})`));
