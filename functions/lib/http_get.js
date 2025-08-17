import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

export default function httpGet(url, extraHeaders = {}, redirects = 0){
  return new Promise((resolve, reject) => {
    let u;
    try { u = new NodeURL(url); } catch (e) { return reject(e); }
    const client = u.protocol === 'http:' ? http : https;
    const opts = {
      method: 'GET',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
        ...extraHeaders
      },
      timeout: 20000
    };
    const req = client.request(opts, (res) => {
      const sc = res.statusCode || 0;
      // redirects
      if (sc >= 300 && sc < 400 && res.headers.location){
        if (redirects >= 5) { res.resume(); return reject(new Error('Too many redirects')); }
        const loc = new NodeURL(res.headers.location, u).toString();
        res.resume();
        return resolve(httpGet(loc, extraHeaders, redirects+1));
      }
      if (sc < 200 || sc >= 300){
        let errBuf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { errBuf += chunk; });
        res.on('end', () => reject(new Error(`HTTP ${sc} on ${url}`)));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => resolve(buf));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end();
  });
}