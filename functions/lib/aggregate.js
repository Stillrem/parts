import axios from 'axios';
import { sources } from './sources.js';

export async function aggregate(q) {
  const started = Date.now();
  const results = await Promise.allSettled(
    sources.map(s => fetchAndParseSource(s, q))
  );

  const items = [];
  const meta = { took_ms: Date.now() - started, sources: [] };

  results.forEach((r, i) => {
    const name = sources[i].name;
    if (r.status === 'fulfilled') {
      const arr = Array.isArray(r.value) ? r.value : [];
      meta.sources.push({ name, ok: true, count: arr.length });
      items.push(...arr.map(x => normalizeItem(x, name)));
    } else {
      meta.sources.push({ name, ok: false, error: String(r.reason?.message || r.reason) });
      console.warn(`[agg] ${name} failed:`, r.reason?.message || r.reason);
    }
  });

  // дедуп по (url) и мелкая чистка
  const seen = new Set();
  const clean = items.filter(it => {
    if (!it.url) return false;
    const k = it.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { items: clean, meta };
}

async function fetchAndParseSource(src, q) {
  const url = src.searchUrl(q);
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': url.split('/').slice(0,3).join('/') + '/'
    },
    timeout: 15000,
    validateStatus: () => true
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} on ${url}`);
  return await src.parser(res.data, q);
}

function normalizeItem(x, supplier) {
  return {
    supplier,
    name: x.title || x.name || x.part || '',
    url: x.link || x.url || '',
    image: x.image || '',
    price: x.price || '',
    currency: x.currency || '',
    part_number: x.part_number || ''
  };
}
