'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// 使用 npm 安装的同版本 Electron；先下载再复制，避免 Windows 扫描器锁住临时解压目录的 rename。
const electronDist = path.dirname(require('electron'));
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.cjs', `--config.electronDist=${electronDist}`, '--win', '--x64', '--publish', 'never', ...process.argv.slice(2)], { cwd: path.join(__dirname, '..'), stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
