import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  History,
  Monitor,
  RotateCcw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { isDesktopElectron, lunexClient } from '../lib/client';
import type { DirectoryStatus, LunexSettings } from '../types/lunex';

interface SettingsViewProps {
  settings: LunexSettings;
  directories: {
    steam: DirectoryStatus;
    lua: DirectoryStatus;
    manifest: DirectoryStatus;
    backup: DirectoryStatus;
  };
  platform: string;
  backupCount: number;
  onSaveSettings: (partial: Partial<LunexSettings>) => Promise<void>;
  onOpenBackups: () => void;
}

export function SettingsView({
  settings,
  directories,
  platform,
  backupCount,
  onSaveSettings,
  onOpenBackups,
}: SettingsViewProps) {
  const [steamPath, setSteamPath] = useState(settings.steamPath);
  const [customLuaPath, setCustomLuaPath] = useState(settings.customLuaPath);
  const [customManifestPath, setCustomManifestPath] = useState(
    settings.customManifestPath
  );
  const [customBackupPath, setCustomBackupPath] = useState(
    settings.customBackupPath
  );
  const [autoBackup, setAutoBackup] = useState(settings.autoBackup);
  const [launchWithWindows, setLaunchWithWindows] = useState(
    settings.launchWithWindows
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSteamPath(settings.steamPath);
    setCustomLuaPath(settings.customLuaPath);
    setCustomManifestPath(settings.customManifestPath);
    setCustomBackupPath(settings.customBackupPath);
    setAutoBackup(settings.autoBackup);
    setLaunchWithWindows(settings.launchWithWindows);
  }, [settings]);

  const isDirty =
    steamPath !== settings.steamPath ||
    customLuaPath !== settings.customLuaPath ||
    customManifestPath !== settings.customManifestPath ||
    customBackupPath !== settings.customBackupPath ||
    autoBackup !== settings.autoBackup ||
    launchWithWindows !== settings.launchWithWindows;

  const handleBrowse = async (
    current: string,
    fallback: string,
    setter: (v: string) => void
  ) => {
    const picked = await lunexClient.selectDirectory(current || fallback);
    if (picked) setter(picked);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings({
        steamPath,
        customLuaPath,
        customManifestPath,
        customBackupPath,
        autoBackup,
        launchWithWindows,
      });
    } finally {
      setSaving(false);
    }
  };

  const renderDirStatus = (dir: DirectoryStatus) => (
    <div className="flex items-center gap-2 text-[11px] mt-1.5">
      {dir.exists && dir.writable ? (
        <span className="inline-flex items-center gap-1 text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Active & Writable</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>{dir.exists ? 'Read-only directory' : 'Directory not found'}</span>
        </span>
      )}
      <span className="text-slate-600">·</span>
      <span className="font-mono text-slate-400 truncate" title={dir.path}>
        Effective: {dir.path}
      </span>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <form
        onSubmit={handleSave}
        className="max-w-3xl mx-auto p-6 space-y-6 pb-16"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-100 tracking-tight">
              Settings
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Configure Steam paths, custom manifest directories, automatic backups, and startup behavior
            </p>
          </div>

          <button
            type="submit"
            disabled={!isDirty || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white transition-colors cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save Changes'}</span>
          </button>
        </div>

        {/* Section 1: Directories */}
        <section className="rounded-2xl bg-[#121621] border border-white/[0.07] p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Steam & Manifest Directories
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Leave fields blank to use Lunex&apos;s automatic Steam directory detection
            </p>
          </div>

          {/* Custom Steam Path */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="setting-steam-path"
                className="text-xs font-medium text-slate-200"
              >
                Custom Steam Installation Path
              </label>
              {steamPath && (
                <button
                  type="button"
                  onClick={() => setSteamPath('')}
                  className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Use Auto-Detected
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="setting-steam-path"
                type="text"
                value={steamPath}
                onChange={(e) => setSteamPath(e.target.value)}
                placeholder={`Auto-detected: ${directories.steam.autoDetectedPath}`}
                className="flex-1 px-3.5 py-2 rounded-xl bg-[#0B0E16] border border-white/[0.08] focus:border-indigo-500/60 focus:outline-none text-xs font-mono text-slate-100 placeholder:text-slate-500"
              />
              {isDesktopElectron() && (
                <button
                  type="button"
                  onClick={() =>
                    void handleBrowse(
                      steamPath,
                      directories.steam.path,
                      setSteamPath
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 border border-white/[0.07] transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse
                </button>
              )}
            </div>
            {renderDirStatus(directories.steam)}
          </div>

          {/* Custom Lua Path */}
          <div className="pt-3 border-t border-white/[0.05]">
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="setting-lua-path"
                className="text-xs font-medium text-slate-200"
              >
                Custom Lua Plugin Directory (<span className="font-mono text-indigo-300">.lua</span>)
              </label>
              {customLuaPath && (
                <button
                  type="button"
                  onClick={() => setCustomLuaPath('')}
                  className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset to Default (stplug-in)
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="setting-lua-path"
                type="text"
                value={customLuaPath}
                onChange={(e) => setCustomLuaPath(e.target.value)}
                placeholder={`Default: ${directories.lua.autoDetectedPath}`}
                className="flex-1 px-3.5 py-2 rounded-xl bg-[#0B0E16] border border-white/[0.08] focus:border-indigo-500/60 focus:outline-none text-xs font-mono text-slate-100 placeholder:text-slate-500"
              />
              {isDesktopElectron() && (
                <button
                  type="button"
                  onClick={() =>
                    void handleBrowse(
                      customLuaPath,
                      directories.lua.path,
                      setCustomLuaPath
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 border border-white/[0.07] transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse
                </button>
              )}
            </div>
            {renderDirStatus(directories.lua)}
          </div>

          {/* Custom Manifest (Depotcache) Path */}
          <div className="pt-3 border-t border-white/[0.05]">
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="setting-manifest-path"
                className="text-xs font-medium text-slate-200"
              >
                Custom Manifest Directory (<span className="font-mono text-sky-300">.manifest</span>)
              </label>
              {customManifestPath && (
                <button
                  type="button"
                  onClick={() => setCustomManifestPath('')}
                  className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset to Default (depotcache)
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="setting-manifest-path"
                type="text"
                value={customManifestPath}
                onChange={(e) => setCustomManifestPath(e.target.value)}
                placeholder={`Default: ${directories.manifest.autoDetectedPath}`}
                className="flex-1 px-3.5 py-2 rounded-xl bg-[#0B0E16] border border-white/[0.08] focus:border-indigo-500/60 focus:outline-none text-xs font-mono text-slate-100 placeholder:text-slate-500"
              />
              {isDesktopElectron() && (
                <button
                  type="button"
                  onClick={() =>
                    void handleBrowse(
                      customManifestPath,
                      directories.manifest.path,
                      setCustomManifestPath
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 border border-white/[0.07] transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse
                </button>
              )}
            </div>
            {renderDirStatus(directories.manifest)}
          </div>
        </section>

        {/* Section 2: Automatic File Backups */}
        <section className="rounded-2xl bg-[#121621] border border-white/[0.07] p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/12 border border-emerald-500/25 text-emerald-400 mt-0.5">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Automatic File Backups
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                  Automatically archive existing <span className="font-mono">.lua</span> and{' '}
                  <span className="font-mono">.manifest</span> files before replacing or deleting them.
                </p>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={autoBackup}
              onClick={() => setAutoBackup((v) => !v)}
              className={clsx(
                'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 cursor-pointer',
                autoBackup ? 'bg-indigo-500' : 'bg-slate-700'
              )}
            >
              <span
                className={clsx(
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200',
                  autoBackup ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
          </div>

          <div className="pt-3 border-t border-white/[0.05] flex flex-wrap items-center justify-between gap-3">
            <div className="flex-1 min-w-[220px]">
              <label
                htmlFor="setting-backup-path"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Backup Archive Directory
              </label>
              <input
                id="setting-backup-path"
                type="text"
                value={customBackupPath}
                onChange={(e) => setCustomBackupPath(e.target.value)}
                placeholder={`Default: ${directories.backup.autoDetectedPath}`}
                className="w-full px-3.5 py-2 rounded-xl bg-[#0B0E16] border border-white/[0.08] focus:border-indigo-500/60 focus:outline-none text-xs font-mono text-slate-100 placeholder:text-slate-500"
              />
            </div>

            <button
              type="button"
              onClick={onOpenBackups}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 border border-white/[0.07] transition-colors mt-5 cursor-pointer"
            >
              <History className="w-3.5 h-3.5 text-emerald-400" />
              <span>Manage Backups ({backupCount})</span>
            </button>
          </div>
        </section>

        {/* Section 3: Windows Startup */}
        <section className="rounded-2xl bg-[#121621] border border-white/[0.07] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-sky-500/12 border border-sky-500/25 text-sky-400 mt-0.5">
                <Monitor className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Launch with Windows
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                  Automatically start Lunex when signing in to Windows so your library and manifests stay ready.
                </p>
                {platform !== 'win32' && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    Preference is saved now and registers with Windows Startup automatically when running the Windows desktop build.
                  </p>
                )}
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={launchWithWindows}
              onClick={() => setLaunchWithWindows((v) => !v)}
              className={clsx(
                'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 cursor-pointer',
                launchWithWindows ? 'bg-indigo-500' : 'bg-slate-700'
              )}
            >
              <span
                className={clsx(
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200',
                  launchWithWindows ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
