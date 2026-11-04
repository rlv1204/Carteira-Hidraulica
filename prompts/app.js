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
const LIST_NAMES = {todo: 'A rodar', done: 'Pronto', arch: 'Arquivo'};
const POLL_MS = 30000;
const LIMIT = 16384;
const CARD_FIELDS = 'name,idList,closed,dateLastActivity,badges';

const $ = (s, r = document) => r.querySelector(s);

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
  q: '', showArch: false, lastOk: 0, loading: false, saving: false, failed: null,
  seen: load(SEEN_KEY, {})
};

/* ---------- Trello ---------- */
async function api(method, path, params = {}){
  const qs = new URLSearchParams({key: st.conn.key, token: st.conn.token});
  const opts = {method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'};
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => qs.set(k, v));
  else opts.body = new URLSearchParams(params);
  let r;
  try { r = await fetch(`${API}${path}?${qs}`, opts); }
  catch(e){ throw new Error('sem conexão com api.trello.com'); }
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
function listKey(card){ return Object.keys(st.lists).find(k => st.lists[k].id === card.idList) || 'todo'; }
function comments(card){ return (card.badges && card.badges.comments) || 0; }
function stamp(card){ return `${card.dateLastActivity}|${comments(card)}|${card.idList}`; }
function findCard(id){ return st.cards.find(c => c.id === id && !c.closed) || null; }
function fmtWhen(iso){
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).replace(',', '');
}

/* Resultado longo chega em comentários que começam com [parte 1/3]. */
function groupResults(actions){
  const items = (actions || [])
    .map(a => ({date: a.date, text: (a.data && a.data.text) || ''}))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const out = [];
  let cur = null;
  items.forEach(it => {
    const m = /^\s*\[parte\s+(\d+)\s*\/\s*(\d+)\]\s*\r?\n?/i.exec(it.text);
    if (!m){ out.push({date: it.date, text: it.text, total: 1, got: 1}); cur = null; return; }
    const part = Number(m[1]), total = Number(m[2]), body = it.text.slice(m[0].length);
    if (!cur || cur.total !== total || cur.parts[part]){
      cur = {date: it.date, total, parts: {}};
      out.push(cur);
    }
    cur.parts[part] = body;
    cur.date = it.date;
    cur.got = Object.keys(cur.parts).length;
    cur.text = Object.keys(cur.parts).map(Number).sort((a, b) => a - b).map(n => cur.parts[n]).join('\n');
  });
  return out.reverse();
}

/* ---------- Markdown: o texto é escapado antes de virar HTML ---------- */
function inline(src){
  return src.split(/(`[^`\n]+`)/g).map(p => {
    if (/^`[^`\n]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`;
    let t = esc(p);
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    t = t.replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
    return t;
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
      const body = rows.map(r => `<tr>${head.map((_, k) => `<td${cls(k)}>${inline(r[k] || '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`);
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
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(card.name)}</title></head><body>${exportHtml(md)}</body></html>`;
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
}

/* ---------- tela ---------- */
const GROUPS = [['todo', 'A rodar'], ['done', 'Pronto']];
function matches(c){
  if (!st.q) return true;
  const q = st.q.toLowerCase();
  const d = st.det[c.id];
  return c.name.toLowerCase().includes(q) || (d && d.desc.toLowerCase().includes(q));
}
function itemHtml(c){
  const p = parseName(c.name);
  const unread = comments(c) > (st.seen[c.id] || 0);
  return `<button type="button" class="item${c.id === st.sel && st.mode !== 'new' ? ' on' : ''}" data-act="open" data-id="${esc(c.id)}">
    <span class="item-top"><b class="code num">${esc(p.code || 'P---')}</b>${unread ? '<span class="dot">novo</span>' : ''}<span class="when num">${esc(fmtWhen(c.dateLastActivity))}</span></span>
    <span class="item-title">${esc(p.title)}</span></button>`;
}
function renderList(){
  const open = st.cards.filter(c => !c.closed && matches(c)).sort((a, b) => String(b.dateLastActivity).localeCompare(String(a.dateLastActivity)));
  const of = k => open.filter(c => listKey(c) === k);
  let html = GROUPS.map(([k, label]) => {
    const list = of(k);
    return `<h2 class="group">${label} <span class="count num">${list.length}</span></h2>${list.length ? list.map(itemHtml).join('') : `<p class="fine pad">${k === 'todo' ? 'Nenhum prompt aguardando.' : 'Nenhum resultado ainda.'}</p>`}`;
  }).join('');
  const arch = of('arch');
  html += `<button type="button" class="group-btn" data-act="toggle-arch" aria-expanded="${st.showArch}">Arquivo <span class="count num">${arch.length}</span></button>`;
  if (st.showArch) html += arch.map(itemHtml).join('');
  $('#side').innerHTML = html;
}
function renderEmpty(){
  $('#pane').dataset.card = '';
  $('#pane').innerHTML = `<div class="empty">
    <h2>Escreva o prompt aqui e rode no celular</h2>
    <ol>
      <li>Clique em <b>Novo prompt</b>, escreva e salve. Ele recebe um número, como P012.</li>
      <li>No celular, abra um chat no Claude e mande <b>roda o P012</b>.</li>
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
  const tools = `<div class="row tools">
    <button type="button" class="btn primary" data-act="copy-rich" data-i="${i}">Copiar formatado</button>
    <button type="button" class="btn" data-act="copy-text" data-i="${i}">Copiar texto</button>
    <button type="button" class="btn" data-act="download" data-i="${i}">Baixar .html</button>
  </div>`;
  const warn = incomplete ? `<div class="msg warn">Recebendo o resultado: ${r.got} de ${r.total} partes. O restante aparece aqui quando for gravado.</div>` : '';
  if (i === 0) return `<section class="block"><div class="block-h"><h3>Resultado</h3><span class="fine num">${esc(fmtWhen(r.date))}</span></div>${warn}${tools}${body}</section>`;
  return `<details class="block old"><summary>Resultado anterior · <span class="num">${esc(fmtWhen(r.date))}</span></summary>${warn}${tools}${body}</details>`;
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
  const moves = key === 'arch'
    ? `<button type="button" class="btn" data-act="restore">Restaurar</button>`
    : `${key === 'done' ? '<button type="button" class="btn" data-act="rerun">Rodar de novo</button>' : ''}<button type="button" class="btn" data-act="archive">Arquivar</button>`;
  let content = '<p class="fine">Carregando…</p>';
  if (d){
    const results = d.results;
    const waiting = key === 'todo' && !results.length
      ? `<div class="wait"><b>Aguardando o resultado.</b> No celular, mande: <code>${esc(command(card))}</code></div>` : '';
    const promptBlock = `<details class="block" ${results.length ? '' : 'open'}><summary>Prompt</summary><pre class="prompt">${esc(d.desc)}</pre>
      <div class="row tools"><button type="button" class="btn" data-act="copy-prompt">Copiar prompt</button><button type="button" class="btn" data-act="edit">Editar</button></div></details>`;
    content = waiting + promptBlock + results.map((r, i) => resultHtml(r, i, card)).join('');
  }
  pane.innerHTML = `<div class="card">
    <button type="button" class="btn ghost back" data-act="back">‹ Voltar</button>
    ${st.notice ? `<div class="msg ok">${esc(st.notice)}</div>` : ''}
    <div class="head">
      <div class="head-t"><span class="code big num">${esc(p.code)}</span><span class="pill ${key}">${esc(LIST_NAMES[key])}</span><h2>${esc(p.title)}</h2></div>
      <div class="row"><button type="button" class="btn" data-act="copy-cmd">Copiar comando</button>${moves}</div>
    </div>
    ${content}
  </div>`;
  pane.dataset.card = card.id;
  pane.dataset.loaded = d ? '1' : '';
  [...pane.querySelectorAll('details')].forEach((x, i) => { if (openOld[i] !== undefined) x.open = openOld[i]; });
  pane.scrollTop = scroll;
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
async function refresh(){
  if (st.loading || !st.conn) return;
  st.loading = true;
  setSync('busy', 'Atualizando…');
  try {
    const b = await api('GET', `/boards/${BOARD}`, {fields: 'name', lists: 'open', list_fields: 'name', cards: 'all', card_fields: CARD_FIELDS});
    const lists = {};
    Object.entries(LIST_NAMES).forEach(([k, n]) => { const l = (b.lists || []).find(x => x.name === n); if (l) lists[k] = l; });
    const missing = Object.keys(LIST_NAMES).find(k => !lists[k]);
    if (missing) throw Object.assign(new Error(`lista "${LIST_NAMES[missing]}" não encontrada no quadro Prompts`), {status: 'list'});
    st.lists = lists;
    st.cards = b.cards || [];
    st.lastOk = Date.now();
    st.failed = null;
    setSync('', `Atualizado às ${new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}`);
    renderList();
    await syncDetail();
  } catch(e){
    st.failed = e;
    setSync('err', `Falhou: ${e.message}`);
    if (e.status === 401 || e.status === 404) renderFatal('Conexão com o Trello recusada', 'Abra a Carteira, confira a conexão neste navegador e volte para esta aba.');
    else if (!st.lastOk) renderFatal('Não consegui ler o quadro Prompts', `${e.message}. A página tenta de novo a cada 30 segundos.`);
  } finally { st.loading = false; }
}
async function loadDetail(card){
  const [c, acts] = await Promise.all([
    api('GET', `/cards/${card.id}`, {fields: 'desc'}),
    comments(card) ? api('GET', `/cards/${card.id}/actions`, {filter: 'commentCard', limit: '1000'}) : Promise.resolve([])
  ]);
  st.det[card.id] = {stamp: stamp(card), desc: c.desc || '', results: groupResults(acts)};
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
  markSeen(card);
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
    await refresh();
    await openCard(c.id, `${code} salvo. No celular, mande: roda o ${code}`);
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
    await refresh();
    await openCard(card.id, 'Prompt atualizado.');
  });
}
async function moveTo(card, key, msg){
  await run(async () => {
    await api('PUT', `/cards/${card.id}`, {idList: st.lists[key].id, pos: 'top'});
    st.notice = null;
    await refresh();
    toast(msg);
  });
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
  async 'copy-cmd'(){ const c = findCard(st.sel); if (c) toast(await copyPlain(command(c)) ? `Copiado: ${command(c)}` : 'Não consegui copiar.', false); },
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
  rerun(){ const c = findCard(st.sel); if (c) moveTo(c, 'todo', 'Prompt voltou para A rodar.'); },
  archive(){ const c = findCard(st.sel); if (c) moveTo(c, 'arch', 'Prompt arquivado.'); },
  restore(){ const c = findCard(st.sel); if (c) moveTo(c, comments(c) ? 'done' : 'todo', 'Prompt restaurado.'); }
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
  if (e.target.id !== 'pText' && e.target.id !== 'pTitle') return;
  count();
  if (st.mode === 'new') save(DRAFT_KEY, {title: $('#pTitle').value, text: $('#pText').value});
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && $('#pText')){
    e.preventDefault();
    (st.mode === 'edit' ? actions['save-edit'] : saveNew)();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'n'){ e.preventDefault(); startNew(); }
  else if (k === 'r'){ e.preventDefault(); refresh(); }
  else if (k === '/'){ e.preventDefault(); $('#q').focus(); }
});
let qt;
$('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); renderList(); }, 120); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - st.lastOk > 10000) refresh();
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
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
}
boot();
})();
