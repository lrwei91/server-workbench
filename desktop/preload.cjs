'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('workbenchDesktop', {
  loginDcos: () => ipcRenderer.invoke('dcos:login'),
});
