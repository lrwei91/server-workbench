/**
 * cdr-tool（话单文件数据调整工具）反向代理
 *
 * 把 /cdr/* 请求转发给 cdr-tool 的 Python FastAPI 服务，实现 iframe 同源嵌入。
 * 支持 GET/POST，流式转发响应体与状态码。
 */
'use strict';

const http = require('http');
const config = require('../config');

// cdr 话单功能模块是项目内的 Python FastAPI 后端（../cdr），由 start.bat 与工作台一起拉起。
// 工作台通过 /cdr/ 前缀反向代理到该服务，使 iframe 内的前端与 API 同源，避免跨域。
// 上游地址从统一 config 读取（config.cdr）。
const CDR_UPSTREAM = { host: config.cdr.host, port: config.cdr.port };

function proxyToCdr(req, res, targetPath) {
  const upstream = CDR_UPSTREAM;
  // 去掉 /cdr 前缀，拼接原始 query
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const destPath = targetPath + (parsed.search || '');

  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  headers['host'] = `${upstream.host}:${upstream.port}`;
  headers['accept'] = req.headers['accept'] || '*/*';

  const proxyReq = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      path: destPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      // 透传状态码与响应头（内容类型、长度等）
      const respHeaders = { 'Cache-Control': 'no-store' };
      if (proxyRes.headers['content-type']) respHeaders['content-type'] = proxyRes.headers['content-type'];
      if (proxyRes.headers['content-length']) respHeaders['content-length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-disposition']) respHeaders['content-disposition'] = proxyRes.headers['content-disposition'];
      res.writeHead(proxyRes.statusCode || 502, respHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      // cdr-tool 服务未启动：给 iframe 一个可读的提示页
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
        '<style>body{font-family:-apple-system,"Segoe UI",sans-serif;background:#1a1f26;color:#d0d6de;' +
        'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}' +
        '.box{max-width:420px;padding:32px;line-height:1.8}.b{color:#e8eef5;font-weight:600;margin-bottom:8px}' +
        '.t{color:#7a8494;font-size:13px}</style></head><body>' +
        '<div class="box"><div class="b">话单工具服务未启动</div>' +
        '<div class="t">请通过 start.bat 启动工作台（会自动同时拉起话单工具后端）。<br>' +
        '若已启动仍提示此页，请检查端口 8000 是否被占用。</div></div></body></html>'
      );
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('话单工具代理失败：' + (err.message || err));
  });

  // 转发请求体（POST 等）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

module.exports = {
  CDR_UPSTREAM,
  proxyToCdr,
};
