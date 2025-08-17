// ESM Netlify Function
import { aggregate } from './lib/aggregate.js';

export async function handler(event) {
  try {
    const q = new URLSearchParams(event.queryStringParameters || {}).get('q')?.trim() || '';
    if (!q) {
      return resp(400, { error: 'q is required' });
    }
    const { items, meta } = await aggregate(q);
    return resp(200, { items, meta });
  } catch (err) {
    console.error('[fn] error:', err && err.stack || err);
    return resp(500, { error: `Internal error: ${err?.message || err}` });
  }
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}
