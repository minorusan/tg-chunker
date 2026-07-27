#!/usr/bin/env node
// DESKTOP CHAT — the clinic agent, split-screen.
// LEFT: one rolling chat window. The server is STATELESS — the full transcript rides in every request;
// per turn we run the pipeline on the latest question (gemma-domains extractor → domain filter →
// hybrid BM25⊕cosine top-k) and fuse instruction + fragments + transcript into one prompt. The agent's
// business goal (see prompts/07_chat_agent.md): answer fully from the KB and STRIVE TO MAKE THE
// PATIENT STAY — every reply pulls toward a booking / free first exam.
// RIGHT: the pipeline X-ray for the latest turn — extracted domains, searched pool, injected chunks,
// the exact prompt. Fully copyable.
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/serve.ts [--port 3434]

import { createServer } from 'node:http';
import { improvedRetrieve } from './retrieval_improved.ts';
import { askText } from '../src/ollama.ts';
import { prompts } from '../src/prompts.ts';

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = parseInt(flag('port', '3434'), 10);
const OLLAMA = flag('ollamaIp', '127.0.0.1:11434');
const K = 5;

function contextOf(hits: Array<Record<string, any>>): string {
  return hits.map((h, i) => {
    const tf = (h.timeframe ?? []) as string[];
    const when = tf.length ? tf[0].slice(0, 10) : 'дата невідома';
    return `[${i + 1}] (${h.chunk_id}, ${when}) ${h.text}`;
  }).join('\n');
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Клініка — чат з адміністратором</title>
<style>
  :root { --teal:#0e7490; --teal-soft:#e0f2f7; --ink:#1e3a45; --line:#d7e3e8; --muted:#64818c; --card:#fff; }
  * { box-sizing:border-box; }
  body { font: 15px/1.55 "Segoe UI", system-ui, sans-serif; margin:0; height:100vh; display:flex; flex-direction:column; background:#f4f8fa; color:var(--ink); }
  header { display:flex; align-items:center; gap:.7rem; padding:.7rem 1.2rem; border-bottom:3px solid var(--teal); background:#fff; flex:0 0 auto; }
  .cross { width:30px; height:30px; border-radius:8px; background:var(--teal); color:#fff; display:grid; place-items:center; font-size:1.15rem; font-weight:700; }
  h1 { font-size:1.05rem; margin:0; font-weight:600; }
  h1 small { display:block; font-size:.7rem; font-weight:400; color:var(--muted); }
  main { flex:1 1 auto; display:grid; grid-template-columns: minmax(420px, 1fr) minmax(380px, 42%); min-height:0; }
  /* ── left: chat ── */
  #chatcol { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--line); }
  #log { flex:1 1 auto; overflow-y:auto; padding:1rem 1.2rem; display:flex; flex-direction:column; gap:.6rem; }
  .msg { max-width:78%; padding:.6rem .9rem; border-radius:14px; white-space:pre-wrap; position:relative; }
  .msg.user { align-self:flex-end; background:var(--teal); color:#fff; border-bottom-right-radius:4px; }
  .msg.bot { align-self:flex-start; background:#fff; border:1px solid var(--line); border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(30,58,69,.06); }
  .msg .mcopy { position:absolute; top:.25rem; right:.35rem; opacity:0; transition:opacity .15s; }
  .msg:hover .mcopy { opacity:1; }
  .msg.bot .routeline { font-size:.7rem; color:var(--muted); font-family:ui-monospace,monospace; margin-top:.45rem; border-top:1px dashed var(--line); padding-top:.3rem; }
  .typing { align-self:flex-start; color:var(--muted); font-size:.85rem; padding:.4rem .2rem; }
  form { flex:0 0 auto; display:flex; gap:.5rem; padding: .8rem 1.2rem; background:#fff; border-top:1px solid var(--line); }
  textarea { flex:1; resize:none; height:52px; padding:.6rem .8rem; font:inherit; font-size:16px; border-radius:10px; border:1.5px solid var(--line); }
  textarea:focus { outline:none; border-color:var(--teal); box-shadow:0 0 0 3px var(--teal-soft); }
  button.send { padding:.6rem 1.4rem; font-size:1rem; border-radius:10px; border:0; background:var(--teal); color:#fff; cursor:pointer; font-weight:600; }
  button.send:disabled { opacity:.55; }
  /* ── right: x-ray ── */
  #xray { overflow-y:auto; padding:1rem 1.2rem; min-height:0; background:#fbfdfe; }
  #xray h2 { font-size:.85rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:.2rem 0 .6rem; }
  .qinfo { font-size:.8rem; color:var(--muted); font-family:ui-monospace,monospace; margin:.4rem 0; overflow-wrap:anywhere; }
  .hit { border:1px solid var(--line); border-radius:10px; padding:.6rem .8rem; margin:.5rem 0; background:#fff; font-size:.85rem; }
  .hit.person { border-left:4px solid #c9a227; }
  .hit .hid { font-family:ui-monospace,monospace; font-size:.75rem; color:var(--teal); display:flex; justify-content:space-between; }
  .hit .doms { font-size:.72rem; color:#6d28d9; font-family:ui-monospace,monospace; }
  details { margin:.6rem 0; }
  summary { cursor:pointer; color:var(--teal); font-size:.83rem; }
  pre.prompt { white-space:pre-wrap; font:11.5px/1.5 ui-monospace,monospace; background:#fff; border:1px solid var(--line); border-radius:8px; padding:.7rem; color:#41626e; max-height:46vh; overflow:auto; }
  .copy { padding:.12rem .5rem; font-size:.7rem; border-radius:6px; border:1px solid var(--line); background:#fff; color:var(--muted); cursor:pointer; }
  .copy:hover { border-color:var(--teal); color:var(--teal); }
  .copy.ok { border-color:#15803d; color:#15803d; }
  .rowtools { display:flex; justify-content:space-between; align-items:center; gap:.5rem; }
  .empty { color:var(--muted); font-size:.85rem; }
</style>
<header>
  <div class=cross>+</div>
  <h1>Чат з адміністратором клініки<small>gemma-domains router · hybrid RAG · gemma4:26b · stateless (transcript rides each request)</small></h1>
</header>
<main>
  <div id=chatcol>
    <div id=log></div>
    <form id=f>
      <textarea id=q placeholder="Напишіть повідомлення… (Enter — надіслати, Shift+Enter — новий рядок)" autofocus></textarea>
      <button class=send id=send>➤</button>
    </form>
  </div>
  <div id=xray><h2>Pipeline X-ray</h2><div class=empty>Тут з'являться нутрощі останнього запиту: домени від екстрактора, звужений пул, інжектовані чанки і точний промпт.</div></div>
</main>
<script>
  const log=document.getElementById('log'), f=document.getElementById('f'), q=document.getElementById('q'), send=document.getElementById('send'), xray=document.getElementById('xray');
  const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const history = [];   // [{role:'user'|'assistant', content}] — the client IS the session
  window.copyText = async (btn, text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else { const t=document.createElement('textarea'); t.value=text; t.style.position='fixed'; t.style.opacity='0'; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
      btn.classList.add('ok'); const o=btn.textContent; btn.textContent='✓'; setTimeout(()=>{btn.classList.remove('ok');btn.textContent=o;},1100);
    } catch(e){ btn.textContent='✗'; }
  };
  function addMsg(role, text, route) {
    const div=document.createElement('div');
    div.className='msg '+(role==='user'?'user':'bot');
    div.innerHTML = esc(text) + (route?'<div class=routeline>'+esc(route)+'</div>':'')
      + '<button class="copy mcopy" onclick="copyText(this,this.parentNode.__t)">📋</button>';
    div.__t = text;
    div.querySelector('.mcopy').onclick = function(){ copyText(this, text); };
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function renderXray(d) {
    let h = '<h2>Pipeline X-ray <button class=copy style="float:right" onclick="copyText(this, window.__xr)">📋 все</button></h2>';
    h += '<div class=qinfo>🧭 gemma-domains → ['+(d.filterDomains||[]).join(', ')+']<br>searched '+d.searched+'/'+d.total+' chunks'+(d.fellBack?' · ⚠ fallback (filter too narrow)':'')+'</div>';
    h += '<h2>Injected chunks ('+d.hits.length+')</h2>';
    for (const [i,x] of d.hits.entries())
      h += '<div class="hit '+(x.chunk_type==='person'?'person':'')+'"><div class=hid><span>Top-'+(i+1)+' · '+esc(x.chunk_id)+' · cos#'+x.cosRank+' bm25#'+x.bm25Rank+'</span><button class=copy onclick="copyText(this,'+JSON.stringify(JSON.stringify(x.text)).replace(/"/g,'&quot;')+' && void 0)">📋</button></div><div class=doms>'+esc((x.domains||[]).join(' · '))+'</div>'+esc(x.text)+'</div>';
    h += '<details open><summary>▸ exact prompt sent to gemma <button class=copy onclick="event.preventDefault();copyText(this, window.__pr)">📋</button></summary><pre class=prompt>'+esc(d.prompt)+'</pre></details>';
    xray.innerHTML = h;
    window.__pr = d.prompt;
    window.__xr = '🧭 '+(d.filterDomains||[]).join(', ')+' · '+d.searched+'/'+d.total+'\\n\\n'+d.hits.map((x,i)=>'Top-'+(i+1)+' ['+x.chunk_id+']\\n'+x.text).join('\\n\\n');
    // fix per-hit copy buttons (inline JSON escaping is fragile — rebind cleanly)
    [...xray.querySelectorAll('.hit')].forEach((el,i)=>{ const b=el.querySelector('.copy'); if(b) b.onclick=()=>copyText(b, d.hits[i].text); });
  }
  async function go() {
    const text=q.value.trim(); if(!text) return;
    q.value=''; addMsg('user', text);
    history.push({role:'user', content:text});
    send.disabled=true;
    const t=document.createElement('div'); t.className='typing'; t.textContent='адміністраторка друкує… (локальна модель, зачекайте)'; log.appendChild(t); log.scrollTop=log.scrollHeight;
    try {
      const r = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({messages: history, k: ${K}})});
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      history.push({role:'assistant', content:d.answer});
      t.remove();
      addMsg('assistant', d.answer, '🧭 '+(d.filterDomains||[]).join(', ')+' · '+d.searched+'/'+d.total+' chunks'+(d.fellBack?' · fallback':''));
      renderXray(d);
    } catch(e) { t.remove(); addMsg('assistant', 'Помилка: '+e.message); history.pop(); }
    finally { send.disabled=false; q.focus(); }
  }
  f.onsubmit = (e)=>{ e.preventDefault(); go(); };
  q.onkeydown = (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); go(); } };
</script>`;

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { messages, k } = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; k?: number };
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        if (!lastUser) { res.writeHead(400).end('no user message'); return; }
        // pipeline on the latest question; transcript = everything BEFORE it
        const r = await improvedRetrieve(lastUser.content, Math.max(1, Math.min(10, k ?? K)), OLLAMA);
        const transcript = messages.slice(0, -1).map((m) => `${m.role === 'user' ? 'Пацієнт' : 'Адміністраторка'}: ${m.content}`).join('\n') || '(початок розмови)';
        const prompt = prompts.chatAgent({ CONTEXT: contextOf(r.hits), TRANSCRIPT: transcript, QUESTION: lastUser.content });
        const answer = await askText(OLLAMA, prompt);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ answer, prompt, hits: r.hits, filterDomains: r.filterDomains, searched: r.searched, total: r.total, fellBack: r.fellBack }));
      } catch (e) {
        res.writeHead(500).end(String(e));   // fail loud
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
}).listen(PORT, '0.0.0.0', () => console.log(`clinic chat agent → http://0.0.0.0:${PORT} (gateway: ${process.env.LLM_GATEWAY ?? 'UNSET'})`));