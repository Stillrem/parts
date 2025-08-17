import { sources } from './sources.js';
import httpGet from './http_get.js';
import * as cheerio from 'cheerio';

/* ---------- image helpers ---------- */

function searsImageFromPN(pn, { wid=285, hei=200, qlt=90, sharpen=2 } = {}) {
  pn = String(pn||'').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}
function searsIllustrationFromPN(pn, { wid=285, hei=200, qlt=90, sharpen=2 } = {}) {
  pn = String(pn||'').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}_Illustration?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}
function normalizeSearsImage(u){
  try{
    const url = new URL(u);
    if (url.hostname !== 's.sears.com') return u;
    const hasSize = url.searchParams.has('wid')||url.searchParams.has('w')||
                    url.searchParams.has('hei')||url.searchParams.has('h')||
                    url.searchParams.has('fmt');
    if (!hasSize){
      url.searchParams.set('wid','285');
      url.searchParams.set('hei','200');
      url.searchParams.set('fmt','pjpg');
      url.searchParams.set('qlt','90');
      url.searchParams.set('op_sharpen','2');
      return url.toString();
    }
    return u;
  }catch{ return u; }
}
function normalizeRCImage(u){
  try{ return new URL(u,'https://www.repairclinic.com').toString(); }
  catch{ return u; }
}
function proxyImage(u){
  if (!u) return '';
  if (u.startsWith('/api/img?u=')) return u;
  let host=''; try{ host = new URL(u).hostname; }catch{ return u; }
  const ALLOW = new Set(['s.sears.com','www.repairclinic.com','rcappliancepartsimages.com']);
  if (!ALLOW.has(host)) return u;
  return `/api/img?u=${encodeURIComponent(u)}`;
}
const BUILT_SEARS_PN_IMG = /https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_\d+\b/i;

/* картинка хранится под «другим» PN */
const SEARS_IMG_PN_REDIRECT = {
  '5304509475': '5304464094',
  '5304509458': '5304464097',
  '5304509459': '5304464098'
};

/* ---------- HTML helpers ---------- */

function findAnyImageFromHtml(html, baseHost){
  const $ = cheerio.load(html);
  let found = $('meta[property="og:image"],meta[name="og:image"]').attr('content')||'';
  if (!found){
    $('img,source').each((_,el)=>{
      if (found) return;
      const cand = el.attribs?.srcset || el.attribs?.['data-srcset'] ||
                   el.attribs?.src    || el.attribs?.['data-src']    || '';
      const m = String(cand).match(/https?:\/\/[^?\s,]+/);
      if (m) found = m[0];
    });
  }
  if (!found){
    const m = String(html).match(/https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_(\d{7,})/i);
    if (m && m[1]) found = searsImageFromPN(m[1]);
  }
  if (!found) return '';
  try{ return new URL(found, `https://${baseHost}`).toString(); }
  catch{ return found; }
}

/* ===== Previous part numbers: только из нужной секции ===== */
function extractPrevPNsFromSearsPDP(html, currentPN=''){
  const $ = cheerio.load(html);
  const rxPN = /\b(530\d{7})\b/g;          // берём только 530xxxxxx

  // 1) прямая секция
  let bucketText = '';
  $('*').each((_,el)=>{
    const txt = $(el).text().replace(/\s+/g,' ').trim();
    if (/^previous\s+part\s+numbers$/i.test(txt)){
      const block = $(el).closest('section,div');
      if (block && block.length){
        bucketText = block.text();
      }
      return false;
    }
    return undefined;
  });

  // 2) fallback: окно вокруг заголовка
  if (!bucketText){
    const body = String(html);
    const start = body.search(/Previous\s+part\s+numbers/i);
    if (start !== -1){
      // берём «окно» до следующего заголовка/секции
      const tail = body.slice(start, start + 8000);
      const stop = tail.search(/(This\s+Part\s+Also\s+Fits|Customers\s+also|You\s+Might\s+Also|<h\d|<\/section>|<\/div>)/i);
      bucketText = tail.slice(0, stop > 0 ? stop : 3000);
    }
  }

  const set = new Set();
  let m; while ((m = rxPN.exec(bucketText))) set.add(m[1]);

  if (currentPN) set.delete(String(currentPN));
  return Array.from(set).slice(0,6);
}

/* ---------- main ---------- */

export async function aggregate(q){
  const started = Date.now();
  const results = await Promise.allSettled(sources.map(s=>fetchAndParse(s,q)));

  const items = [];
  const meta = { took_ms: Date.now()-started, sources: [] };

  for (let i=0;i<results.length;i++){
    const name = sources[i].name;
    const r = results[i];
    if (r.status==='fulfilled'){
      const arr = Array.isArray(r.value)?r.value:[];
      meta.sources.push({ name, ok:true, count:arr.length });
      for (const x of arr){
        items.push({
          supplier: name,
          name: x.title||x.name||'',
          url: x.link||x.url||'',
          image: x.image||'',
          price: x.price||'',
          currency: x.currency||'',
          part_number: x.part_number||'',
          prev_part_numbers: x.prev_part_numbers||[],
          availability: x.availability||'',
          oem_flag: x.oem_flag||false
        });
      }
    }else{
      meta.sources.push({ name, ok:false, error:String(r.reason?.message||r.reason) });
      console.warn('[aggregate] failed for', name, r.reason?.message||r.reason);
    }
  }

  // de-dup by URL
  const seen = new Set();
  const clean = items.filter(it=>{
    if (!it.url) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  /* --- images pre-pass --- */
  const BAD_SEARS_IMG = /PD_0022_628_(KENMORE|CROSLEY|MICROWAVE|WHITE-WESTINGHOUSE|LATCH)\b/i;
  for (const it of clean){
    if (it.supplier!=='SearsPartsDirect') continue;
    const pnRaw = (String(it.part_number||'').match(/\d{7,}/)||[])[0]||'';
    const pn = SEARS_IMG_PN_REDIRECT[pnRaw] || pnRaw;
    const missing = !it.image;
    const bad = it.image && BAD_SEARS_IMG.test(it.image);
    if (pn && (missing||bad)) it.image = searsImageFromPN(pn);
  }

  /* --- PDP fetch for images + prev PNs --- */
  const toFetch = [];
  const MAX_PDP = 16;
  for (const it of clean){
    if (!it.url) continue;
    const isSears = it.supplier==='SearsPartsDirect';
    const isRC    = it.supplier==='RepairClinic';
    const needsImg = (isSears && (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image))))
                  || (isRC && !it.image);
    const needsPrev = isSears && (!it.prev_part_numbers || it.prev_part_numbers.length===0);
    if (needsImg || needsPrev){
      toFetch.push(it);
      if (toFetch.length>=MAX_PDP) break;
    }
  }

  await Promise.allSettled(toFetch.map(async it=>{
    try{
      const html = await httpGet(it.url, {
        Referer: it.url.split('/').slice(0,3).join('/') + '/',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        'Accept-Language':'en-US,en;q=0.9'
      });
      const host = new URL(it.url).hostname;

      // image
      if (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image))){
        let img = findAnyImageFromHtml(html, host);
        if (!img && host.includes('searspartsdirect.com')){
          const pnRaw = (String(it.part_number||'').match(/\d{7,}/)||[])[0]||'';
          const pnForImg = SEARS_IMG_PN_REDIRECT[pnRaw] || pnRaw;
          img = searsIllustrationFromPN(pnForImg);
        }
        if (img){
          if (host.includes('searspartsdirect.com')) img = normalizeSearsImage(img);
          if (host.includes('repairclinic.com'))      img = normalizeRCImage(img);
          it.image = img;
        }
      }

      // Previous part numbers (строго из секции)
      if (host.includes('searspartsdirect.com')){
        const currentPN = (String(it.part_number||'').match(/\d{7,}/)||[])[0]||'';
        const prev = extractPrevPNsFromSearsPDP(html, currentPN);
        if (prev.length){
          it.prev_part_numbers = Array.from(new Set([...(it.prev_part_numbers||[]), ...prev]));
        }
      }
    }catch{ /* ignore */ }
  }));

  // HEAD-проверка «нашей» PN-картинки
  async function checkSearsAndMaybeIllustration(it){
    const raw = (String(it.part_number||'').match(/\d{7,}/)||[])[0]||'';
    const pn = SEARS_IMG_PN_REDIRECT[raw] || raw;
    if (!pn) return;
    if (!BUILT_SEARS_PN_IMG.test(String(it.image||''))) return;
    try{
      const testUrl = searsImageFromPN(pn);
      const resp = await fetch(testUrl, { method:'HEAD' });
      if (!resp.ok) it.image = searsIllustrationFromPN(pn);
    }catch{
      it.image = searsIllustrationFromPN(pn);
    }
  }
  {
    const cand = [];
    for (const it of clean){
      if (it.supplier==='SearsPartsDirect' && BUILT_SEARS_PN_IMG.test(String(it.image||''))){
        cand.push(it);
        if (cand.length>=16) break;
      }
    }
    await Promise.allSettled(cand.map(checkSearsAndMaybeIllustration));
  }

  // proxy
  for (const it of clean){
    if (it.image) it.image = proxyImage(it.image);
  }

  /* --- title formatting (с добавлением Previous) --- */
  for (const it of clean){
    const out = [];
    const base = (it.name||'').trim();
    if (base) out.push(base);

    const curr = (String(it.part_number||'').match(/\d{7,}/)||[])[0] || it.part_number || '';
    if (curr) out.push(`Part #${curr}`);

    if (it.prev_part_numbers && it.prev_part_numbers.length){
      const prev = Array.from(new Set(
        it.prev_part_numbers
          .map(p=>String(p))
          .filter(p=>p!==String(curr) && /^530\d{7}$/.test(p))
      ));
      if (prev.length){
        out.push('Previous part numbers');
        prev.forEach(p=>out.push(`Part #${p}`));
      }
    }
    if (out.length) it.name = out.join('\n');
  }

  return { items: clean, meta };
}

/* ---------- utils ---------- */

async function fetchAndParse(src, q){
  const url = src.searchUrl(q);
  const html = await httpGet(url, { Referer: url.split('/').slice(0,3).join('/') + '/' });
  return await src.parser(html, q);
}
