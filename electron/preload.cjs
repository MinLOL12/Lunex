const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lunexElectron', {
  isElectron: true,
  getState: () => ipcRenderer.invoke('lunex:getState'),
  rescan: () => ipcRenderer.invoke('lunex:rescan'),
  validateFiles: (files) => ipcRenderer.invoke('lunex:validateFiles', files),
  unpackZip: (files) => ipcRenderer.invoke('lunex:unpackZip', files),
  repairInstall: (appId, options) =>
    ipcRenderer.invoke('lunex:repairInstall', appId, options),
  checkLiveAppInfo: (appId) =>
    ipcRenderer.invoke('lunex:checkLiveAppInfo', appId),
  launchSteamInstall: (appId) =>
    ipcRenderer.invoke('lunex:launchSteamInstall', appId),
  openSteamConsole: () => ipcRenderer.invoke('lunex:openSteamConsole'),
  importFiles: (files, options) =>
    ipcRenderer.invoke('lunex:importFiles', files, options),
  associateManifest: (filePath, appId) =>
    ipcRenderer.invoke('lunex:associateManifest', filePath, appId),
  deleteManifest: (filePath) =>
    ipcRenderer.invoke('lunex:deleteManifest', filePath),
  restoreBackup: (backupId) =>
    ipcRenderer.invoke('lunex:restoreBackup', backupId),
  inspectManifest: (filePath) =>
    ipcRenderer.invoke('lunex:inspectManifest', filePath),
  addManualGame: (appId, customName) =>
    ipcRenderer.invoke('lunex:addManualGame', appId, customName),
  removeManualGame: (appId) =>
    ipcRenderer.invoke('lunex:removeManualGame', appId),
  updateSettings: (partial) =>
    ipcRenderer.invoke('lunex:updateSettings', partial),
  clearOperations: () => ipcRenderer.invoke('lunex:clearOperations'),
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('lunex:selectDirectory', defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke('lunex:openPath', targetPath),
  windowControl: (action) => ipcRenderer.invoke('lunex:windowControl', action),
});
