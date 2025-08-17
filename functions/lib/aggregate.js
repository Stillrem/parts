import { fromRepairClinic, fromAppliancePartsPros, fromPartSelect, fromSears } from './sources.js';

function dedupe(items){
  const seen = new Set();
  return items.filter(it => {
    const k = [it.supplier || '', it.url || '', it.part_number || '', it.name || ''].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const dt = Date.now() - t0;
    console.log(`[agg] ${label}: ${Array.isArray(out) ? out.length : 0} items in ${dt}ms`);
    return Array.isArray(out) ? out : [];
  } catch (e) {
    console.warn(`[agg] ${label} failed: ${e && e.message ? e.message : e}`);
    return [];
  }
}

export async function aggregate(query){
  const results = await Promise.all([
    timed('RepairClinic', () => fromRepairClinic(query)),
    timed('AppliancePartsPros', () => fromAppliancePartsPros(query)),
    timed('PartSelect', () => fromPartSelect(query)),
    timed('SearsPartsDirect', () => fromSears(query)),
  ]);

  let items = results.flat();
  return dedupe(items).slice(0, 80);
}
