// public/app.js
const form = document.getElementById('searchForm');
const grid = document.getElementById('resultsGrid');
const supplierSel = document.getElementById('supplier');
const exportBtn = document.getElementById('exportBtn');
const equivBox = document.getElementById('equivBox');
const equivList = document.getElementById('equivList');
const onlyOEM = document.getElementById('onlyOEM');
const onlyInStock = document.getElementById('onlyInStock');

let lastRows = [];

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  await runSearch(q);
});
supplierSel.addEventListener('change', ()=> reRender());
onlyOEM.addEventListener('change', ()=> reRender());
onlyInStock.addEventListener('change', ()=> reRender());
exportBtn.addEventListener('click', ()=> exportCSV());

async function runSearch(q){
  grid.innerHTML = '<div class="meta">Ищем…</div>';
  try{
    const res = await fetch('/api/search?q='+encodeURIComponent(q));
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    lastRows = data.items || [];
    reRender();
    const pn = extractPartNumberFromQuery(q);
    if (pn) renderEquivalents(lastRows, pn); else { equivBox.classList.add('hidden'); equivList.innerHTML=''; }
  }catch(e){
    grid.innerHTML = '<div class="meta">Ошибка: '+(e.message||e)+'</div>';
  }
}

function reRender(){
  let rows = [...lastRows];
  if (supplierSel.value) rows = rows.filter(r => (r.supplier||'') === supplierSel.value);
  if (onlyOEM.checked) rows = rows.filter(r => (r.oem_flag||'').toString().toLowerCase() === 'true');
  if (onlyInStock.checked) rows = rows.filter(r => /in\s*stock|available|in-store/i.test((r.availability||'') + ' ' + (r.notes||'')));
  // de-dup by url
  const seen = new Set();
  rows = rows.filter(r => {
    const k = r.url||'';
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  renderGrid(rows);
}

// ---------- УСТОЙЧИВЫЙ рендер карточек (совместим со старым шаблоном) ----------
function renderGrid(rows){
  if (!rows.length){
    grid.innerHTML = '<div class="meta">Ничего не найдено.</div>';
    return;
  }

  const tmpl = document.getElementById('cardTmpl');
  grid.innerHTML = '';

  rows.forEach(r => {
    const frag = tmpl.content.cloneNode(true);

    const img   = frag.querySelector('.part-card__img') || frag.querySelector('img');
    const title = frag.querySelector('.title');
    const meta  = frag.querySelector('.meta');
    const price = frag.querySelector('.price');
    const compat= frag.querySelector('.compat');
    const links = frag.querySelector('.links');
    const chips = frag.querySelector('.chips');

    // Создаём .desc, если его нет (чтобы выводить Part/Previous)
    let desc = frag.querySelector('.desc');
    if (!desc) {
      desc = document.createElement('div');
      desc.className = 'desc';
      const body = frag.querySelector('.part-card__body') || frag.querySelector('.right') || frag;
      const before = body.querySelector('.meta');
      if (before) body.insertBefore(desc, before); else body.appendChild(desc);
    }

    // Картинка
    if (img) {
      img.src = r.image || 'https://dummyimage.com/600x400/0f1318/2a3440&text=No+Image';
      img.alt = (r.name||r.part_number||'part') + ' image';
      img.loading = 'lazy';
    }

    // Заголовок (name уже содержит текстовую часть)
    if (title) title.textContent = r.name || r.part_number || 'Part';

    // Описание: Part # первым, затем Previous part numbers
    const lines = [];
    const pnDigits = (String(r.part_number||'').match(/\d{7,}/) || [])[0] || '';
    if (pnDigits) lines.push(`<div>Part #${pnDigits}</div>`);
    const prev = (r.previous_part_numbers || []).filter(Boolean);
    if (prev.length) {
      lines.push('<div class="prev-header">Previous part numbers</div>');
      for (const p of prev) lines.push(`<div>Part #${p}</div>`);
    }
    desc.innerHTML = lines.join('');

    // Остальные поля
    if (meta)   meta.textContent   = [r.supplier].filter(Boolean).join(' • ');
    if (price)  price.textContent  = r.price ? (r.price + (r.currency ? ' '+r.currency : '')) : '';
    if (compat) compat.textContent = r.compatibility ? ('Совместимость: '+r.compatibility) : '';

    if (links) {
      const a = document.createElement('a');
      a.href = r.url || '#';
      a.textContent = 'Источник';
      a.target = '_blank'; a.rel='noopener';
      links.appendChild(a);
    }

    if (chips) {
      if ((r.oem_flag||'').toString().toLowerCase() === 'true') chips.appendChild(chip('OEM'));
      if (r.availability) chips.appendChild(chip(r.availability));
    }

    grid.appendChild(frag);
  });
}

function chip(text){ const el = document.createElement('span'); el.className='chip'; el.textContent = text; return el; }

function extractPartNumberFromQuery(q){
  const m = String(q||'').match(/[A-Z0-9\-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
}
function renderEquivalents(rows,inputPn){
  const set = new Set();
  rows.forEach(r => (r.equivalents||[]).forEach(x=> set.add(String(x).trim().toUpperCase())));
  if (!set.size){ equivBox.classList.add('hidden'); return; }
  set.add(inputPn);
  equivBox.classList.remove('hidden');
  equivList.innerHTML = Array.from(set).sort().map(x=>`<span class="chip">${x}</span>`).join('');
}

function exportCSV(){
  if (!lastRows.length){ alert('Нет данных'); return; }
  const cols = ['supplier','part_number','name','price','currency','model','brand','url','availability','oem_flag'];
  const header = cols.join(',')+'\n';
  const lines = lastRows.map(r => cols.map(c => csvCell(r[c]||'')).join(',')).join('\n');
  const blob = new Blob([header+lines],{type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'parts.csv'; a.click();
}
function csvCell(v){ v = String(v).replace(/"/g,'""'); if (/[",\n]/.test(v)) return '"' + v + '"'; return v; }
