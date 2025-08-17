import { aggregate } from './lib/aggregate.js';

export async function handler(event){
  try{
    const q = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
    if (!q) return json(400, { error: 'q is required' });
    const { items, meta } = await aggregate(q);
    return json(200, { items, meta });
  }catch(err){
    console.error('[fn] error', err);
    return json(500, { error: String(err?.message || err) });
  }
}

function json(statusCode, body){
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body)
  };
}