const form = document.getElementById('searchForm');
const grid = document.getElementById('resultsGrid');
const supplierSel = document.getElementById('supplier');
const exportBtn = document.getElementById('exportBtn');
const equivBox = document.getElementById('equivBox');
const equivList = document.getElementById('equivList');
const onlyOEM = document.getElementById('onlyOEM');
const onlyInStock = document.getElementById('onlyInStock');

let lastRows = [];

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  await runSearch(q);
});

supplierSel.addEventListener('change', () => reRender());
onlyOEM.addEventListener('change', () => reRender());
onlyInStock.addEventListener('change', () => reRender());
exportBtn.addEventListener('click', () => exportCSV());

async function runSearch(q) {
  grid.innerHTML = '<div class="meta">Ищем…</div>';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    lastRows = data.items || [];
    reRender();

    const pn = extractPartNumberFromQuery(q);
    if (pn) renderEquivalents(lastRows, pn);
    else { equivBox.classList.add('hidden'); equivList.innerHTML = ''; }
  } catch (e) {
    grid.innerHTML = '<div class="meta">Ошибка: ' + (e.message || e) + '</div>';
  }
}

function reRender() {
  let rows = [...lastRows];

  if (supplierSel.value) rows = rows.filter(r => (r.supplier || '') === supplierSel.value);
  if (onlyOEM.checked) rows = rows.filter(r => (r.oem_flag || '').toString().toLowerCase() === 'true');
  if (onlyInStock.checked) {
    rows = rows.filter(r => /in\s*stock|available|in-store/i.test((r.availability || '') + ' ' + (r.notes || '')));
  }

  // de-dup by url
  const seen = new Set();
  rows = rows.filter(r => {
    const k = r.url || '';
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  renderGrid(rows);
}

function renderGrid(rows) {
  if (!rows.length) {
    grid.innerHTML = '<div class="meta">Ничего не найдено.</div>';
    return;
  }

  const tmpl = document.getElementById('cardTmpl');
  grid.innerHTML = '';

  rows.forEach(r => {
    const node = tmpl.content.cloneNode(true);

    const img = node.querySelector('img.part-image');
    const title = node.querySelector('.part-title');
    const meta = node.querySelector('.meta');
    const price = node.querySelector('.price');
    const compat = node.querySelector('.compat');
    const links = node.querySelector('.links');
    const chips = node.querySelector('.chips');
    const details = node.querySelector('.details');

    // image
    img.src = r.image || 'https://dummyimage.com/240x240/0f1318/2a3440&text=No+Image';
    img.alt = (r.name || r.part_number || 'part') + ' image';

    // title
    title.textContent = r.name || r.part_number || 'Part';

    // details: Part #... + Previous part numbers
    let html = '';
    if (r.part_number) html += `<div class="part-line">Part #${escapeHtml(r.part_number)}</div>`;

    const prevList = Array.isArray(r.previous_part_numbers) ? r.previous_part_numbers : [];
    if (prevList.length) {
      html += `<div class="prev-header">Previous part numbers</div>`;
      html += prevList.map(p => `<div class="part-line">Part #${escapeHtml(p)}</div>`).join('');
    }
    details.innerHTML = html;

    // footer info
    meta.textContent = [r.supplier].filter(Boolean).join(' • ');
    price.textContent = r.price ? (r.price + (r.currency ? ' ' + r.currency : '')) : '';
    compat.textContent = r.compatibility ? ('Совместимость: ' + r.compatibility) : '';

    // link
    const a = document.createElement('a');
    a.href = r.url || '#';
    a.textContent = 'Источник';
    a.target = '_blank'; a.rel = 'noopener';
    links.appendChild(a);

    // chips
    if ((r.oem_flag || '').toString().toLowerCase() === 'true') chips.appendChild(chip('OEM'));
    if (r.availability) chips.appendChild(chip(r.availability));

    grid.appendChild(node);
  });
}

function chip(text) {
  const el = document.createElement('span');
  el.className = 'chip';
  el.textContent = text;
  return el;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractPartNumberFromQuery(q) {
  const m = String(q || '').match(/[A-Z0-9\-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
}

function renderEquivalents(rows, inputPn) {
  const set = new Set();
  rows.forEach(r => (r.equivalents || []).forEach(x => set.add(String(x).trim().toUpperCase())));
  if (!set.size) { equivBox.classList.add('hidden'); return; }
  set.add(inputPn);
  equivBox.classList.remove('hidden');
  equivList.innerHTML = Array.from(set).sort().map(x => `<span class="chip">${escapeHtml(x)}</span>`).join('');
}

function exportCSV() {
  if (!lastRows.length) { alert('Нет данных'); return; }
  const cols = ['supplier','part_number','name','price','currency','model','brand','url','availability','oem_flag'];
  const header = cols.join(',') + '\n';
  const lines = lastRows.map(r => cols.map(c => csvCell(r[c] || '')).join(',')).join('\n');
  const blob = new Blob([header + lines], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'parts.csv'; a.click();
}

function csvCell(v) {
  v = String(v).replace(/"/g, '""');
  if (/[",\n]/.test(v)) return '"' + v + '"';
  return v;
}
