// functions/img.js
export async function handler(event) {
  try {
    const u = (event.queryStringParameters && (event.queryStringParameters.u || event.queryStringParameters.url)) || '';
    if (!u) {
      return { statusCode: 400, body: 'Missing u' };
    }

    let url;
    try { url = new URL(u); } catch { return { statusCode: 400, body: 'Bad URL' }; }

    // Разрешённые источники изображений
    const ALLOW = new Set([
      's.sears.com',
      'www.repairclinic.com',
      'rcappliancepartsimages.com'
    ]);
    if (!ALLOW.has(url.hostname)) {
      return { statusCode: 400, body: 'Host not allowed' };
    }

    const upstream = await fetch(url.toString(), {
      headers: {
        'Accept': 'image/*,*/*;q=0.8',
        // Scene7/RC любят видеть корректный referer
        'Referer': `${url.protocol}//${url.hostname}/`,
        'User-Agent': 'Mozilla/5.0 (compatible; PartsHub/1.0)'
      }
    });

    if (!upstream.ok) {
      return { statusCode: upstream.status, body: `Upstream ${upstream.status}` };
    }

    const arrBuf = await upstream.arrayBuffer();
    const body = Buffer.from(arrBuf).toString('base64');
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, immutable',
        'Access-Control-Allow-Origin': '*'
      },
      body,
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: 500, body: 'Proxy error: ' + (e && e.message ? e.message : String(e)) };
  }
}
