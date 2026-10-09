'use strict';
module.exports = {
  appId: 'com.lrwei.serverworkbench',
  productName: 'Server Workbench',
  artifactName: 'Server-Workbench-${version}-${arch}-Setup.${ext}',
  directories: { output: 'dist', buildResources: 'desktop/resources' },
  asar: true,
  files: ['desktop/*.cjs', 'server/**/*', 'public/**/*', 'shared/**/*', 'config.example.js', '.env.example', 'package.json', '!desktop/build-*.cjs', '!**/__pycache__/**', '!node_modules/cpu-features/**/*', '!node_modules/ssh2/lib/protocol/crypto/build/**/*'],
  extraResources: [{ from: 'build/python/cdr-service', to: 'cdr-service', filter: ['**/*'] }],
  // ssh2 的 CPU 探测/加密 native addon 是可选加速，使用其内置 JS/WASM 实现，避免 Node/Electron ABI 混用。
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], verifyUpdateCodeSignature: true },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true },
  publish: [{ provider: 'github', owner: 'lrwei91', repo: 'server-workbench', releaseType: 'draft' }],
  electronUpdaterCompatibility: '>=2.16',
};
