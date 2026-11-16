import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LunexManager } from './core/lunexManager.js';
import type {
  IncomingFilePayload,
  LunexSettings,
  RepairInstallOptions,
} from './core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let manager: LunexManager;

function syncWindowsStartup(enabled: boolean): void {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: app.getPath('exe'),
      });
    } catch {
      // Ignore in unpackaged dev environment
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0B0D12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
  if (!app.isPackaged && process.env.ELECTRON_LOAD_DIST !== '1') {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  manager = new LunexManager({
    dataDir: path.join(app.getPath('userData'), 'lunex-data'),
    isElectron: true,
    onLaunchWithWindowsChange: syncWindowsStartup,
  });

  // Sync startup state on boot
  const initialState = manager.getState();
  if (initialState.settings.launchWithWindows) {
    syncWindowsStartup(true);
  }

  ipcMain.handle('lunex:getState', () => manager.getState());
  ipcMain.handle('lunex:rescan', () => manager.rescan());
  ipcMain.handle('lunex:validateFiles', (_e, files: IncomingFilePayload[]) =>
    manager.validateIncomingFiles(files)
  );
  ipcMain.handle('lunex:unpackZip', (_e, files: IncomingFilePayload[]) =>
    manager.unpackZipFiles(files)
  );
  ipcMain.handle(
    'lunex:repairInstall',
    (_e, appId: string, options?: RepairInstallOptions) =>
      manager.repairGameInstall(appId, options)
  );
  ipcMain.handle('lunex:checkLiveAppInfo', (_e, appId: string) =>
    manager.checkLiveAppInfo(appId)
  );
  ipcMain.handle('lunex:launchSteamInstall', async (_e, appId: string) => {
    const cleanId = appId.trim();
    if (!/^\d+$/.test(cleanId)) return false;
    await shell.openExternal(`steam://install/${cleanId}`);
    return true;
  });
  ipcMain.handle('lunex:openSteamConsole', async () => {
    await shell.openExternal('steam://open/console');
    return true;
  });
  ipcMain.handle(
    'lunex:importFiles',
    (
      _e,
      files: IncomingFilePayload[],
      options?: { allowReplaceDuplicates?: boolean; syncLuaDirectives?: boolean }
    ) => manager.importFiles(files, options)
  );
  ipcMain.handle(
    'lunex:associateManifest',
    (_e, filePath: string, appId: string) =>
      manager.associateManifest(filePath, appId)
  );
  ipcMain.handle('lunex:deleteManifest', (_e, filePath: string) =>
    manager.deleteManifest(filePath)
  );
  ipcMain.handle('lunex:restoreBackup', (_e, backupId: string) =>
    manager.restoreBackup(backupId)
  );
  ipcMain.handle('lunex:inspectManifest', (_e, filePath: string) =>
    manager.inspectManifest(filePath)
  );
  ipcMain.handle(
    'lunex:addManualGame',
    (_e, appId: string, customName?: string) =>
      manager.addManualGame(appId, customName)
  );
  ipcMain.handle('lunex:removeManualGame', (_e, appId: string) =>
    manager.removeManualGame(appId)
  );
  ipcMain.handle('lunex:updateSettings', (_e, partial: Partial<LunexSettings>) =>
    manager.updateSettings(partial)
  );
  ipcMain.handle('lunex:clearOperations', () => manager.clearOperations());

  ipcMain.handle('lunex:selectDirectory', async (_e, defaultPath?: string) => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Directory',
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('lunex:openPath', async (_e, targetPath: string) => {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      await shell.openPath(targetPath);
    } else {
      shell.showItemInFolder(targetPath);
    }
    return true;
  });

  ipcMain.handle(
    'lunex:windowControl',
    (_e, action: 'minimize' | 'maximize' | 'close') => {
      if (!mainWindow) return;
      if (action === 'minimize') mainWindow.minimize();
      else if (action === 'maximize') {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      } else if (action === 'close') mainWindow.close();
    }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
