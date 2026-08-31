/** Same-origin proxy for the FastAPI CDR service. */
'use strict';

const http = require('http');
const config = require('./config-loader');

const upstreamUrl = new URL(config.cdr.upstream || 'http://127.0.0.1:8000');
const CDR_UPSTREAM = { host: upstreamUrl.hostname, port: Number(upstreamUrl.port) || (upstreamUrl.protocol === 'https:' ? 443 : 80), protocol: upstreamUrl.protocol };

function errorPage(message, detail) {
  const safe = String(detail || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${message}</title><style>body{font-family:system-ui,sans-serif;background:#fff;color:#1a1a1a;display:grid;place-items:center;min-height:100vh;margin:0}.box{max-width:520px;padding:32px;border:1px solid #e8e8e8;border-radius:8px}.detail{color:#767676;font-size:13px;margin-top:8px}</style><main class="box"><strong>${message}</strong><div class="detail">${safe}</div></main></html>`;
}

function proxyToCdr(req, res, targetPath) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const destPath = targetPath + (parsed.search || '');
  const headers = { host: `${CDR_UPSTREAM.host}:${CDR_UPSTREAM.port}`, accept: req.headers.accept || '*/*' };
  for (const key of ['content-type', 'content-length', 'if-none-match', 'if-modified-since']) if (req.headers[key]) headers[key] = req.headers[key];
  const request = http.request({ host: CDR_UPSTREAM.host, port: CDR_UPSTREAM.port, path: destPath, method: req.method, headers, timeout: 30000 }, (upstreamRes) => {
    const responseHeaders = { 'Cache-Control': 'no-store' };
    for (const key of ['content-type', 'content-length', 'content-disposition', 'etag']) if (upstreamRes.headers[key]) responseHeaders[key] = upstreamRes.headers[key];
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  request.on('timeout', () => request.destroy(new Error('CDR 服务响应超时')));
  request.on('error', (error) => {
    if (res.headersSent) return res.destroy(error);
    const unavailable = error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
    res.writeHead(unavailable ? 503 : 502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(errorPage(unavailable ? '话单工具服务暂不可用' : '话单工具代理失败', unavailable ? '请先启动 FastAPI 服务后重试。' : error.message));
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(request); else request.end();
}
module.exports = { CDR_UPSTREAM, proxyToCdr };
