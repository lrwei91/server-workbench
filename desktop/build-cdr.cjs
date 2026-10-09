'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('CDR 安装包需在 Windows x64 上构建');
const python = process.env.WORKBENCH_BUILD_PYTHON || 'python';
const root = path.join(__dirname, '..');
const result = spawnSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', 'build/python', '--workpath', 'build/pyinstaller', 'desktop/cdr-service.spec'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
