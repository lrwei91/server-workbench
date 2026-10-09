'use strict';
const { notesText } = require('./runtime.cjs');

// 独立于 renderer，便于测试事件状态与安装时机。
function configureUpdates({ updater, packaged, notify, confirm, install, progress, log }) {
  let checking = false;
  let downloading = false;
  let downloaded = false;
  let manual = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false; // 普通退出不自动安装，先保护 CDR 会话。
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('error', (error) => { checking = false; downloading = false; progress(-1); log(error); });
  updater.on('download-progress', (info) => progress(info.percent / 100));
  updater.on('update-downloaded', () => { downloaded = true; downloading = false; progress(-1); });
  async function installDownloaded() {
    if (await confirm('更新已下载', '现在重启并安装更新？未导出的话单会另行提示。')) await install();
  }
  async function check(isManual = false) {
    if (!packaged) { if (isManual) await notify('开发模式', '更新检查仅在安装版启用。'); return; }
    if (checking || downloading) { if (isManual) await notify('更新处理中', '请等待当前检查或下载完成。'); return; }
    if (downloaded) { if (isManual) await installDownloaded(); return; }
    checking = true; manual = isManual;
    try {
      const result = await updater.checkForUpdates();
      if (!result || !result.cancellationToken) { if (manual) await notify('已是最新版本', '当前没有可用更新。'); return; }
      const info = result.updateInfo;
      if (!(await confirm(`发现新版本 ${info.version}`, `${notesText(info.releaseNotes)}\n\n下载更新？`))) return;
      downloading = true;
      checking = false;
      await updater.downloadUpdate(result.cancellationToken);
      downloading = false; downloaded = true;
      await installDownloaded();
    } catch (error) {
      checking = false; downloading = false; progress(-1); log(error);
      if (isManual) await notify('更新失败', '请检查 GitHub 连接及更新日志后重试。');
    } finally { checking = false; }
  }
  return { check };
}
module.exports = { configureUpdates };
