/** Structured SFTP operations with a reused channel. */
'use strict';

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
        mtime: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : '',
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

module.exports = { getSftp, withSftp, sftpList, sftpRealpath, sftpStat, sftpMkdir, sftpTouch, sftpDelete, sftpPreview };
