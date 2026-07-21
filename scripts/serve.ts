#!/usr/bin/env node
// HW2 — retrieval daemon: a tiny web UI over the semantic search.
// Zero dependencies: plain node:http, one inline HTML page (search bar + button), one JSON endpoint.
//
//   node scripts/serve.ts [--port 3434] [--ollamaIp host:port]
//   GET  /                    → the UI
//   GET  /api/search?q=...&k=3 → [{chunk_id, score, chunk_type, text, source_file, document_id}]

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
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; background:#111; color:#ddd; }
  h1 { font-size: 1.2rem; color:#fff; }
  form { display: flex; gap: .5rem; margin: 1rem 0; }
  input { flex: 1; padding: .6rem .8rem; font-size: 1rem; border-radius: 8px; border: 1px solid #444; background:#1c1c1c; color:#eee; }
  button { padding: .6rem 1.2rem; font-size: 1rem; border-radius: 8px; border: 0; background:#3b6ef5; color:#fff; cursor: pointer; }
  .hit { border: 1px solid #333; border-radius: 10px; padding: .8rem 1rem; margin: .8rem 0; background:#191919; }
  .head { display:flex; justify-content:space-between; font-size:.85rem; color:#8ab4ff; font-family:monospace; }
  .score { color:#7bd88f; }
  .text { margin:.5rem 0 .3rem; }
  .src { font-size:.8rem; color:#888; font-family:monospace; }
  .empty { color:#888; }
</style>
<h1>tg-chunker — semantic search (top-k)</h1>
<form id=f><input id=q placeholder="e.g. скільки коштує гігієна на брекетах?" autofocus><button>Search</button></form>
<div id=out class=empty>Type a question and hit Search.</div>
<script>
  const f=document.getElementById('f'), q=document.getElementById('q'), out=document.getElementById('out');
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!q.value.trim()) return;
    out.className='empty'; out.textContent='Searching…';
    const r = await fetch('/api/search?q='+encodeURIComponent(q.value)+'&k=3');
    if (!r.ok) { out.textContent = 'Error: '+await r.text(); return; }
    const hits = await r.json();
    out.className=''; out.innerHTML = hits.map((h,i) =>
      '<div class=hit><div class=head><span>Top-'+(i+1)+' · '+h.chunk_id+' · '+h.chunk_type+'</span><span class=score>'+h.score.toFixed(3)+'</span></div>'+
      '<div class=text>'+h.text.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>'+
      '<div class=src>'+h.source_file+' · '+h.document_id+'</div></div>').join('') || '<div class=empty>No results.</div>';
  };
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q')?.trim();
    const k = Math.max(1, Math.min(10, parseInt(url.searchParams.get('k') ?? '3', 10) || 3));
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
