// Netlify Functions (Node 18+, ESM)
import { aggregate } from './lib/aggregate.js';

export async function handler(event, context) {
  try {
    const q = (event.queryStringParameters && event.queryStringParameters.q) || '';
    if (!q) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing q' }),
      };
    }

    const items = await aggregate(q);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
      },
      body: JSON.stringify({ items }),
    };
  } catch (e) {
    console.error('[api/search] failed', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e && e.message ? e.message : String(e) }),
    };
  }
}
