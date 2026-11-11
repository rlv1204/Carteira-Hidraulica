(() => {
'use strict';

/* Bloco de notas: a nota escrita aqui aparece no artefato Carteira Hidráulica, no app do Claude,
   para copiar e colar no chat. Descrição do cartão = nota. Comentários = resposta gravada pelo Claude.
   Usa a mesma conexão (chave e token) que a Carteira guarda neste navegador. */

const API = 'https://api.trello.com/1';
const BOARD = 'tZN5E4ad';
const CONN_KEY = 'ch.dash.trello';
const UI_KEY = 'ch.dash.ui';
const SEEN_KEY = 'ch.notas.seen';
const DRAFT_KEY = 'ch.notas.draft';
const LIST_NAMES = {todo: 'Notas', sent: 'Notas copiadas'};
const STATE = {todo: 'Para copiar', sent: 'Copiada'};
const POLL_MS = 30000;
const POLL_HIDDEN_MS = 120000;
const STALL_MS = 10 * 60000;
const LIMIT = 16000;          // o Trello aceita 16.384; a folga cobre a linha do código na cópia
const SENT_MAX = 40;
const CARD_FIELDS = 'name,idList,closed,dateLastActivity,badges,pos';

const $ = (s, r = document) => r.querySelector(s);
const BASE_TITLE = document.title;

function load(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } }
function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
function drop(k){ try { localStorage.removeItem(k); } catch(e){} }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

const st = {
  conn: load(CONN_KEY, null),
  lists: {}, cards: [], det: {},
  sel: null, mode: 'new', notice: null, confirm: false,
  q: '', lastOk: 0, saving: false,
  seen: load(SEEN_KEY, {})
};

/* ---------- Trello ---------- */
/* Chave e token vão sempre no cabeçalho Authorization, nunca no endereço. */
function send(method, path, params){
  const qs = new URLSearchParams();
  const opts = {method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: {Authorization: `OAuth oauth_consumer_key="${st.conn.key}", oauth_token="${st.conn.token}"`}};
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => qs.set(k, v));
  else opts.body = new URLSearchParams(params);
  const q = qs.toString();
  return fetch(`${API}${path}${q ? `?${q}` : ''}`, opts);
}
async function api(method, path, params = {}){
  let r;
  try { r = await send(method, path, params); }
  catch(e){ throw new Error('sem conexão com api.trello.com'); }
  if (!r.ok){
    const e = new Error(r.status === 401 ? 'token recusado pelo Trello' : r.status === 429 ? 'limite de requisições do Trello' : `erro ${r.status} do Trello`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

function parseName(name){
  const m = /^(N\d{3,})\s*(?:[-–—:]\s*)?(.*)$/.exec(name || '');
  return m ? {code: m[1], title: m[2] || m[1]} : {code: '', title: name || 'Sem título'};
}
function nextCode(cards){
  let max = 0;
  cards.forEach(c => { const m = /^N(\d{3,})/.exec(c.name || ''); if (m) max = Math.max(max, Number(m[1])); });
  return 'N' + String(max + 1).padStart(3, '0');
}
function titleOf(text){ return text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean).slice(0, 70); }
function listKey(card){ return Object.keys(st.lists).find(k => st.lists[k].id === card.idList) || ''; }
function comments(card){ return (card.badges && card.badges.comments) || 0; }
function isUnread(card){ return comments(card) > (st.seen[card.id] || 0); }
function stamp(card){ return `${card.dateLastActivity}|${comments(card)}|${card.idList}`; }
function findCard(id){ return st.cards.find(c => c.id === id) || null; }
/* O texto que vai para o chat: o código na primeira linha é o que faz a resposta voltar para esta nota. */
function copyText(card, text){ const c = parseName(card.name).code; return (c ? `[${c}]\n` : '') + text; }
function fmtWhen(iso){
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).replace(',', '');
}

/* Comentários são a resposta. Resposta longa chega em partes que começam com [parte 1/3].
   Marcadores de controle ([exec], [pergunta]) não são resposta. */
function parseThread(actions){
  const items = (actions || [])
    .map(a => ({date: a.date, text: (a.data && a.data.text) || ''}))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const results = [];
  let cur = null;
  items.forEach(it => {
    if (/^\s*\[(exec|pergunta)\]/i.test(it.text)) return;
    const m = /^\s*\[parte\s+(\d+)\s*\/\s*(\d+)\]\s*\r?\n?/i.exec(it.text);
    if (!m){ results.push({date: it.date, text: it.text, total: 1, got: 1}); cur = null; return; }
    const part = Number(m[1]), total = Number(m[2]), body = it.text.slice(m[0].length);
    if (!cur || cur.total !== total || cur.parts[part]){
      cur = {date: it.date, total, parts: {}};
      results.push(cur);
    }
    cur.parts[part] = body;
    cur.date = it.date;
    cur.got = Object.keys(cur.parts).length;
    cur.text = Object.keys(cur.parts).map(Number).sort((a, b) => a - b).map(n => cur.parts[n]).join('\n');
  });
  return results.reverse();
}

/* ---------- Markdown: o texto é escapado antes de virar HTML ---------- */
function inline(src){
  return src.split(/(`[^`\n]+`)/g).map(p => {
    if (/^`[^`\n]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`;
    /* A marca do link só vira HTML no fim, para o endereço não ser reprocessado dentro do atributo. */
    const tags = [];
    const open = url => { tags.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">`); return `\u0000${tags.length - 1}\u0000`; };
    let t = esc(p).replace(/\u0000/g, '');
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) => `${open(url)}${txt}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]+[^\s<.,;:!?)\u0000])/g, (m, pre, url) => `${pre}${open(url)}${url}</a>`);
    t = t.replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
    return t.replace(/\u0000(\d+)\u0000/g, (m, i) => tags[Number(i)]);
  }).join('');
}
function splitRow(line){
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', code = false;
  for (let i = 0; i < s.length; i++){
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|'){ cur += '|'; i++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code){ cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
const RE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
function isTable(lines, i){ return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && RE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|'); }
function isBlockStart(lines, i){
  const l = lines[i];
  return /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || RE_ITEM.test(l) || RE_HR.test(l) || isTable(lines, i);
}
function parseList(lines, start){
  const first = RE_ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length){
    const m = RE_ITEM.exec(lines[i]);
    if (m && m[1].length < base) break;
    if (m && m[1].length === base){
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({text: [m[3]], sub: ''});
      i++;
      continue;
    }
    if (m && m[1].length > base){
      const r = parseList(lines, i);
      if (items.length) items[items.length - 1].sub += r.html;
      i = r.next;
      continue;
    }
    if (lines[i].trim() === ''){
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      const nx = j < lines.length ? RE_ITEM.exec(lines[j]) : null;
      if (nx && nx[1].length >= base){ i = j; continue; }
      break;
    }
    if (/^\s+\S/.test(lines[i]) && items.length){ items[items.length - 1].text.push(lines[i].trim()); i++; continue; }
    break;
  }
  const lis = items.map(it => `<li>${it.text.map(inline).join('<br>')}${it.sub}</li>`).join('');
  const tag = ordered ? 'ol' : 'ul';
  return {html: `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>${lis}</${tag}>`, next: i};
}
function renderMd(md){
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length){
    const l = lines[i];
    if (l.trim() === ''){ i++; continue; }
    if (/^\s*```/.test(l)){
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h){ const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (RE_HR.test(l)){ out.push('<hr>'); i++; continue; }
    if (isTable(lines, i)){
      const head = splitRow(l);
      const aligns = splitRow(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'c' : /-:$/.test(c) ? 'd' : '');
      const cls = k => aligns[k] ? ` class="al-${aligns[k]}"` : '';
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      /* A tabela usa o maior número de colunas entre as linhas, para nenhuma célula sumir. */
      const cols = Array.from({length: Math.max(head.length, ...rows.map(r => r.length))}, (_, k) => k);
      const body = rows.map(r => `<tr>${cols.map(k => `<td${cls(k)}>${inline(r[k] || '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="tbl"><table><thead><tr>${cols.map(k => `<th${cls(k)}>${inline(head[k] || '')}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)){
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMd(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (RE_ITEM.test(l)){ const r = parseList(lines, i); out.push(r.html); i = r.next; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && (!buf.length || !isBlockStart(lines, i))) buf.push(lines[i++].trim());
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/* HTML para colar no Word/Outlook: os estilos precisam ir no próprio elemento. */
function exportHtml(md){
  const TH = 'border:1px solid #999;padding:4px 7px;background:#e6f1e4;text-align:left;vertical-align:top';
  const TD = 'border:1px solid #999;padding:4px 7px;vertical-align:top';
  const align = c => c === 'al-c' ? ';text-align:center' : c === 'al-d' ? ';text-align:right' : '';
  const html = renderMd(md)
    .replace(/<div class="tbl">|<\/div>/g, '')
    .replace(/<table>/g, '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;border:1px solid #999">')
    .replace(/<th(?: class="(al-[cd])")?>/g, (m, c) => `<th style="${TH}${align(c)}">`)
    .replace(/<td(?: class="(al-[cd])")?>/g, (m, c) => `<td style="${TD}${align(c)}">`)
    .replace(/<blockquote>/g, '<blockquote style="border-left:3px solid #999;margin:6px 0;padding-left:10px">')
    .replace(/<pre>/g, '<pre style="background:#f3f2f1;padding:6px 8px;white-space:pre-wrap">');
  return `<div style="font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:11pt;line-height:1.35">${html}</div>`;
}
async function copyPlain(text){
  try { await navigator.clipboard.writeText(text); return true; } catch(e){}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.className = 'clip';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch(e){}
  ta.remove();
  return ok;
}
async function copyRich(md, el){
  const text = el.innerText;
  try {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('sem API');
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([exportHtml(md)], {type: 'text/html'}),
      'text/plain': new Blob([text], {type: 'text/plain'})
    })]);
    return true;
  } catch(e){}
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    const ok = document.execCommand('copy');
    s.removeAllRanges();
    return ok;
  } catch(e){ return false; }
}

/* ---------- avisos ---------- */
let toastT;
function toast(msg, err){
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2600);
}
function setSync(cls, txt){
  $('#sync').className = `sync ${cls}`;
  $('#syncTxt').textContent = txt;
}

/* ---------- tela ---------- */
function matches(c){
  if (!st.q) return true;
  const q = st.q.toLowerCase();
  const d = st.det[c.id];
  return c.name.toLowerCase().includes(q) || (d && d.desc.toLowerCase().includes(q));
}
function itemHtml(c){
  const p = parseName(c.name);
  return `<button type="button" class="item${c.id === st.sel && st.mode !== 'new' ? ' on' : ''}" data-act="open" data-id="${esc(c.id)}">
    <span class="item-top"><b class="code num">${esc(p.code || 'N---')}</b>${isUnread(c) ? '<span class="dot">resposta</span>' : comments(c) ? '<span class="tag ok">respondida</span>' : ''}<span class="when num">${esc(fmtWhen(c.dateLastActivity))}</span></span>
    <span class="item-title">${esc(p.title)}</span></button>`;
}
function renderList(){
  const open = st.cards.filter(matches);
  const todo = open.filter(c => listKey(c) === 'todo').sort((a, b) => a.pos - b.pos);
  const sent = open.filter(c => listKey(c) === 'sent').sort((a, b) => String(b.dateLastActivity).localeCompare(String(a.dateLastActivity)));
  const more = sent.length > SENT_MAX ? `<p class="fine pad">Mostrando as ${SENT_MAX} mais recentes de ${sent.length}. Use a busca para achar as outras.</p>` : '';
  $('#side').innerHTML = `<h2 class="group">Para copiar <span class="count num">${todo.length}</span></h2>${todo.length ? todo.map(itemHtml).join('') : '<p class="fine pad">Nenhuma nota na fila.</p>'}
    <h2 class="group">Copiadas <span class="count num">${sent.length}</span></h2>${sent.length ? sent.slice(0, st.q ? sent.length : SENT_MAX).map(itemHtml).join('') + (st.q ? '' : more) : '<p class="fine pad">Nenhuma nota copiada ainda.</p>'}`;
  const n = st.cards.filter(isUnread).length;
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}
function renderFatal(title, text){
  $('#side').innerHTML = '';
  $('#layout').classList.add('open');
  $('#pane').dataset.card = '';
  $('#pane').innerHTML = `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn primary" href="../">Abrir a Carteira</a></div>`;
}
const HOW = `<p class="how"><b>Como usar:</b> escreva a nota e salve. No app do Claude, abra o artefato <b>Carteira Hidráulica</b>, aba <b>Bloco de notas</b>, toque em <b>Copiar</b> e cole no chat. A resposta do Claude volta para esta nota.</p>`;
function renderComposer(card){
  const editing = !!card;
  const d = editing ? st.det[card.id] : null;
  const text = editing ? (d ? d.desc : '') : load(DRAFT_KEY, '') || '';
  $('#layout').classList.add('open');
  $('#pane').dataset.card = '';
  $('#pane').innerHTML = `<div class="card composer">
    <button type="button" class="btn ghost back" data-act="list">‹ Notas</button>
    <h2>${editing ? `Editar ${esc(parseName(card.name).code)}` : 'Nova nota'}</h2>
    ${st.notice ? `<div class="msg ok">${esc(st.notice)}</div>` : ''}
    <label class="fld"><span>Nota <span class="fine">o texto que você vai colar no chat do Claude</span></span>
      <textarea class="inp" id="nText" rows="16" spellcheck="true">${esc(text)}</textarea></label>
    <div class="row"><span class="fine num" id="nCount"></span><span class="spacer"></span>
      ${editing ? '<button type="button" class="btn ghost" data-act="cancel">Cancelar</button>' : ''}
      <button type="button" class="btn primary" data-act="${editing ? 'save-edit' : 'save-new'}" title="Ctrl+Enter">Salvar nota</button></div>
    ${editing ? '' : HOW}
  </div>`;
  count();
  $('#nText').focus();
}
function count(){
  const el = $('#nCount'), ta = $('#nText');
  if (!el || !ta) return;
  const n = ta.value.length;
  el.textContent = `${n.toLocaleString('pt-BR')} de ${LIMIT.toLocaleString('pt-BR')} caracteres`;
  el.classList.toggle('over', n > LIMIT);
}
function resultHtml(r, i){
  const incomplete = r.got < r.total;
  const off = incomplete ? ' disabled title="Resposta incompleta"' : '';
  const tools = `<div class="row tools">
    <button type="button" class="btn primary" data-act="copy-rich" data-i="${i}"${off}>Copiar formatado</button>
    <button type="button" class="btn" data-act="copy-text" data-i="${i}"${off}>Copiar texto</button></div>`;
  const late = incomplete && Date.now() - new Date(r.date).getTime() > STALL_MS;
  const warn = !incomplete ? '' : late
    ? `<div class="msg warn">Resposta incompleta: chegaram ${r.got} de ${r.total} partes e nada novo há mais de ${STALL_MS / 60000} minutos. Peça ao Claude, no mesmo chat, para gravar de novo.</div>`
    : `<div class="msg warn">Recebendo a resposta: ${r.got} de ${r.total} partes. O restante aparece aqui quando for gravado.</div>`;
  const body = `<div class="md" data-md="${i}">${renderMd(r.text)}</div>`;
  if (i === 0) return `<section class="block"><div class="block-h"><h3>Resposta do Claude</h3><span class="fine num">${esc(fmtWhen(r.date))}</span></div>${warn}${tools}${body}</section>`;
  return `<details class="block"><summary>Resposta anterior · <span class="num">${esc(fmtWhen(r.date))}</span></summary>${warn}${tools}${body}</details>`;
}
function renderDetail(){
  if (st.mode !== 'view') return;
  const pane = $('#pane');
  const card = st.sel ? findCard(st.sel) : null;
  if (!card){ startNew(); return; }
  $('#layout').classList.add('open');
  const p = parseName(card.name), key = listKey(card), d = st.det[card.id];
  const same = pane.dataset.card === card.id && pane.dataset.loaded === '1';
  const scroll = same ? pane.scrollTop : 0;
  const openOld = same ? [...pane.querySelectorAll('details')].map(x => x.open) : [];
  const answered = d ? d.results.length > 0 : comments(card) > 0;
  const pill = answered ? '<span class="pill respondida">Respondida</span>' : `<span class="pill ${key === 'todo' ? 'novo' : 'copiada'}">${STATE[key]}</span>`;
  const moves = `${key === 'todo' ? '<button type="button" class="btn" data-act="edit">Editar</button>' : '<button type="button" class="btn" data-act="requeue" title="Volta para a fila do app do Claude">Voltar para a fila</button>'}
    <button type="button" class="btn" data-act="copy-note">Copiar nota</button>
    <button type="button" class="btn" data-act="archive">Arquivar</button>`;
  const hint = d && !d.results.length
    ? (key === 'todo'
      ? '<div class="wait"><span><b>Na fila do app do Claude.</b> Abra o artefato Carteira Hidráulica, aba Bloco de notas, toque em Copiar e cole no chat.</span></div>'
      : '<div class="wait"><span><b>Copiada no app do Claude.</b> A resposta aparece aqui quando o Claude gravar.</span></div>')
    : '';
  const content = d
    ? `${hint}${d.results.map(resultHtml).join('')}<details class="block" ${d.results.length ? '' : 'open'}><summary>Nota</summary><pre class="prompt">${esc(d.desc)}</pre></details>`
    : '<p class="fine">Carregando…</p>';
  pane.innerHTML = `<div class="card">
    <button type="button" class="btn ghost back" data-act="list">‹ Notas</button>
    ${st.notice ? `<div class="msg ok">${esc(st.notice)}</div>` : ''}
    <div class="head">
      <div class="head-t"><span class="code big num">${esc(p.code)}</span>${pill}<h2>${esc(p.title)}</h2></div>
      <div class="row">${moves}</div>
      ${st.confirm ? '<div class="confirm">Arquivar esta nota? Ela sai da lista (dá para restaurar no Trello).<button type="button" class="btn" data-act="archive-yes">Arquivar</button><button type="button" class="btn ghost" data-act="archive-no">Cancelar</button></div>' : ''}
    </div>
    ${content}
  </div>`;
  pane.dataset.card = card.id;
  pane.dataset.loaded = d ? '1' : '';
  [...pane.querySelectorAll('details')].forEach((x, i) => { if (openOld[i] !== undefined) x.open = openOld[i]; });
  pane.scrollTop = scroll;
}

/* ---------- dados ---------- */
let running = null;
async function refresh(force){
  if (!st.conn) return;
  if (running){
    if (!force) return;
    await running;
  }
  running = readBoard();
  await running;
  running = null;
}
async function readBoard(){
  setSync('busy', 'Atualizando…');
  try {
    const b = await api('GET', `/boards/${BOARD}`, {fields: 'name', lists: 'open', list_fields: 'name', cards: 'open', card_fields: CARD_FIELDS});
    const lists = {};
    Object.entries(LIST_NAMES).forEach(([k, n]) => { const l = (b.lists || []).find(x => x.name === n); if (l) lists[k] = l; });
    const missing = Object.keys(LIST_NAMES).find(k => !lists[k]);
    if (missing) throw Object.assign(new Error(`lista "${LIST_NAMES[missing]}" não encontrada no quadro Prompts`), {status: 'list'});
    const ids = new Set(Object.values(lists).map(l => l.id));
    st.lists = lists;
    st.cards = (b.cards || []).filter(c => !c.closed && ids.has(c.idList));
    st.lastOk = Date.now();
    setSync('', `Atualizado às ${new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}`);
    renderList();
    await syncDetail();
  } catch(e){
    setSync('err', `Falhou: ${e.message}`);
    if (e.status === 401 || e.status === 404) renderFatal('Conexão com o Trello recusada', 'Abra a Carteira, confira a conexão neste navegador e volte para esta aba.');
    else if (!st.lastOk) renderFatal('Não consegui ler o Bloco de notas', `${e.message}. A página tenta de novo a cada 30 segundos.`);
  }
}
async function loadDetail(card){
  const [c, acts] = await Promise.all([
    api('GET', `/cards/${card.id}`, {fields: 'desc'}),
    comments(card) ? api('GET', `/cards/${card.id}/actions`, {filter: 'commentCard', limit: '1000'}) : Promise.resolve([])
  ]);
  st.det[card.id] = {stamp: stamp(card), desc: c.desc || '', results: parseThread(acts)};
}
function markSeen(card){
  if ((st.seen[card.id] || 0) === comments(card)) return;
  st.seen[card.id] = comments(card);
  save(SEEN_KEY, st.seen);
}
async function syncDetail(){
  if (st.mode !== 'view' || !st.sel) return;
  const card = findCard(st.sel);
  if (!card){ st.sel = null; startNew(); return; }
  const d = st.det[card.id];
  if (d && d.stamp === stamp(card)) return;
  await loadDetail(card);
  if (st.sel !== card.id || st.mode !== 'view') return;
  if (document.visibilityState === 'visible') markSeen(card);
  renderDetail();
  renderList();
}
async function openCard(id, notice){
  st.sel = id;
  st.mode = 'view';
  st.confirm = false;
  st.notice = notice || null;
  const card = findCard(id);
  if (!card) return;
  const code = parseName(card.name).code;
  if (code && location.hash !== `#${code}`) history.replaceState(null, '', `#${code}`);
  renderList();
  renderDetail();
  try {
    await loadDetail(card);
    if (st.sel !== id || st.mode !== 'view') return;
    markSeen(card);
    renderList();
    renderDetail();
  } catch(e){ toast(`Não abriu: ${e.message}`, true); }
}
async function run(fn){
  if (st.saving) return;
  st.saving = true;
  try { return await fn(); }
  catch(e){ toast(`Não gravou: ${e.message}`, true); }
  finally { st.saving = false; }
}
function formText(){
  const text = $('#nText').value.trim();
  if (!text){ toast('Escreva a nota antes de salvar.', true); return null; }
  if (text.length > LIMIT){ toast(`A nota passa do limite de ${LIMIT.toLocaleString('pt-BR')} caracteres.`, true); return null; }
  return text;
}
async function saveNew(){
  const text = formText();
  if (!text) return;
  await run(async () => {
    const all = await api('GET', `/boards/${BOARD}/cards/all`, {fields: 'name'});
    const code = nextCode(all);
    await api('POST', '/cards', {idList: st.lists.todo.id, name: `${code} - ${titleOf(text)}`, desc: text, pos: 'top'});
    drop(DRAFT_KEY);
    st.notice = `${code} salva. Ela aparece no app do Claude em até 20 segundos.`;
    await refresh(true);
    startNew(true);
  });
}
async function saveEdit(card){
  const text = formText();
  if (!text) return;
  await run(async () => {
    const code = parseName(card.name).code;
    await api('PUT', `/cards/${card.id}`, {name: code ? `${code} - ${titleOf(text)}` : titleOf(text), desc: text});
    delete st.det[card.id];
    await refresh(true);
    await openCard(card.id, 'Nota atualizada.');
  });
}
async function moveTo(card, key, msg){
  await run(async () => {
    await api('PUT', `/cards/${card.id}`, {idList: st.lists[key].id, pos: 'top'});
    await refresh(true);
    renderDetail();
    toast(msg);
  });
}
async function archive(card){
  await run(async () => {
    await api('PUT', `/cards/${card.id}`, {closed: 'true'});
    st.sel = null;
    st.confirm = false;
    history.replaceState(null, '', location.pathname + location.search);
    await refresh(true);
    startNew();
    toast('Nota arquivada.');
  });
}

/* ---------- eventos ---------- */
function startNew(keepNotice){
  st.mode = 'new';
  st.sel = null;
  st.confirm = false;
  if (!keepNotice) st.notice = null;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  renderList();
  renderComposer(null);
}
function resultAt(el){
  const card = findCard(st.sel), d = card && st.det[card.id];
  const i = Number(el.dataset.i);
  return d ? {res: d.results[i], node: $(`.md[data-md="${i}"]`, $('#pane'))} : null;
}
const actions = {
  'new': () => startNew(),
  refresh: () => refresh(),
  theme(){
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('ch.dash.theme', root.dataset.theme); } catch(e){}
  },
  open: el => openCard(el.dataset.id),
  list(){ st.mode = 'new'; st.sel = null; st.notice = null; $('#layout').classList.remove('open'); renderList(); renderComposer(null); $('#layout').classList.remove('open'); },
  cancel(){ if (st.sel) openCard(st.sel); else startNew(); },
  'save-new': saveNew,
  'save-edit'(){ const c = findCard(st.sel); if (c) saveEdit(c); },
  edit(){ const c = findCard(st.sel); if (c && st.det[c.id]){ st.mode = 'edit'; st.notice = null; renderComposer(c); } },
  requeue(){ const c = findCard(st.sel); if (c) moveTo(c, 'todo', 'Nota de volta na fila do app do Claude.'); },
  async 'copy-note'(){
    const c = findCard(st.sel), d = c && st.det[c.id];
    if (d) toast(await copyPlain(copyText(c, d.desc)) ? 'Nota copiada com o código.' : 'Não consegui copiar.');
  },
  async 'copy-rich'(el){
    const r = resultAt(el);
    if (r && r.res) toast(await copyRich(r.res.text, r.node) ? 'Copiado com formatação.' : 'Não consegui copiar. Use Copiar texto.');
  },
  async 'copy-text'(el){
    const r = resultAt(el);
    if (r && r.node) toast(await copyPlain(r.node.innerText) ? 'Texto copiado.' : 'Não consegui copiar.');
  },
  archive(){ st.confirm = true; renderDetail(); },
  'archive-no'(){ st.confirm = false; renderDetail(); },
  'archive-yes'(){ const c = findCard(st.sel); if (c) archive(c); }
};
document.addEventListener('click', e => {
  const view = e.target.closest('a.tab[data-view]');
  if (view){ const ui = load(UI_KEY, {}); ui.view = view.dataset.view; save(UI_KEY, ui); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});
document.addEventListener('input', e => {
  if (e.target.id !== 'nText') return;
  count();
  if (st.mode === 'new') save(DRAFT_KEY, e.target.value);
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && $('#nText')){
    e.preventDefault();
    (st.mode === 'edit' ? actions['save-edit'] : saveNew)();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'n'){ e.preventDefault(); startNew(); }
  else if (k === 'r'){ e.preventDefault(); refresh(); }
  else if (k === '/'){ e.preventDefault(); $('#q').focus(); }
});
let qt;
$('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); renderList(); }, 120); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const card = st.mode === 'view' && st.sel ? findCard(st.sel) : null;
  if (card && st.det[card.id]){ markSeen(card); renderList(); }
  if (Date.now() - st.lastOk > 10000) refresh();
});

/* ---------- início ---------- */
async function boot(){
  if (!st.conn || !st.conn.key || !st.conn.token){
    setSync('off', 'Sem conexão neste navegador');
    renderFatal('Conecte a Carteira primeiro', 'O Bloco de notas usa a mesma conexão com o Trello. Abra a Carteira, conecte uma vez neste navegador e volte aqui.');
    return;
  }
  renderComposer(null);
  await refresh();
  const m = /^#(N\d{3,})$/.exec(location.hash);
  const c = m && st.cards.find(x => parseName(x.name).code === m[1]);
  if (c) await openCard(c.id);
  let lastTry = Date.now();
  setInterval(() => {
    const wait = document.visibilityState !== 'visible' ? POLL_HIDDEN_MS : POLL_MS;
    if (Date.now() - lastTry < wait) return;
    lastTry = Date.now();
    refresh();
  }, 2000);
}
boot();
})();
