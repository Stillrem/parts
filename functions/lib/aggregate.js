
import { sources } from './sources.js';
import httpGet from './http_get.js';


function absolutizeUrl(src, base){
  if (!src) return '';
  src = String(src).trim();
  if (!src) return '';
  if (src.startsWith('//')) return 'https:'+src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return base.replace(/\/$/,'') + src;
  return src;
}

async function enrichImages(items, maxFetch = 8)
async function enrichImages(items, maxFetch = 8){
  const cheerioMod = await import('cheerio');
  const $load = cheerioMod.load;
  let fetched = 0;

  function hostOf(u){ try { return new URL(u).hostname; } catch { return ''; } }
  function absolutizeUrl(src, base){
    if (!src) return '';
    src = String(src).trim();
    if (!src) return '';
    if (src.startsWith('//')) return 'https:'+src;
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/')) return base.replace(/\/$/,'') + src;
    return src;
  }

  for (const it of items){
    if (fetched >= maxFetch) break;
    if (it.image || !it.url) continue;

    const host = hostOf(it.url);
    const base = it.url.split('/').slice(0,3).join('/');

    try{
      const html = await httpGet(it.url, { 'Referer': base + '/' });
      const $ = $load(html);

      if (/searspartsdirect\\.com$/i.test(host)){
        // Sears: берём только CDN-картинки, предпочтительно из карточек деталей
        let found = '';
        // 1) в блоках с ссылками на детали
        $('a[href*="/part/"], a[href*="/product/"]').each((_,a)=>{
          if (found) return;
          const box = $(a).closest('.part-card, .product-card, .card, [data-component="product-card"]');
          const raw = (box.find('img').attr('src') || box.find('img').attr('srcset') || '').trim();
          const abs = absolutizeUrl(raw, base);
          if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) found = abs;
        });
        // 2) любой img на странице с CDN Sears
        if (!found){
          $('img').each((_,img)=>{
            if (found) return;
            const raw = $(img).attr('src') || $(img).attr('srcset') || '';
            const abs = absolutizeUrl(raw, base);
            if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) found = abs;
          });
        }
        if (found){ it.image = found; fetched++; }
        // Не используем og:image у Sears — часто не то
        continue;
      }

      // Другие домены: пробуем og:image
      const og = $('meta[property="og:image"]').attr('content') || '';
      const img = og || $('img').first().attr('src') || '';
      const abs = absolutizeUrl(img, base);
      if (abs){ it.image = abs; fetched++; }
    }catch{
      // ignore errors per item
    }
  }
  return items;
}

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

  await enrichImages(clean, 10);
  return { items: clean, meta };
}

async function fetchAndParse(src, q){
  const url = src.searchUrl(q);
  const html = await httpGet(url, { 'Referer': url.split('/').slice(0,3).join('/') + '/' });
  return await src.parser(html, q);
}
