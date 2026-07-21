#!/usr/bin/env node
// HW2 — retrieval daemon: a web UI over the semantic search, built to DIAGNOSE rankings, not just
// show them. Each hit renders its full metadata (actors, timeframe, message ids, aliases, routes),
// a score bar, and the GAP to the previous hit — tight gaps are exactly why "wrong" results win.
// Zero dependencies: plain node:http, one inline HTML page, one JSON endpoint.
//
//   node scripts/serve.ts [--port 3434] [--ollamaIp host:port]
//   GET  /                     → the UI
//   GET  /api/search?q=…&k=18  → full chunks + scores, ranked

import { createServer } from 'node:http';
import { retrieve } from './retrieve.ts';

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = parseInt(flag('port', '3434'), 10);
const OLLAMA = flag('ollamaIp', '127.0.0.1:11434');

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tg-chunker — semantic search</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; background:#111; color:#ddd; }
  h1 { font-size: 1.15rem; color:#fff; }
  form { display: flex; gap: .5rem; margin: 1rem 0; }
  input[type=text] { flex: 1; padding: .6rem .8rem; font-size: 1rem; border-radius: 8px; border: 1px solid #444; background:#1c1c1c; color:#eee; }
  select { padding: .6rem .4rem; border-radius: 8px; border: 1px solid #444; background:#1c1c1c; color:#eee; }
  button { padding: .6rem 1.2rem; font-size: 1rem; border-radius: 8px; border: 0; background:#3b6ef5; color:#fff; cursor: pointer; }
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
<h1>tg-chunker — semantic search <span style="color:#666;font-weight:400">(diagnostic view)</span></h1>
<form id=f>
  <input type=text id=q placeholder="e.g. скільки коштує гігієна на брекетах?" autofocus>
  <select id=k><option value=3>top 3</option><option value=5 selected>top 5</option><option value=10>top 10</option><option value=18>all 18</option></select>
  <button>Search</button>
</form>
<div id=out class=empty>Type a question and hit Search. Pick “all 18” to see the whole score distribution — tight gaps between scores are usually WHY a wrong chunk wins.</div>
<script>
  const f=document.getElementById('f'), q=document.getElementById('q'), kSel=document.getElementById('k'), out=document.getElementById('out');
  const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const tag = (label, val, cls='') => val && String(val).length ? '<span class="tag '+cls+'"><b>'+label+'</b> '+esc(val)+'</span>' : '';
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!q.value.trim()) return;
    out.className='empty'; out.textContent='Searching…';
    const r = await fetch('/api/search?q='+encodeURIComponent(q.value)+'&k='+kSel.value);
    if (!r.ok) { out.textContent = 'Error: '+await r.text(); return; }
    const hits = await r.json();
    if (!hits.length) { out.textContent='No results.'; return; }
    const max = hits[0].score;
    out.className='';
    out.innerHTML = '<div class=qinfo>query: “'+esc(q.value)+'” · '+hits.length+' results · top score '+max.toFixed(3)+' · spread '+(max-hits[hits.length-1].score).toFixed(3)+'</div>'
      + hits.map((h,i) => {
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
  };
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q')?.trim();
    const k = Math.max(1, Math.min(50, parseInt(url.searchParams.get('k') ?? '5', 10) || 5));
    if (!q) { res.writeHead(400).end('missing q'); return; }
    try {
      const hits = await retrieve(q, k, OLLAMA);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(hits));
    } catch (e) {
      res.writeHead(500).end(String(e));   // fail loud — a broken index/model must be visible
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
}).listen(PORT, '0.0.0.0', () => console.log(`tg-chunker search UI → http://0.0.0.0:${PORT} (ollama @ ${OLLAMA})`));
