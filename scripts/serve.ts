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
<title>Клініка — довідковий пошук</title>
<style>
  :root { --teal:#0e7490; --teal-soft:#e0f2f7; --ink:#1e3a45; --line:#d7e3e8; --muted:#64818c; --card:#fff; }
  body { font: 15px/1.6 "Segoe UI", system-ui, sans-serif; max-width: 880px; margin: 0 auto; padding: 0 1rem 3rem; background:#f4f8fa; color:var(--ink); }
  header { display:flex; align-items:center; gap:.7rem; padding:1.2rem 0 1rem; border-bottom:3px solid var(--teal); margin-bottom:1.2rem; }
  .cross { width:34px; height:34px; border-radius:9px; background:var(--teal); color:#fff; display:grid; place-items:center; font-size:1.3rem; font-weight:700; }
  h1 { font-size:1.2rem; margin:0; font-weight:600; }
  h1 small { display:block; font-size:.75rem; font-weight:400; color:var(--muted); }
  form { display: flex; gap: .5rem; margin: 1rem 0; }
  input[type=text] { flex: 1; padding: .65rem .9rem; font-size: 1rem; border-radius: 10px; border: 1.5px solid var(--line); background:#fff; color:var(--ink); }
  input[type=text]:focus { outline:none; border-color:var(--teal); box-shadow:0 0 0 3px var(--teal-soft); }
  select { padding: .65rem .5rem; border-radius: 10px; border: 1.5px solid var(--line); background:#fff; color:var(--ink); }
  button { padding: .65rem 1.3rem; font-size: 1rem; border-radius: 10px; border: 0; cursor: pointer; font-weight:600; }
  #bSearch { background:#fff; color:var(--teal); border:1.5px solid var(--teal); }
  #bSearch:hover { background:var(--teal-soft); }
  #bAsk { background:var(--teal); color:#fff; }
  #bAsk:hover { background:#0a5c73; }
  .answer { border-left:4px solid var(--teal); border-radius:10px; padding:1rem 1.2rem; margin:1rem 0; background:var(--card); box-shadow:0 1px 4px rgba(30,58,69,.08); font-size:1.05rem; }
  .answer .who { font-size:.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; margin-bottom:.35rem; }
  details { margin:.7rem 0; }
  summary { cursor:pointer; color:var(--teal); font-size:.85rem; }
  pre.prompt { white-space:pre-wrap; font:12px/1.5 ui-monospace, monospace; background:#fbfdfe; border:1px solid var(--line); border-radius:10px; padding:.9rem; color:#41626e; max-height:420px; overflow:auto; }
  .hit { border:1px solid var(--line); border-radius:12px; padding:.75rem 1rem .65rem; margin:.7rem 0; background:var(--card); box-shadow:0 1px 3px rgba(30,58,69,.05); }
  .hit.person { border-left:4px solid #c9a227; }
  .head { display:flex; justify-content:space-between; align-items:baseline; gap:.6rem; font-size:.82rem; font-family:ui-monospace, monospace; }
  .rank { color:var(--teal); font-weight:700; }
  .type { color:#c9a227; }
  .score { color:#15803d; font-weight:bold; }
  .gap { color:#b91c1c; font-size:.76rem; }
  .bar { height:5px; border-radius:3px; background:var(--teal-soft); margin:.4rem 0 .5rem; overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#67b7c9,var(--teal)); }
  .text { margin:.2rem 0 .5rem; }
  .meta { display:flex; flex-wrap:wrap; gap:.35rem .5rem; font-size:.74rem; font-family:ui-monospace, monospace; }
  .tag { background:#f0f6f8; border:1px solid var(--line); border-radius:6px; padding:.12rem .5rem; color:var(--muted); }
  .tag b { color:var(--ink); font-weight:600; }
  .tag.actor { color:#1d4ed8; border-color:#c7d7f5; background:#eef3fd; }
  .tag.time { color:#92600a; border-color:#ecd9ae; background:#fdf6e7; }
  .tag.route { color:#6d28d9; border-color:#ddd1f5; background:#f5f0fd; }
  .empty { color:var(--muted); }
  .qinfo { font-size:.8rem; color:var(--muted); font-family:ui-monospace, monospace; margin:.5rem 0; }
  button:disabled { opacity:.55; cursor:progress; }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid #fff; border-top-color:transparent; border-radius:50%; animation:r .8s linear infinite; vertical-align:-2px; margin-right:.45rem; }
  #bSearch .spin { border-color:var(--teal); border-top-color:transparent; }
  @keyframes r { to { transform:rotate(360deg); } }
  .waiting { display:flex; align-items:center; gap:.7rem; border:1px dashed var(--line); border-radius:12px; padding:1rem 1.2rem; margin:1rem 0; background:var(--card); color:var(--muted); }
  .waiting .spin { border-color:var(--teal); border-top-color:transparent; width:18px; height:18px; }
</style>
<header>
  <div class=cross>+</div>
  <h1>Довідковий пошук клініки<small>internal knowledge base · semantic retrieval · gemma4:26b (local)</small></h1>
</header>
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

  const bSearch=document.getElementById('bSearch');
  let timer=null;
  function busy(mode, on) {
    bSearch.disabled = bAsk.disabled = on;
    clearInterval(timer);
    if (on) {
      const label = mode==='ask' ? 'Питаю gemma' : 'Шукаю';
      const btn = mode==='ask' ? bAsk : bSearch;
      btn.innerHTML = '<span class=spin></span>'+label;
      const t0 = Date.now();
      out.className=''; out.innerHTML = '<div class=waiting><span class=spin></span><span id=wmsg>'
        + (mode==='ask' ? 'Шукаю чанки та питаю gemma… локальна модель, зазвичай 20–60 с' : 'Шукаю…')
        + ' <b id=el>0</b> с</span></div>';
      timer = setInterval(()=>{ const el=document.getElementById('el'); if(el) el.textContent=Math.round((Date.now()-t0)/1000); }, 1000);
    } else {
      bSearch.textContent='Search'; bAsk.textContent='Ask';
    }
  }
  async function go(mode) {
    if (!q.value.trim()) { q.focus(); return; }
    busy(mode, true);
    let r, d;
    try {
      r = await fetch('/api/'+mode+'?q='+encodeURIComponent(q.value)+'&k='+kSel.value);
      if (!r.ok) { out.className='empty'; out.textContent = 'Error: '+await r.text(); return; }
      d = await r.json();
    } catch (e) { out.className='empty'; out.textContent = 'Error: '+e; return; }
    finally { busy(mode, false); }
    out.className='';
    if (mode==='search') {
      const max=d.length?d[0].score:0, min=d.length?d[d.length-1].score:0;
      out.innerHTML = '<div class=qinfo>query: “'+esc(q.value)+'” · '+d.length+' results · top '+max.toFixed(3)+' · spread '+(max-min).toFixed(3)+'</div>' + renderHits(d);
    } else {
      out.innerHTML =
        '<div class=answer><div class=who>Відповідь адміністратора · gemma4:26b · single-shot</div>'+esc(d.answer)+'</div>'
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
