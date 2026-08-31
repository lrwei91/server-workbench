/**
 * 远程服务器管理工作台 - 本地桥接服务（主入口）
 *
 * 职责：
 *   1. 托管工作台页面 public/index.html（静态文件）
 *   2. 组织 HTTP 路由：连接 / 命令 / SFTP / HDFS / 话单工具代理
 *
 * 模块划分（功能解耦）：
 *   - ssh.js     SSH 连接管理与远程命令执行
 *   - sftp.js    SFTP 文件浏览（通道复用 + 列目录 + 下载）
 *   - hdfs.js    HDFS（hadoop fs）浏览
 *   - proxy.js   cdr-tool（话单工具）反向代理
 *
 * 安全说明：
 *   - 仅监听 127.0.0.1，不对外网暴露
 *   - 默认连接凭据按需求预置于 ssh.js，如更换服务器请修改 DEFAULT_CONFIG
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ssh = require('./ssh');
const sftp = require('./sftp');
const hdfs = require('./hdfs');
const proxy = require('./proxy');
const log = require('./log');
const config = require('../config');

const PORT = config.workbench.port;
const HOST = config.workbench.host;

// ---------- 小工具 ----------
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); }
      catch (e) { resolve({}); }
    });
  });
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    // ---- 静态页面 ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(__dirname, '..', 'public', 'index.html')).pipe(res);
      return;
    }

    // ---- 静态资源（CSS / JS）----
    if (req.method === 'GET' && (p === '/style.css' || p === '/app.js')) {
      const file = path.join(__dirname, '..', 'public', p.slice(1));
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('资源不存在: ' + p);
      }
      const type = p.endsWith('.css') ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ---- cdr-tool（话单工具）反向代理 ----
    // /cdr → cdr-tool 首页；/cdr/xxx → 转发到 FastAPI 的 /xxx（含 /api/* 与 /static/*）
    if (p === '/cdr' || p === '/cdr/') {
      return proxy.proxyToCdr(req, res, '/');
    }
    if (p.startsWith('/cdr/')) {
      return proxy.proxyToCdr(req, res, p.slice('/cdr'.length));
    }

    // ---- 执行日志持久化 ----
    // 追加一条日志（写盘到 logs/YYYY-MM-DD.log）
    if (req.method === 'POST' && p === '/api/log/append') {
      const body = await readBody(req);
      if (!body || typeof body.cmd !== 'string') {
        return sendJson(res, 400, { ok: false, error: '缺少日志内容' });
      }
      await log.append({ t: body.t, cmd: body.cmd, badge: body.badge, out: body.out }, body.date);
      return sendJson(res, 200, { ok: true });
    }
    // 读取某一天的日志
    if (req.method === 'GET' && p === '/api/log/list') {
      const date = (url.searchParams.get('date') || '').trim() || log.today();
      try {
        return sendJson(res, 200, { ok: true, date, entries: log.list(date) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
    }
    // 列出已有日志日期
    if (req.method === 'GET' && p === '/api/log/dates') {
      return sendJson(res, 200, { ok: true, dates: log.dates() });
    }

    // ---- 连接配置（脱敏）----
    if (req.method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, { ok: true, config: ssh.maskConfig(ssh.DEFAULT_CONFIG) });
    }

    // ---- 连接状态 ----
    if (req.method === 'GET' && p === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        connected: !!ssh.conn,
        conn: ssh.connInfo ? ssh.maskConfig(ssh.connInfo) : null,
      });
    }

    // ---- 连接 ----
    if (req.method === 'POST' && p === '/api/connect') {
      const body = await readBody(req);
      const cfg = await ssh.connect(body);
      let home = '~';
      try {
        const r = await ssh.execCommand('echo $HOME');
        if (r && r.stdout) home = r.stdout.trim().split('\n').pop() || '~';
      } catch (e) { /* ignore */ }
      // 预热 HDFS 客户端（连接成功后）
      hdfs.warmupHdfs();
      return sendJson(res, 200, { ok: true, config: cfg, home });
    }

    // ---- 断开 ----
    if (req.method === 'POST' && p === '/api/disconnect') {
      ssh.disconnect();
      return sendJson(res, 200, { ok: true });
    }

    // ---- 执行命令 ----
    if (req.method === 'POST' && p === '/api/exec') {
      const body = await readBody(req);
      if (!body.cmd || typeof body.cmd !== 'string') {
        return sendJson(res, 400, { ok: false, error: '缺少命令内容' });
      }
      // 危险命令需要前端确认标记（删除类）
      const isDanger = /\brm\b/.test(body.cmd);
      if (isDanger && body.confirmed !== true) {
        return sendJson(res, 409, {
          ok: false,
          needConfirm: true,
          error: '删除类命令需要确认',
        });
      }
      const r = await ssh.execCommand(body.cmd, body.timeout);
      return sendJson(res, 200, { ok: true, ...r });
    }

    // ---- 目录列表 ----
    if (req.method === 'POST' && p === '/api/sftp/list') {
      const body = await readBody(req);
      const target = ssh.expandTilde(body.path || '~');
      const abs = await sftp.sftpRealpath(target);
      const items = await sftp.sftpList(abs);
      return sendJson(res, 200, { ok: true, path: abs, items });
    }

    // ---- 文件下载 ----
    if (req.method === 'GET' && p === '/api/sftp/download') {
      const filePath = ssh.expandTilde(url.searchParams.get('path') || '');
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('缺少 path 参数');
      }
      if (!ssh.conn) {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('尚未连接服务器，请先在工作台点击【连接】');
      }
      const fileName = filePath.split('/').filter(Boolean).pop() || 'download.bin';
      return sftp.withSftp((sftpInst, resolve, reject) => {
        sftpInst.stat(filePath, (statErr, st) => {
          if (statErr || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('文件不存在或不是普通文件：' + filePath);
            return resolve();
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': st.size,
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fileName),
          });
          const rs = sftpInst.createReadStream(filePath);
          rs.on('error', () => { try { res.end(); } catch (e) { /* ignore */ } });
          rs.pipe(res);
          rs.on('end', () => resolve());
        });
      }).catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(String(err.message || err));
        } catch (e) { /* ignore */ }
      });
    }

    // ---- HDFS 目录列表 ----
    if (req.method === 'POST' && p === '/api/hdfs/list') {
      const body = await readBody(req);
      let target = String(body.path || '/').trim() || '/';
      if (!target.startsWith('/')) {
        return sendJson(res, 200, { ok: false, error: 'HDFS 路径必须以 / 开头（例如 /apps）' });
      }
      if (!ssh.conn) {
        return sendJson(res, 200, { ok: false, error: '尚未连接服务器：请先点击右上角【连接】按钮' });
      }
      const items = await hdfs.hdfsList(target);
      return sendJson(res, 200, { ok: true, path: target, items });
    }

    // ---- HDFS 文件下载（hadoop fs -cat 流式转发，二进制安全）----
    if (req.method === 'GET' && p === '/api/hdfs/download') {
      const hpath = (url.searchParams.get('path') || '').trim();
      if (!hpath || !hpath.startsWith('/')) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('缺少合法的 HDFS 路径（需以 / 开头）');
      }
      if (!ssh.conn) {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('尚未连接服务器，请先在工作台点击【连接】');
      }
      const fileName = hpath.split('/').filter(Boolean).pop() || 'download.bin';
      await new Promise((resolve) => {
        ssh.conn.exec('hadoop fs -cat ' + hdfs.shellQuote(hpath), (err, stream) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(String(err.message || err));
            return resolve();
          }
          let stderrTxt = '';
          stream.stderr.on('data', (d) => { stderrTxt += d.toString('utf8'); });
          stream.on('data', (d) => {
            if (!res.headersSent) {
              res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fileName),
              });
            }
            res.write(d);
          });
          stream.on('close', (code) => {
            if (!res.headersSent) {
              // 没有任何输出：多半是 cat 失败（路径不存在 / 是目录）
              if (/is a directory/i.test(stderrTxt)) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('该路径是 HDFS 目录，不能直接下载：' + hpath);
              } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end((stderrTxt.trim() || '下载失败（退出码 ' + code + '）') + '\n提示：HDFS 目录可在页面里逐层进入查看。');
              }
            } else {
              res.end();
            }
            resolve();
          });
        });
      }).catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(String(err.message || err));
        } catch (e) { /* ignore */ }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '接口不存在: ' + p }));
  } catch (err) {
    sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  远程服务器管理工作台 已启动');
  console.log('  地址: http://127.0.0.1:' + PORT);
  console.log('  默认服务器: ' + ssh.DEFAULT_CONFIG.host + ':' + ssh.DEFAULT_CONFIG.port + ' (' + ssh.DEFAULT_CONFIG.username + ')');
  console.log('==============================================');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[启动失败] 端口 ' + PORT + ' 已被占用：工作台服务可能已经在运行。');
    console.error('请先关闭已有的服务窗口（或结束 node.exe 进程）后重试。');
    process.exit(1);
  }
  console.error('[服务错误]', err);
});

// 兜底：偶发异常不退出进程，保持工作台可用
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常，服务继续运行]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝，服务继续运行]', reason);
});
