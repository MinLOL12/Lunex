import type {
  ImportFileOutcome,
  IncomingFilePayload,
  LiveSteamAppInfo,
  LunexSettings,
  ManifestInspection,
  RepairInstallOptions,
  RepairInstallResult,
  SystemState,
  ValidationResult,
} from '../types/lunex';

interface LunexElectronBridge {
  isElectron: true;
  getState: () => Promise<SystemState>;
  rescan: () => Promise<SystemState>;
  validateFiles: (files: IncomingFilePayload[]) => Promise<ValidationResult[]>;
  unpackZip: (files: IncomingFilePayload[]) => Promise<IncomingFilePayload[]>;
  repairInstall: (
    appId: string,
    options?: RepairInstallOptions
  ) => Promise<RepairInstallResult>;
  checkLiveAppInfo: (
    appId: string
  ) => Promise<{ liveInfo: LiveSteamAppInfo; state: SystemState }>;
  launchSteamInstall: (appId: string) => Promise<boolean>;
  openSteamConsole: () => Promise<boolean>;
  importFiles: (
    files: IncomingFilePayload[],
    options?: { allowReplaceDuplicates?: boolean; syncLuaDirectives?: boolean }
  ) => Promise<{ outcomes: ImportFileOutcome[]; state: SystemState }>;
  associateManifest: (filePath: string, appId: string) => Promise<SystemState>;
  deleteManifest: (filePath: string) => Promise<SystemState>;
  restoreBackup: (backupId: string) => Promise<SystemState>;
  inspectManifest: (filePath: string) => Promise<ManifestInspection>;
  addManualGame: (appId: string, customName?: string) => Promise<SystemState>;
  removeManualGame: (appId: string) => Promise<SystemState>;
  updateSettings: (partial: Partial<LunexSettings>) => Promise<SystemState>;
  clearOperations: () => Promise<SystemState>;
  selectDirectory: (defaultPath?: string) => Promise<string | null>;
  openPath: (targetPath: string) => Promise<boolean>;
  windowControl: (action: 'minimize' | 'maximize' | 'close') => Promise<void>;
}

declare global {
  interface Window {
    lunexElectron?: LunexElectronBridge;
  }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const isDesktopElectron = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.lunexElectron?.isElectron);

export const lunexClient = {
  getState(): Promise<SystemState> {
    if (window.lunexElectron) return window.lunexElectron.getState();
    return apiFetch<SystemState>('/api/state');
  },

  rescan(): Promise<SystemState> {
    if (window.lunexElectron) return window.lunexElectron.rescan();
    return apiFetch<SystemState>('/api/rescan', { method: 'POST' });
  },

  validateFiles(files: IncomingFilePayload[]): Promise<ValidationResult[]> {
    if (window.lunexElectron) return window.lunexElectron.validateFiles(files);
    return apiFetch<ValidationResult[]>('/api/validate', {
      method: 'POST',
      body: JSON.stringify({ files }),
    });
  },

  unpackZip(files: IncomingFilePayload[]): Promise<IncomingFilePayload[]> {
    if (window.lunexElectron) return window.lunexElectron.unpackZip(files);
    return apiFetch<IncomingFilePayload[]>('/api/unpack-zip', {
      method: 'POST',
      body: JSON.stringify({ files }),
    });
  },

  repairInstall(
    appId: string,
    options?: RepairInstallOptions
  ): Promise<RepairInstallResult> {
    if (window.lunexElectron) {
      return window.lunexElectron.repairInstall(appId, options);
    }
    return apiFetch<RepairInstallResult>('/api/repair-install', {
      method: 'POST',
      body: JSON.stringify({ appId, options }),
    });
  },

  checkLiveAppInfo(
    appId: string
  ): Promise<{ liveInfo: LiveSteamAppInfo; state: SystemState }> {
    if (window.lunexElectron) {
      return window.lunexElectron.checkLiveAppInfo(appId);
    }
    return apiFetch<{ liveInfo: LiveSteamAppInfo; state: SystemState }>(
      '/api/live-app-info',
      {
        method: 'POST',
        body: JSON.stringify({ appId }),
      }
    );
  },

  async launchSteamInstall(appId: string): Promise<boolean> {
    if (window.lunexElectron) {
      return window.lunexElectron.launchSteamInstall(appId);
    }
    if (typeof window !== 'undefined') {
      window.open(`steam://install/${appId}`, '_self');
      return true;
    }
    return false;
  },

  async openSteamConsole(): Promise<boolean> {
    if (window.lunexElectron) {
      return window.lunexElectron.openSteamConsole();
    }
    if (typeof window !== 'undefined') {
      window.open('steam://open/console', '_self');
      return true;
    }
    return false;
  },

  importFiles(
    files: IncomingFilePayload[],
    options?: { allowReplaceDuplicates?: boolean; syncLuaDirectives?: boolean }
  ): Promise<{ outcomes: ImportFileOutcome[]; state: SystemState }> {
    if (window.lunexElectron) {
      return window.lunexElectron.importFiles(files, options);
    }
    return apiFetch<{ outcomes: ImportFileOutcome[]; state: SystemState }>(
      '/api/import',
      {
        method: 'POST',
        body: JSON.stringify({ files, options }),
      }
    );
  },

  associateManifest(filePath: string, appId: string): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.associateManifest(filePath, appId);
    }
    return apiFetch<SystemState>('/api/associate', {
      method: 'POST',
      body: JSON.stringify({ filePath, appId }),
    });
  },

  deleteManifest(filePath: string): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.deleteManifest(filePath);
    }
    return apiFetch<SystemState>('/api/delete-manifest', {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    });
  },

  restoreBackup(backupId: string): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.restoreBackup(backupId);
    }
    return apiFetch<SystemState>('/api/restore-backup', {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    });
  },

  inspectManifest(filePath: string): Promise<ManifestInspection> {
    if (window.lunexElectron) {
      return window.lunexElectron.inspectManifest(filePath);
    }
    return apiFetch<ManifestInspection>('/api/inspect-manifest', {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    });
  },

  addManualGame(appId: string, customName?: string): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.addManualGame(appId, customName);
    }
    return apiFetch<SystemState>('/api/games/manual', {
      method: 'POST',
      body: JSON.stringify({ appId, customName }),
    });
  },

  removeManualGame(appId: string): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.removeManualGame(appId);
    }
    return apiFetch<SystemState>('/api/games/manual', {
      method: 'DELETE',
      body: JSON.stringify({ appId }),
    });
  },

  updateSettings(partial: Partial<LunexSettings>): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.updateSettings(partial);
    }
    return apiFetch<SystemState>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(partial),
    });
  },

  clearOperations(): Promise<SystemState> {
    if (window.lunexElectron) {
      return window.lunexElectron.clearOperations();
    }
    return apiFetch<SystemState>('/api/operations/clear', {
      method: 'POST',
    });
  },

  async selectDirectory(defaultPath?: string): Promise<string | null> {
    if (window.lunexElectron) {
      return window.lunexElectron.selectDirectory(defaultPath);
    }
    return null;
  },

  async openPath(targetPath: string): Promise<boolean> {
    if (window.lunexElectron) {
      return window.lunexElectron.openPath(targetPath);
    }
    return false;
  },

  windowControl(action: 'minimize' | 'maximize' | 'close'): void {
    window.lunexElectron?.windowControl(action);
  },

  async getSamplePacks(): Promise<
    { label: string; description: string; files: IncomingFilePayload[] }[]
  > {
    if (window.lunexElectron) return [];
    const data = await apiFetch<{
      samples: {
        label: string;
        description: string;
        files: IncomingFilePayload[];
      }[];
    }>('/api/sample-files');
    return data.samples;
  },
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
