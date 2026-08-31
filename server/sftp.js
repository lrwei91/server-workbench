/**
 * SFTP 文件浏览（通道复用 + 列目录 + 下载）
 *
 * 关键：复用单一 SFTP 通道，避免每次 conn.sftp() 新开 channel
 * 耗尽服务器 sshd MaxSessions 上限（"Channel open failure"）。
 */
'use strict';

const ssh = require('./ssh');

let sftpChannel = null; // 复用的 SFTP 通道（每次 conn.sftp() 都会在服务器开新 channel，
                        // 用完不关会耗尽 sshd MaxSessions 上限，导致 Channel open failure）
let sftpConnRef = null; // 通道所属的连接对象引用，用于判断通道是否随连接失效

function openSftpOnce() {
  return new Promise((resolve, reject) => {
    const conn = ssh.conn;
    if (!conn) return reject(new Error('尚未连接服务器：请先点击右上角【连接】按钮'));
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      // 通道异常/被服务器关闭时置空，下次调用自动重建
      sftp.on('close', () => { if (sftpChannel === sftp) sftpChannel = null; });
      sftp.on('error', () => {
        if (sftpChannel === sftp) sftpChannel = null;
        try { sftp.end(); } catch (e) { /* ignore */ }
      });
      sftpChannel = sftp;
      sftpConnRef = conn;
      resolve(sftp);
    });
  });
}

async function getSftp() {
  // 通道随连接失效（断开/重连）时丢弃重建
  if (sftpChannel && sftpConnRef !== ssh.conn) {
    sftpChannel = null;
    sftpConnRef = null;
  }
  if (sftpChannel) return sftpChannel;
  if (!ssh.conn) throw new Error('尚未连接服务器：请先点击右上角【连接】按钮');
  // 服务器 MaxSessions 有限，偶发 "Channel open failure"：等待后重试一次
  try {
    return await openSftpOnce();
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 600));
    sftpChannel = null;
    try {
      return await openSftpOnce();
    } catch (secondErr) {
      throw new Error('SFTP 通道建立失败：' + ((secondErr && secondErr.message) || secondErr) +
        '。已自动重试仍失败，请点击右上角【断开】后重新【连接】');
    }
  }
}

async function withSftp(fn) {
  const sftp = await getSftp();
  try {
    return await new Promise((resolve, reject) => { fn(sftp, resolve, reject); });
  } catch (e) {
    // 复用的通道可能已失效（服务器端已关闭但未触发本地事件）：重开一次再试
    sftpChannel = null;
    const sftp2 = await getSftp();
    return new Promise((resolve, reject) => { fn(sftp2, resolve, reject); });
  }
}

function sftpList(remotePath) {
  return withSftp((sftp, resolve, reject) => {
    sftp.stat(remotePath, (statErr, st) => {
      if (statErr) {
        return reject(new Error('读取失败：路径不存在或无权限（' + (statErr.message || statErr) + '）'));
      }
      if (!st.isDirectory()) {
        return reject(new Error('该路径不是文件夹：' + remotePath));
      }
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(new Error('读取目录失败：' + (err.message || err)));
        const items = list.map((e) => {
          const a = e.attrs || {};
          const isDir = a.mode != null ? ((a.mode & 0o170000) === 0o040000) : (a.longname || '')[0] === 'd';
          const isLink = (a.longname || '')[0] === 'l';
          return {
            name: e.filename,
            isDir: !!isDir,
            isLink: !!isLink,
            size: a.size || 0,
            mtime: a.mtime ? new Date(a.mtime * 1000).toISOString() : '',
            longname: a.longname || '',
          };
        });
        items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
        resolve(items);
      });
    });
  });
}

function sftpRealpath(remotePath) {
  return withSftp((sftp, resolve, reject) => {
    sftp.realpath(remotePath, (err, abs) => {
      if (err) return resolve(remotePath); // 解析失败时退回原路径
      resolve(abs);
    });
  });
}

module.exports = {
  getSftp,
  withSftp,
  sftpList,
  sftpRealpath,
};
