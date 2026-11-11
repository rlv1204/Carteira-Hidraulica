(() => {
'use strict';

/* Página Prompts: escreve o prompt em um cartão do Trello e mostra o resultado.
   Descrição do cartão = prompt. Comentários = resultado.
   Usa a mesma conexão (chave e token) que a Carteira guarda neste navegador. */

const API = 'https://api.trello.com/1';
const BOARD = 'tZN5E4ad';
const CONN_KEY = 'ch.dash.trello';
const UI_KEY = 'ch.dash.ui';
const SEEN_KEY = 'ch.prompts.seen';
const DRAFT_KEY = 'ch.prompts.draft';
const TASK_KEY = 'ch.prompts.task';
const CARTEIRA = '7dtAJCuF';
const LIST_NAMES = {todo: 'A rodar', run: 'Rodando', done: 'Pronto', err: 'Erro', arch: 'Arquivo'};
const POLL_MS = 30000;
const POLL_RUN_MS = 10000;
const POLL_HIDDEN_MS = 120000;
const STALL_MS = 10 * 60000;
const START_MS = 5 * 60000;   // sem sinal da sessão depois disso, avisa que o disparo pode ter falhado
const RUN_MS = 30 * 60000;    // sem nada novo depois disso, avisa que a sessão pode ter parado
const LIMIT = 16384;
const CARD_FIELDS = 'name,idList,closed,dateLastActivity,badges,pos';
/* Modelos do Novo prompt: só os campos a preencher. O formato de cada entrega vem das preferências e skills. */
const MODELS = [
  {id: 'gm', label: 'GM', title: 'GM', text: `Elaborar GM no modelo validado.

Equipamento:
TAG:
Referência (nº SAP):
Situação atual:
Evidência ou condição constatada:
O que será feito:
Arquivos de apoio (repositório ou Drive):`},
  {id: 'pqs', label: 'PQS (Anexo I)', title: 'PQS', text: `Elaborar PQS, Anexo I, de licitação de serviço.

Plataforma:
Equipamento e TAG:
Escopo do serviço:
Limites de bateria:
Prazo:
Anexo I modelo:
Diagramas e catálogos (repositório ou Drive):`},
  {id: 'sap', label: 'Nota SAP', title: 'Nota SAP', text: `Elaborar nota SAP, com título de até 40 caracteres e texto breve.

Equipamento e TAG:
Problema ou serviço:
Causa ou contexto:
Ação solicitada:`},
  {id: 'patec', label: 'PATEC', title: 'PATEC', text: `Elaborar o e-mail resumido de parecer técnico (PATEC).

Destinatário:
Item (PN, descrição ou RC):
Fornecedores:
Propostas e catálogos (repositório ou Drive):`},
  {id: 'comp', label: 'Pesquisa de componente', title: 'Pesquisa de componente', text: `Pesquisar componente hidráulico no formato padrão.

Componente e fabricante:
Código atual:
Dados da plaqueta ou do diagrama:
Objetivo (identificar, especificar, comparar ou achar equivalente):
Conexões e interfaces:
Arquivos de apoio (repositório ou Drive):`}
];

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
  sel: null, mode: 'view', notice: null,
  q: '', showArch: false, lastOk: 0, saving: false, failed: null, askDraft: {}, stall: '', reg: null, tasks: null,
  seen: load(SEEN_KEY, {})
};

/* ---------- Trello ---------- */
/* Chave e token vão sempre no cabeçalho Authorization, nunca no endereço. */
const auth = 'header';
const AUTH_NOTE = {header: 'Conexão: token protegido no cabeçalho'};
function send(method, path, params){
  const qs = new URLSearchParams();
  const opts = {method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: {Authorization: `OAuth oauth_consumer_key="${st.conn.key}", oauth_token="${st.conn.token}"`}};
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => qs.set(k, v));
  else opts.body = new URLSearchParams(params);
  const q = qs.toString();
  return fetch(`${API}${path}${q ? `?${q}` : ''}`, opts);
}
async function request(method, path, params){
  try { return await send(method, path, params); }
  catch(e){ throw new Error('sem conexão com api.trello.com'); }
}
async function api(method, path, params = {}){
  const r = await request(method, path, params);
  if (!r.ok){
    const e = new Error(r.status === 401 ? 'token recusado pelo Trello' : r.status === 429 ? 'limite de requisições do Trello' : `erro ${r.status} do Trello`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

function parseName(name){
  const m = /^(P\d{3,})\s*(?:[-–—:]\s*)?(.*)$/.exec(name || '');
  return m ? {code: m[1], title: m[2] || m[1]} : {code: '', title: name || 'Sem título'};
}
function nextCode(cards){
  let max = 0;
  cards.forEach(c => { const m = /^P(\d{3,})/.exec(c.name || ''); if (m) max = Math.max(max, Number(m[1])); });
  return 'P' + String(max + 1).padStart(3, '0');
}
function command(card){ const c = parseName(card.name).code; return c ? `roda o ${c}` : `roda o cartão "${card.name}"`; }
/* O comando "roda" pega o primeiro cartão de A rodar, na ordem do Trello. */
function nextInQueue(){ return st.cards.filter(c => !c.closed && listKey(c) === 'todo').sort((a, b) => a.pos - b.pos)[0] || null; }
function runHint(card){
  const next = nextInQueue(), cmd = esc(command(card));
  return next && next.id !== card.id
    ? `Este prompt não é o próximo da fila. No celular, mande: <code>${cmd}</code>`
    : `No iPhone, toque em <b>Rodar prompt</b> e envie. Ou mande: <code>${cmd}</code>`;
}
function listKey(card){ return Object.keys(st.lists).find(k => st.lists[k].id === card.idList) || 'todo'; }
function comments(card){ return (card.badges && card.badges.comments) || 0; }
function isUnread(card){ return listKey(card) !== 'run' && comments(card) > (st.seen[card.id] || 0); }
function stalled(r){ return r.got < r.total && Date.now() - new Date(r.date).getTime() > STALL_MS; }
/* Rodando: a sessão grava [exec] inicio ao começar. Sem sinal, o disparo pode ter falhado; sem novidade, a sessão pode ter parado. */
function runState(card, d){
  if (listKey(card) !== 'run' || !d) return '';
  const age = Date.now() - new Date(card.dateLastActivity).getTime();
  const signals = [...d.execs, ...d.results].map(x => new Date(x.date).getTime());
  const started = signals.length && new Date(card.dateLastActivity).getTime() - Math.max(...signals) < 10000;
  if (!started) return age > START_MS ? 'nostart' : '';
  return age > RUN_MS ? 'late' : '';
}
function execError(d){
  const m = /^\s*\[exec\]\s*erro\s*:?\s*(.*)$/is.exec((d.execs[d.execs.length - 1] || {}).text || '');
  return m ? m[1].trim() : '';
}
function stamp(card){ return `${card.dateLastActivity}|${comments(card)}|${card.idList}`; }
function findCard(id){ return st.cards.find(c => c.id === id && !c.closed) || null; }
function fmtWhen(iso){
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).replace(',', '');
}

/* Comentário que começa com [pergunta] é do Roney. O que começa com [exec] é sinal da rodada automática.
   Os demais são resultado. Resultado longo chega em comentários que começam com [parte 1/3]. */
function parseThread(actions){
  const items = (actions || [])
    .map(a => ({id: a.id, date: a.date, text: (a.data && a.data.text) || ''}))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const results = [], execs = [];
  let cur = null, open = [];
  const add = r => { r.asks = open; open = []; results.push(r); };
  items.forEach(it => {
    if (/^\s*\[exec\]/i.test(it.text)){ execs.push(it); return; }
    const q = /^\s*\[pergunta\]\s*\r?\n?/i.exec(it.text);
    if (q){ open.push({id: it.id, date: it.date, text: it.text.slice(q[0].length).trim()}); return; }
    const m = /^\s*\[parte\s+(\d+)\s*\/\s*(\d+)\]\s*\r?\n?/i.exec(it.text);
    if (!m){ add({date: it.date, text: it.text, total: 1, got: 1}); cur = null; return; }
    const part = Number(m[1]), total = Number(m[2]), body = it.text.slice(m[0].length);
    if (!cur || cur.total !== total || cur.parts[part]){
      cur = {date: it.date, total, parts: {}};
      add(cur);
    }
    cur.parts[part] = body;
    cur.date = it.date;
    cur.got = Object.keys(cur.parts).length;
    cur.text = Object.keys(cur.parts).map(Number).sort((a, b) => a - b).map(n => cur.parts[n]).join('\n');
  });
  return {results: results.reverse(), pending: open, execs};
}

/* ---------- histórico da Carteira: mesmo formato que a página da Carteira grava ---------- */
const FIELD_RE = /^\*\*\s*(Aguardando|Refs|Prioridade|Criada em)\s*:\s*\*\*\s*(.*)$/i;
const HIST_RE = /^\*\*\s*Hist[oó]rico\s*\*\*\s*$/i;
const FKEY = {aguardando: 'waiting', refs: 'refs', prioridade: 'priority', 'criada em': 'created'};
function splitDesc(desc){
  const lines = String(desc || '').split(/\r?\n/);
  const h = lines.findIndex(l => HIST_RE.test(l.trim()));
  const head = h >= 0 ? lines.slice(0, h) : lines;
  const f = {waiting: '', refs: '', priority: '', created: ''}, extra = [];
  head.forEach(raw => { const m = FIELD_RE.exec(raw.trim()); if (m) f[FKEY[m[1].toLowerCase()]] = m[2].trim(); else if (raw.trim()) extra.push(raw.trimEnd()); });
  return {f, extra, hist: h >= 0 ? lines.slice(h + 1) : []};
}
function joinDesc(s){
  const out = [];
  if (s.f.waiting) out.push(`**Aguardando:** ${s.f.waiting}`);
  if (s.f.refs) out.push(`**Refs:** ${s.f.refs}`);
  if (s.f.priority && s.f.priority !== 'Média') out.push(`**Prioridade:** ${s.f.priority}`);
  if (s.f.created) out.push(`**Criada em:** ${s.f.created}`);
  out.push(...s.extra);
  const hist = s.hist.slice();
  while (hist.length && !hist[0].trim()) hist.shift();
  while (hist.length && !hist[hist.length - 1].trim()) hist.pop();
  if (hist.length) out.push('', '**Histórico**', ...hist);
  return out.join('\n').trim();
}
function todayMark(){
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
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
function download(card, md){
  const p = parseName(card.name);
  const base = `${p.code || 'prompt'}-${p.title}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').slice(0, 60);
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${esc(card.name)}</title></head><body>${exportHtml(md)}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], {type: 'text/html;charset=utf-8'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
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
  $('#sync').title = AUTH_NOTE[auth] || '';
}

/* ---------- tela ---------- */
const GROUPS = [['run', 'Rodando'], ['todo', 'A rodar'], ['done', 'Pronto'], ['err', 'Erro']];
function matches(c){
  if (!st.q) return true;
  const q = st.q.toLowerCase();
  const d = st.det[c.id];
  return c.name.toLowerCase().includes(q) || (d && d.desc.toLowerCase().includes(q));
}
function itemHtml(c){
  const p = parseName(c.name);
  const unread = isUnread(c);
  return `<button type="button" class="item${c.id === st.sel && st.mode !== 'new' ? ' on' : ''}" data-act="open" data-id="${esc(c.id)}">
    <span class="item-top"><b class="code num">${esc(p.code || 'P---')}</b>${unread ? '<span class="dot">novo</span>' : ''}<span class="when num">${esc(fmtWhen(c.dateLastActivity))}</span></span>
    <span class="item-title">${esc(p.title)}</span></button>`;
}
function renderList(){
  const open = st.cards.filter(c => !c.closed && matches(c)).sort((a, b) => String(b.dateLastActivity).localeCompare(String(a.dateLastActivity)));
  const of = k => open.filter(c => listKey(c) === k);
  let html = GROUPS.map(([k, label]) => {
    const list = of(k);
    if (!list.length && (k === 'run' || k === 'err')) return '';
    return `<h2 class="group">${label} <span class="count num">${list.length}</span></h2>${list.length ? list.map(itemHtml).join('') : `<p class="fine pad">${k === 'todo' ? 'Nenhum prompt aguardando.' : 'Nenhum resultado ainda.'}</p>`}`;
  }).join('');
  const arch = of('arch');
  html += `<button type="button" class="group-btn" data-act="toggle-arch" aria-expanded="${st.showArch}">Arquivo <span class="count num">${arch.length}</span></button>`;
  if (st.showArch) html += arch.map(itemHtml).join('');
  $('#side').innerHTML = html;
  updateTitle();
}
function updateTitle(){
  const n = st.cards.filter(c => !c.closed && listKey(c) !== 'arch' && isUnread(c)).length;
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}
function renderEmpty(){
  $('#pane').dataset.card = '';
  $('#pane').innerHTML = `<div class="empty">
    <h2>Escreva o prompt aqui e escolha como rodar</h2>
    <ol>
      <li>Clique em <b>Novo prompt</b>, escreva e salve. Ele recebe um número, como P012.</li>
      <li>Abra o prompt e clique em <b>Rodar Claude</b>, que roda sem celular, ou em <b>Rodar IOS</b>, que espera o ícone <b>Rodar prompt</b> do iPhone.</li>
      <li>O resultado aparece aqui, com o botão para copiar para Word ou Outlook.</li>
    </ol>
    <button type="button" class="btn primary" data-act="new">Novo prompt</button>
  </div>`;
}
function renderFatal(title, text){
  $('#side').innerHTML = '';
  $('#layout').classList.remove('open');
  $('#pane').innerHTML = `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn primary" href="../">Abrir a Carteira</a></div>`;
}
function resultHtml(r, i, card){
  const incomplete = r.got < r.total;
  const body = `<div class="md" data-md="${i}">${renderMd(r.text)}</div>`;
  const off = incomplete ? ' disabled title="Resultado incompleto"' : '';
  const tools = `<div class="row tools">
    <button type="button" class="btn primary" data-act="copy-rich" data-i="${i}"${off}>Copiar formatado</button>
    <button type="button" class="btn" data-act="copy-text" data-i="${i}"${off}>Copiar texto</button>
    <button type="button" class="btn" data-act="download" data-i="${i}"${off}>Baixar .html</button>
    <button type="button" class="btn" data-act="reg-open" data-i="${i}"${off}>Registrar na carteira</button>
  </div>${st.reg && st.reg.card === card.id && st.reg.date === r.date ? regHtml() : ''}`;
  const warn = !incomplete ? '' : stalled(r)
    ? `<div class="msg warn">Resultado incompleto: chegaram ${r.got} de ${r.total} partes e nada novo há mais de ${STALL_MS / 60000} minutos. A sessão pode ter parado. Rode o prompt de novo: <code>${esc(command(card))}</code></div>`
    : `<div class="msg warn">Recebendo o resultado: ${r.got} de ${r.total} partes. O restante aparece aqui quando for gravado.</div>`;
  const asks = askHtml(r.asks);
  const label = r.asks.length ? 'Resposta' : 'Resultado';
  if (i === 0) return `<section class="block">${asks}<div class="block-h"><h3>${label}</h3><span class="fine num">${esc(fmtWhen(r.date))}</span></div>${warn}${tools}${body}</section>`;
  return `<details class="block old"><summary>${label} anterior · <span class="num">${esc(fmtWhen(r.date))}</span></summary>${asks}${warn}${tools}${body}</details>`;
}
function taskMatches(){
  const q = st.reg ? st.reg.q.trim().toLowerCase() : '';
  return (st.tasks || []).filter(t => !q || t.name.toLowerCase().includes(q));
}
function taskOptions(){
  return taskMatches().map(t => `<option value="${esc(t.id)}"${st.reg && t.id === st.reg.task ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
}
function regTarget(){
  const t = st.reg && (st.tasks || []).find(x => x.id === st.reg.task);
  return t ? `Vai gravar em: ${t.name}` : 'Escolha uma tarefa na lista.';
}
function regHtml(){
  const r = st.reg;
  if (!st.tasks) return '<div class="reg"><p class="fine">Carregando as tarefas da Carteira…</p></div>';
  return `<div class="reg">
    <label class="fld"><span>Tarefa da Carteira</span>
      <input class="inp" id="regQ" placeholder="Buscar tarefa…" autocomplete="off" value="${esc(r.q)}"></label>
    <select class="inp" id="regTask" size="6" aria-label="Tarefa da Carteira">${taskOptions()}</select>
    <label class="fld"><span>Linha do histórico <span class="fine num">entra como ${esc(todayMark())} - texto</span></span>
      <input class="inp" id="regText" maxlength="500" autocomplete="off" value="${esc(r.text)}"></label>
    <div class="row"><span class="fine" id="regPick">${esc(regTarget())}</span><span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="reg-close">Cancelar</button>
      <button type="button" class="btn primary" data-act="reg-save">Gravar na tarefa</button></div>
  </div>`;
}
function runButtons(){
  return `<span class="row run-opts">
    <button type="button" class="btn" data-act="run-ios" title="Deixa no topo de A rodar para rodar pelo iPhone">Rodar IOS</button>
    <button type="button" class="btn primary" data-act="run-claude" title="Roda na nuvem do Claude, sem celular">Rodar Claude</button></span>`;
}
function runBlock(card, d){
  const state = runState(card, d);
  if (!state) return `<div class="wait"><span><b>Rodando no Claude.</b> O resultado aparece aqui sozinho.</span></div>`;
  const text = state === 'nostart'
    ? 'A sessão não confirmou o início. Confira a regra do Trello e a cota do Claude, ou rode pelo iPhone.'
    : `Nada novo há mais de ${RUN_MS / 60000} minutos. A sessão pode ter parado.`;
  return `<div class="wait warned"><span><b>Sem resposta.</b> ${text}</span><button type="button" class="btn" data-act="run-back">Voltar para A rodar</button></div>`;
}
function askHtml(list){
  return list.map(a => `<div class="ask-q"><span class="fine num">Sua pergunta · ${esc(fmtWhen(a.date))}</span><pre class="prompt">${esc(a.text)}</pre></div>`).join('');
}
function askBox(card){
  return `<section class="block ask">
    <label class="fld"><span>Pergunta ou ajuste sobre este resultado <span class="fine">o Claude responde só a isto, sem refazer o prompt</span></span>
      <textarea class="inp ask-in" id="askText" rows="3">${esc(st.askDraft[card.id] || '')}</textarea></label>
    <div class="row"><span class="spacer"></span><button type="button" class="btn primary" data-act="ask">Salvar pergunta</button></div>
  </section>`;
}
function renderDetail(){
  const pane = $('#pane');
  if (st.mode === 'new' || st.mode === 'edit') return;
  const card = st.sel ? findCard(st.sel) : null;
  $('#layout').classList.toggle('open', !!card);
  if (!card){ renderEmpty(); return; }
  const p = parseName(card.name), key = listKey(card), d = st.det[card.id];
  const same = pane.dataset.card === card.id && pane.dataset.loaded === '1';
  const scroll = same ? pane.scrollTop : 0;
  const openOld = same ? [...pane.querySelectorAll('details')].map(x => x.open) : [];
  const act = document.activeElement;
  const typing = same && act && ['askText', 'regQ', 'regText'].includes(act.id) ? [act.id, act.selectionStart, act.selectionEnd] : null;
  const moves = key === 'arch'
    ? `<button type="button" class="btn" data-act="restore">Restaurar</button>`
    : key === 'run' ? ''
    : `${key === 'done' ? '<button type="button" class="btn" data-act="rerun">Rodar de novo</button>' : ''}<button type="button" class="btn" data-act="archive">Arquivar</button>`;
  let content = '<p class="fine">Carregando…</p>';
  if (d){
    const results = d.results, pending = d.pending, hint = runHint(card);
    const partial = results.length && results[0].got < results[0].total;
    const running = key === 'run' ? runBlock(card, d) : '';
    const failed = key === 'err'
      ? `<div class="wait warned"><span><b>A rodada não terminou.</b> ${esc(execError(d) || 'Sem motivo registrado.')}</span>${runButtons()}</div>`
      : '';
    const waiting = running || failed || (pending.length
      ? `<section class="block pending"><h3>Pergunta aguardando resposta</h3>${askHtml(pending)}
          <div class="row"><span class="fine">${hint}</span><span class="spacer"></span>${runButtons()}<button type="button" class="btn" data-act="cancel-run">Cancelar pergunta</button></div></section>`
      : key !== 'todo' || partial ? ''
      : results.length
        ? `<div class="wait"><span><b>Na fila para rodar de novo.</b> ${hint}</span><span class="row">${runButtons()}<button type="button" class="btn" data-act="cancel-run">Cancelar e voltar para Pronto</button></span></div>`
        : `<div class="wait"><span><b>Escolha como rodar.</b> ${hint}</span>${runButtons()}</div>`);
    const promptBlock = `<details class="block" ${results.length ? '' : 'open'}><summary>Prompt</summary><pre class="prompt">${esc(d.desc)}</pre>
      <div class="row tools"><button type="button" class="btn" data-act="copy-prompt">Copiar prompt</button>${key === 'run' ? '' : '<button type="button" class="btn" data-act="edit">Editar</button>'}</div></details>`;
    const list = results.map((r, i) => resultHtml(r, i, card));
    if (results.length && key !== 'arch' && key !== 'run') list.splice(1, 0, askBox(card));
    content = waiting + promptBlock + list.join('');
  }
  pane.innerHTML = `<div class="card">
    <button type="button" class="btn ghost back" data-act="back">‹ Voltar</button>
    ${st.notice ? `<div class="msg ok">${esc(st.notice)}</div>` : ''}
    <div class="head">
      <div class="head-t"><span class="code big num">${esc(p.code)}</span><span class="pill ${key}">${esc(LIST_NAMES[key])}</span><h2>${esc(p.title)}</h2></div>
      <div class="row">${moves}</div>
    </div>
    ${content}
  </div>`;
  pane.dataset.card = card.id;
  pane.dataset.loaded = d ? '1' : '';
  [...pane.querySelectorAll('details')].forEach((x, i) => { if (openOld[i] !== undefined) x.open = openOld[i]; });
  pane.scrollTop = scroll;
  if (typing && $(`#${typing[0]}`)){ const t = $(`#${typing[0]}`); t.focus(); t.setSelectionRange(typing[1], typing[2]); }
}
function renderComposer(card){
  const editing = !!card;
  const d = editing ? st.det[card.id] : null;
  const draft = editing ? null : load(DRAFT_KEY, null);
  const title = editing ? parseName(card.name).title : (draft && draft.title) || '';
  const text = editing ? (d ? d.desc : '') : (draft && draft.text) || '';
  $('#layout').classList.add('open');
  $('#pane').dataset.card = '';
  $('#pane').innerHTML = `<div class="card composer">
    <button type="button" class="btn ghost back" data-act="cancel">‹ Voltar</button>
    <h2>${editing ? `Editar ${esc(parseName(card.name).code)}` : 'Novo prompt'}</h2>
    ${editing ? '' : `<label class="fld"><span>Modelo <span class="fine">opcional, coloca no prompt os campos para preencher</span></span>
      <select class="inp" id="pModel"><option value="">Sem modelo</option>${MODELS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select></label>`}
    <label class="fld"><span>Título <span class="fine">opcional, aparece na lista</span></span>
      <input class="inp" id="pTitle" maxlength="120" autocomplete="off" value="${esc(title)}"></label>
    <label class="fld"><span>Prompt <span class="fine">cite aqui os arquivos do repositório ou do Drive</span></span>
      <textarea class="inp" id="pText" rows="16" spellcheck="true">${esc(text)}</textarea></label>
    <div class="row"><span class="fine num" id="pCount"></span><span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="cancel">Cancelar</button>
      <button type="button" class="btn primary" data-act="${editing ? 'save-edit' : 'save-new'}">Salvar prompt</button></div>
  </div>`;
  count();
  $('#pText').focus();
}
function count(){
  const el = $('#pCount'), ta = $('#pText');
  if (!el || !ta) return;
  const n = ta.value.length;
  el.textContent = `${n.toLocaleString('pt-BR')} de ${LIMIT.toLocaleString('pt-BR')} caracteres`;
  el.classList.toggle('over', n > LIMIT);
}

/* ---------- dados ---------- */
/* Sem force, a atualização automática pula se já houver outra em curso.
   Com force, espera a que está em curso e lê de novo, para ver o que acabou de ser gravado. */
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
    const b = await api('GET', `/boards/${BOARD}`, {fields: 'name', lists: 'open', list_fields: 'name', cards: 'all', card_fields: CARD_FIELDS});
    const lists = {};
    Object.entries(LIST_NAMES).forEach(([k, n]) => { const l = (b.lists || []).find(x => x.name === n); if (l) lists[k] = l; });
    const missing = Object.keys(LIST_NAMES).find(k => !lists[k]);
    if (missing) throw Object.assign(new Error(`lista "${LIST_NAMES[missing]}" não encontrada no quadro Prompts`), {status: 'list'});
    st.lists = lists;
    /* O quadro também guarda as listas do Bloco de notas: aqui só entram os cartões das listas desta aba. */
    const own = new Set(Object.values(lists).map(l => l.id));
    st.cards = (b.cards || []).filter(c => own.has(c.idList));
    st.lastOk = Date.now();
    st.failed = null;
    setSync('', `Atualizado às ${new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}`);
    renderList();
    await syncDetail();
    checkStall();
  } catch(e){
    st.failed = e;
    setSync('err', `Falhou: ${e.message}`);
    if (e.status === 401 || e.status === 404) renderFatal('Conexão com o Trello recusada', 'Abra a Carteira, confira a conexão neste navegador e volte para esta aba.');
    else if (!st.lastOk) renderFatal('Não consegui ler o quadro Prompts', `${e.message}. A página tenta de novo a cada 30 segundos.`);
  }
}
/* Sem resposta nova o cartão não é redesenhado: isto troca o aviso quando a sessão para. */
function checkStall(){
  const card = st.mode === 'view' && st.sel ? findCard(st.sel) : null;
  const d = card && st.det[card.id], r = d && d.results[0];
  const flag = `${r && stalled(r) ? r.date : ''}|${d ? runState(card, d) : ''}`;
  const now = d && flag !== '|' ? `${card.id}|${flag}` : '';
  if (now === st.stall) return;
  st.stall = now;
  if (now) renderDetail();
}
async function loadDetail(card){
  const [c, acts] = await Promise.all([
    api('GET', `/cards/${card.id}`, {fields: 'desc'}),
    comments(card) ? api('GET', `/cards/${card.id}/actions`, {filter: 'commentCard', limit: '1000'}) : Promise.resolve([])
  ]);
  st.det[card.id] = Object.assign({stamp: stamp(card), desc: c.desc || ''}, parseThread(acts));
}
async function syncDetail(){
  if (st.mode !== 'view' || !st.sel) return;
  const card = findCard(st.sel);
  if (!card){ st.sel = null; renderDetail(); return; }
  const d = st.det[card.id];
  if (d && d.stamp === stamp(card)) return;
  await loadDetail(card);
  if (st.sel !== card.id || st.mode !== 'view') return;
  st.notice = null;
  if (document.visibilityState === 'visible') markSeen(card);
  renderDetail();
  renderList();
}
function markSeen(card){
  if ((st.seen[card.id] || 0) === comments(card)) return;
  st.seen[card.id] = comments(card);
  save(SEEN_KEY, st.seen);
}
async function openCard(id, notice){
  st.sel = id;
  st.reg = null;
  st.mode = 'view';
  st.notice = notice || null;
  const card = findCard(id);
  if (!card) return;
  const code = parseName(card.name).code;
  if (code && location.hash !== `#${code}`) history.replaceState(null, '', `#${code}`);
  renderList();
  renderDetail();
  try {
    await loadDetail(card);
    if (st.sel !== id) return;
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
function formValues(){
  const text = $('#pText').value.trim();
  const title = $('#pTitle').value.replace(/\s+/g, ' ').trim() || text.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 70);
  if (!text){ toast('Escreva o prompt antes de salvar.', true); return null; }
  if (text.length > LIMIT){ toast(`O prompt passa do limite de ${LIMIT.toLocaleString('pt-BR')} caracteres.`, true); return null; }
  return {text, title};
}
async function saveNew(){
  const v = formValues();
  if (!v) return;
  await run(async () => {
    const all = await api('GET', `/boards/${BOARD}/cards/all`, {fields: 'name'});
    const code = nextCode(all);
    const c = await api('POST', '/cards', {idList: st.lists.todo.id, name: `${code} - ${v.title}`, desc: v.text, pos: 'top'});
    drop(DRAFT_KEY);
    st.mode = 'view';
    await refresh(true);
    await openCard(c.id, `${code} salvo. Escolha Rodar Claude ou Rodar IOS.`);
  });
}
async function saveEdit(card){
  const v = formValues();
  if (!v) return;
  await run(async () => {
    const code = parseName(card.name).code;
    await api('PUT', `/cards/${card.id}`, {name: code ? `${code} - ${v.title}` : v.title, desc: v.text});
    delete st.det[card.id];
    st.mode = 'view';
    await refresh(true);
    await openCard(card.id, 'Prompt atualizado.');
  });
}
async function moveTo(card, key, msg){
  await run(async () => {
    await api('PUT', `/cards/${card.id}`, {idList: st.lists[key].id, pos: 'top'});
    st.notice = null;
    await refresh(true);
    toast(msg);
  });
}

/* Rodar Claude: só move o cartão para Rodando. A regra do Trello aciona a tarefa do Claude.
   Relê a lista antes de mover, porque cada entrada em Rodando abre uma sessão nova. */
async function runClaude(card){
  await run(async () => {
    const fresh = await api('GET', `/cards/${card.id}`, {fields: 'idList'});
    if (fresh.idList === st.lists.run.id){ await refresh(true); toast('Este prompt já está rodando.'); return; }
    await api('PUT', `/cards/${card.id}`, {idList: st.lists.run.id, pos: 'top'});
    st.notice = null;
    await refresh(true);
    toast('Enviado ao Claude. O resultado aparece aqui.');
  });
}

async function saveAsk(card){
  const box = $('#askText');
  const text = box ? box.value.trim() : '';
  if (!text){ toast('Escreva a pergunta antes de salvar.', true); return; }
  if (text.length + 11 > LIMIT){ toast(`A pergunta passa do limite de ${LIMIT.toLocaleString('pt-BR')} caracteres.`, true); return; }
  await run(async () => {
    await api('POST', `/cards/${card.id}/actions/comments`, {text: `[pergunta]\n${text}`});
    await api('PUT', `/cards/${card.id}`, {idList: st.lists.todo.id, pos: 'top'});
    delete st.askDraft[card.id];
    delete st.det[card.id];
    await refresh(true);
    await openCard(card.id, 'Pergunta salva. Escolha Rodar Claude ou Rodar IOS.');
  });
}
async function cancelRun(card){
  await run(async () => {
    const pending = (st.det[card.id] && st.det[card.id].pending) || [];
    for (const q of pending) await api('DELETE', `/cards/${card.id}/actions/${q.id}/comments`);
    if (pending.length) st.askDraft[card.id] = pending.map(q => q.text).join('\n\n');
    await api('PUT', `/cards/${card.id}`, {idList: st.lists.done.id, pos: 'top'});
    delete st.det[card.id];
    await refresh(true);
    await openCard(card.id);
    toast('Cancelado. O cartão voltou para Pronto.');
  });
}

/* Registrar na carteira: grava uma linha no histórico da tarefa, sem mexer em etapa, data ou prioridade. */
async function openReg(el){
  const r = resultAt(el);
  if (!r || !r.res) return;
  if (st.reg && st.reg.date === r.res.date){ st.reg = null; renderDetail(); return; }
  st.reg = {card: r.card.id, date: r.res.date, q: '', task: '', text: parseName(r.card.name).title};
  st.tasks = null;
  renderDetail();
  try {
    const board = (st.conn && st.conn.board) || CARTEIRA;
    const list = await api('GET', `/boards/${encodeURIComponent(board)}/cards/open`, {fields: 'name,dateLastActivity'});
    st.tasks = list.sort((a, b) => String(b.dateLastActivity).localeCompare(String(a.dateLastActivity)));
    const saved = load(TASK_KEY, {})[r.card.id];
    if (st.reg && st.tasks.some(t => t.id === saved)) st.reg.task = saved;
  } catch(e){
    st.reg = null;
    toast(`Não abri as tarefas: ${e.message}`, true);
  }
  renderDetail();
  if ($('#regQ')) $('#regQ').focus();
}
async function saveReg(){
  const r = st.reg;
  if (!r) return;
  const text = r.text.replace(/\s+/g, ' ').trim();
  const task = (st.tasks || []).find(t => t.id === r.task);
  if (!task){ toast('Escolha a tarefa da Carteira.', true); return; }
  if (!text){ toast('Escreva a linha do histórico.', true); return; }
  await run(async () => {
    const fresh = await api('GET', `/cards/${task.id}`, {fields: 'desc'});
    const s = splitDesc(fresh.desc || '');
    s.hist.unshift(`${todayMark()} - ${text}`);
    const desc = joinDesc(s);
    if (desc.length > LIMIT) throw new Error('a descrição da tarefa passaria do limite do Trello');
    await api('PUT', `/cards/${task.id}`, {desc});
    const map = load(TASK_KEY, {});
    map[r.card] = task.id;
    save(TASK_KEY, map);
    st.reg = null;
    renderDetail();
    toast(`Registrado em ${task.name}`);
  });
}
function applyModel(id){
  const m = MODELS.find(x => x.id === id), ta = $('#pText'), ti = $('#pTitle');
  if (!m) return;
  ta.value = ta.value.trim() ? `${m.text}\n\n${ta.value}` : m.text;
  if (!ti.value.trim()) ti.value = m.title;
  $('#pModel').value = '';
  count();
  save(DRAFT_KEY, {title: ti.value, text: ta.value});
  const end = m.text.indexOf('\n', m.text.indexOf('\n\n') + 2);
  ta.focus();
  ta.setSelectionRange(end, end);
}

/* ---------- eventos ---------- */
function startNew(){
  st.mode = 'new';
  st.notice = null;
  renderList();
  renderComposer(null);
}
function backToList(){
  st.mode = 'view';
  st.sel = null;
  st.reg = null;
  st.notice = null;
  history.replaceState(null, '', location.pathname + location.search);
  $('#layout').classList.remove('open');
  renderList();
  renderEmpty();
}
function resultAt(el){
  const card = findCard(st.sel), d = card && st.det[card.id];
  const i = Number(el.dataset.i);
  return d ? {card, res: d.results[i], node: $(`.md[data-md="${i}"]`, $('#pane'))} : null;
}
const actions = {
  'new': startNew,
  refresh: () => refresh(),
  theme(){
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('ch.dash.theme', root.dataset.theme); } catch(e){}
  },
  open: el => openCard(el.dataset.id),
  'toggle-arch'(){ st.showArch = !st.showArch; renderList(); },
  back: backToList,
  cancel(){
    const wasEdit = st.mode === 'edit';
    st.mode = 'view';
    if (wasEdit && st.sel){ renderDetail(); return; }
    backToList();
  },
  'save-new': saveNew,
  'save-edit'(){ const c = findCard(st.sel); if (c) saveEdit(c); },
  edit(){ const c = findCard(st.sel); if (c){ st.mode = 'edit'; renderComposer(c); } },
  async 'copy-prompt'(){
    const c = findCard(st.sel), d = c && st.det[c.id];
    if (d) toast(await copyPlain(d.desc) ? 'Prompt copiado.' : 'Não consegui copiar.');
  },
  async 'copy-rich'(el){
    const r = resultAt(el);
    if (r && r.res) toast(await copyRich(r.res.text, r.node) ? 'Copiado com formatação.' : 'Não consegui copiar. Use Baixar .html.', false);
  },
  async 'copy-text'(el){
    const r = resultAt(el);
    if (r && r.node) toast(await copyPlain(r.node.innerText) ? 'Texto copiado.' : 'Não consegui copiar.');
  },
  download(el){ const r = resultAt(el); if (r && r.res) download(r.card, r.res.text); },
  'reg-open': openReg,
  'reg-close'(){ st.reg = null; renderDetail(); },
  'reg-save': saveReg,
  rerun(){ const c = findCard(st.sel); if (c) moveTo(c, 'todo', 'Prompt voltou para A rodar.'); },
  'run-claude'(){ const c = findCard(st.sel); if (c) runClaude(c); },
  'run-ios'(){ const c = findCard(st.sel); if (c) moveTo(c, 'todo', 'No topo de A rodar. No iPhone, toque em Rodar prompt.'); },
  'run-back'(){ const c = findCard(st.sel); if (c) moveTo(c, 'todo', 'Prompt voltou para A rodar.'); },
  'cancel-run'(){ const c = findCard(st.sel); if (c) cancelRun(c); },
  ask(){ const c = findCard(st.sel); if (c) saveAsk(c); },
  archive(){ const c = findCard(st.sel); if (c) moveTo(c, 'arch', 'Prompt arquivado.'); },
  restore(){ const c = findCard(st.sel), d = c && st.det[c.id]; if (c) moveTo(c, d ? (d.results.length ? 'done' : 'todo') : (comments(c) ? 'done' : 'todo'), 'Prompt restaurado.'); }
};
document.addEventListener('click', e => {
  const view = e.target.closest('a.tab[data-view]');
  if (view){ const ui = load(UI_KEY, {}); ui.view = view.dataset.view; save(UI_KEY, ui); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});
function showReg(){
  const list = $('#regTask'), pick = $('#regPick');
  if (list) list.innerHTML = taskOptions();
  if (pick) pick.textContent = regTarget();
}
document.addEventListener('change', e => {
  if (e.target.id === 'pModel') applyModel(e.target.value);
  if (e.target.id === 'regTask' && st.reg){ st.reg.task = e.target.value; showReg(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'askText'){ if (st.sel) st.askDraft[st.sel] = e.target.value; return; }
  if (e.target.id === 'regText' && st.reg){ st.reg.text = e.target.value; return; }
  if (e.target.id === 'regQ' && st.reg){
    st.reg.q = e.target.value;
    if (!taskMatches().some(t => t.id === st.reg.task)) st.reg.task = '';
    showReg();
    return;
  }
  if (e.target.id !== 'pText' && e.target.id !== 'pTitle') return;
  count();
  if (st.mode === 'new') save(DRAFT_KEY, {title: $('#pTitle').value, text: $('#pText').value});
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.id === 'askText'){
    e.preventDefault();
    actions.ask();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && $('#pText')){
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
    renderFatal('Conecte a Carteira primeiro', 'A aba Prompts usa a mesma conexão com o Trello. Abra a Carteira, conecte uma vez neste navegador e volte aqui.');
    return;
  }
  renderEmpty();
  await refresh();
  const m = /^#(P\d{3,})$/.exec(location.hash);
  if (m){
    const c = st.cards.find(x => !x.closed && parseName(x.name).code === m[1]);
    if (c) await openCard(c.id);
  }
  let lastTry = Date.now();
  setInterval(() => {
    const busy = st.cards.some(c => !c.closed && listKey(c) === 'run');
    const wait = document.visibilityState !== 'visible' ? POLL_HIDDEN_MS : busy ? POLL_RUN_MS : POLL_MS;
    if (Date.now() - lastTry < wait) return;
    lastTry = Date.now();
    refresh();
  }, 2000);
}
boot();
})();
