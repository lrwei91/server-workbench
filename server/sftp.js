/** Structured SFTP operations with a reused channel. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ssh = require('./ssh');

let sftpChannel = null;
let sftpConnRef = null;

function openSftpOnce() {
  return new Promise((resolve, reject) => {
    const connection = ssh.conn;
    if (!connection) return reject(new Error('尚未连接服务器：请先点击右上角【连接】按钮'));
    connection.sftp((err, channel) => {
      if (err) return reject(err);
      sftpChannel = channel;
      sftpConnRef = connection;
      channel.on('close', () => { if (sftpChannel === channel) { sftpChannel = null; sftpConnRef = null; } });
      channel.on('error', () => { if (sftpChannel === channel) { sftpChannel = null; sftpConnRef = null; } });
      resolve(channel);
    });
  });
}

async function getSftp() {
  if (sftpChannel && sftpConnRef !== ssh.conn) { sftpChannel = null; sftpConnRef = null; }
  if (sftpChannel) return sftpChannel;
  try { return await openSftpOnce(); }
  catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    sftpChannel = null;
    try { return await openSftpOnce(); }
    catch (second) { throw new Error('SFTP 通道建立失败：' + (second?.message || first?.message || second)); }
  }
}

async function withSftp(operation, { retry = true } = {}) {
  const channel = await getSftp();
  try { return await operation(channel); }
  catch (error) {
    if (!retry) throw error;
    sftpChannel = null;
    return operation(await getSftp());
  }
}

function call(channel, method, ...args) {
  return new Promise((resolve, reject) => {
    channel[method](...args, (err, result) => err ? reject(err) : resolve(result));
  });
}

function utc8IsoFromEpochSeconds(seconds) {
  return new Date(Number(seconds) * 1000 + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

function sftpList(remotePath) {
  return withSftp(async (sftp) => {
    const st = await call(sftp, 'stat', remotePath);
    if (!st.isDirectory()) throw new Error('该路径不是文件夹：' + remotePath);
    const list = await call(sftp, 'readdir', remotePath);
    return list.map((entry) => {
      const attrs = entry.attrs || {};
      const mode = attrs.mode == null ? 0 : attrs.mode;
      return {
        name: entry.filename,
        isDir: (mode & 0o170000) === 0o040000 || (entry.longname || '')[0] === 'd',
        isLink: (entry.longname || '')[0] === 'l',
        size: Number(attrs.size) || 0,
        mtime: attrs.mtime ? utc8IsoFromEpochSeconds(attrs.mtime) : '',
        longname: entry.longname || '',
      };
    }).sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name));
  }).catch((error) => { throw new Error('读取目录失败：' + (error?.message || error)); });
}

function sftpRealpath(remotePath) {
  return withSftp(async (sftp) => {
    try { return await call(sftp, 'realpath', remotePath); }
    catch (_) { return remotePath; }
  });
}

function sftpStat(remotePath) { return withSftp((sftp) => call(sftp, 'stat', remotePath)); }

function sftpMkdir(remotePath) { return withSftp((sftp) => call(sftp, 'mkdir', remotePath, { mode: 0o755 }), { retry: false }); }
// 独占创建，避免“新建文件”误把已有文件截断。
function sftpTouch(remotePath) { return withSftp((sftp) => call(sftp, 'open', remotePath, 'wx').then((handle) => call(sftp, 'close', handle)), { retry: false }); }
function sftpDelete(remotePath, kind = 'file') {
  const method = kind === 'dir' ? 'rmdir' : 'unlink';
  return withSftp((sftp) => call(sftp, method, remotePath), { retry: false });
}

async function sftpPreview(remotePath, maxBytes = 256 * 1024) {
  const limit = Math.max(1024, Math.min(Number(maxBytes) || 256 * 1024, 2 * 1024 * 1024));
  return withSftp((sftp) => new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(remotePath, { start: 0, end: limit - 1 });
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; if (size >= limit) stream.destroy(); });
    stream.on('error', reject);
    stream.on('close', () => resolve({ text: Buffer.concat(chunks).subarray(0, limit).toString('utf8'), truncated: size >= limit, bytes: Math.min(size, limit) }));
  }));
}

// 把内存中的文件内容通过 SFTP 写入远端目录（先落本地临时文件再 fastPut，兼容大文件）
async function sftpUpload(remoteDir, fileName, buffer) {
  const dir = await sftpRealpath(remoteDir);
  const safe = String(fileName || '').replace(/[\\/]/g, '').trim();
  if (!safe) throw new Error('文件名不合法：不能包含路径分隔符且不能为空');
  const remotePath = `${dir.replace(/\/+$/, '')}/${safe}`;
  const tmpPath = path.join(os.tmpdir(), `wb-upload-${crypto.randomBytes(6).toString('hex')}-${safe}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    await withSftp((sftp) => new Promise((resolve, reject) => {
      sftp.fastPut(tmpPath, remotePath, (err) => err ? reject(err) : resolve());
    }), { retry: false });
    return { remotePath, fileName: safe, size: buffer.length };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = { getSftp, withSftp, sftpList, sftpRealpath, sftpStat, sftpMkdir, sftpTouch, sftpDelete, sftpPreview, sftpUpload, utc8IsoFromEpochSeconds };
