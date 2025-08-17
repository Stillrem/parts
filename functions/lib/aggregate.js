
import { sources } from './sources.js';
import httpGet from './http_get.js';

export async function aggregate(q){
  const started = Date.now();
  const results = await Promise.allSettled(sources.map(s => fetchAndParse(s, q)));

  const items = [];
  const meta = { took_ms: Date.now() - started, sources: [] };

  for (let i=0;i<results.length;i++){
    const name = sources[i].name;
    const r = results[i];
    if (r.status === 'fulfilled'){
      const arr = Array.isArray(r.value) ? r.value : [];
      meta.sources.push({ name, ok:true, count:arr.length });
      arr.forEach(x => items.push({
        supplier: name,
        name: x.title || x.name || '',
        url: x.link || x.url || '',
        image: x.image || '',
        price: x.price || '',
        currency: x.currency || '',
        part_number: x.part_number || '',
        availability: x.availability || '',
        oem_flag: x.oem_flag || false
      }));
    } else {
      meta.sources.push({ name, ok:false, error: String(r.reason?.message || r.reason) });
      console.warn('[aggregate] failed for', name, r.reason?.message || r.reason);
    }
  }

  // de-dup by url
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

async function fetchAndParse(src, q){
  const url = src.searchUrl(q);
  const html = await httpGet(url, { 'Referer': url.split('/').slice(0,3).join('/') + '/' });
  return await src.parser(html, q);
}
