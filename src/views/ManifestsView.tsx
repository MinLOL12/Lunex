import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileCode2,
  FolderOpen,
  History,
  Layers,
  Search,
  Trash2,
  Upload,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  formatBytes,
  formatRelativeTime,
  isDesktopElectron,
  lunexClient,
} from '../lib/client';
import type {
  DirectoryStatus,
  ManagedManifest,
  SteamGame,
} from '../types/lunex';

interface ManifestsViewProps {
  manifests: ManagedManifest[];
  games: SteamGame[];
  luaDir: DirectoryStatus;
  manifestDir: DirectoryStatus;
  backupCount: number;
  selectedAppIdFilter: string | null;
  onClearAppIdFilter: () => void;
  onSelectAppIdFilter: (appId: string | null) => void;
  onOpenImport: (defaultAppId?: string) => void;
  onOpenBackups: () => void;
  onAssociateManifest: (filePath: string, appId: string) => Promise<void>;
  onDeleteManifest: (filePath: string) => Promise<void>;
  onInspectManifest: (manifest: ManagedManifest) => void;
  onDiagnoseGame: (game: SteamGame) => void;
}

type TypeFilter = 'all' | 'lua' | 'manifest' | 'issues';

export function ManifestsView({
  manifests,
  games,
  luaDir,
  manifestDir,
  backupCount,
  selectedAppIdFilter,
  onClearAppIdFilter,
  onSelectAppIdFilter,
  onOpenImport,
  onOpenBackups,
  onAssociateManifest,
  onDeleteManifest,
  onInspectManifest,
  onDiagnoseGame,
}: ManifestsViewProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [groupByGame, setGroupByGame] = useState(true);

  const luaCount = useMemo(
    () => manifests.filter((m) => m.fileType === 'lua').length,
    [manifests]
  );
  const depotCount = useMemo(
    () => manifests.filter((m) => m.fileType === 'manifest').length,
    [manifests]
  );
  const issuesCount = useMemo(
    () =>
      manifests.filter((m) => !m.isValid || m.isDuplicate || m.isZipWrapped)
        .length,
    [manifests]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return manifests.filter((m) => {
      if (selectedAppIdFilter && m.appId !== selectedAppIdFilter) return false;
      if (typeFilter === 'lua' && m.fileType !== 'lua') return false;
      if (typeFilter === 'manifest' && m.fileType !== 'manifest') return false;
      if (typeFilter === 'issues' && m.isValid && !m.isDuplicate && !m.isZipWrapped)
        return false;

      if (!q) return true;
      return (
        m.fileName.toLowerCase().includes(q) ||
        m.appId.toLowerCase().includes(q) ||
        (m.gameName && m.gameName.toLowerCase().includes(q)) ||
        (m.depotId && m.depotId.includes(q)) ||
        (m.manifestId && m.manifestId.includes(q))
      );
    });
  }, [manifests, query, typeFilter, selectedAppIdFilter]);

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { appId: string; title: string; items: ManagedManifest[] }
    >();
    for (const item of filtered) {
      const key = item.appId || 'unassigned';
      const existing = map.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        const matchedGame = games.find((g) => g.appId === key);
        const title =
          key === 'unassigned'
            ? 'Unassigned Files'
            : matchedGame?.name || item.gameName || `Steam App ${key}`;
        map.set(key, { appId: key, title, items: [item] });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.appId === 'unassigned') return 1;
      if (b.appId === 'unassigned') return -1;
      return a.title.localeCompare(b.title);
    });
  }, [filtered, games]);

  const activeFilterGame = selectedAppIdFilter
    ? games.find((g) => g.appId === selectedAppIdFilter)
    : null;

  const renderManifestRow = (mf: ManagedManifest) => (
    <div
      key={mf.filePath}
      className="group px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-white/[0.025] transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span
          className={clsx(
            'w-9 h-9 rounded-xl flex items-center justify-center border shrink-0 font-mono text-[10px] font-bold uppercase',
            mf.fileType === 'lua'
              ? 'bg-indigo-500/12 text-indigo-300 border-indigo-500/25'
              : 'bg-sky-500/12 text-sky-300 border-sky-500/25'
          )}
        >
          {mf.fileType === 'lua' ? 'LUA' : 'BIN'}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onInspectManifest(mf)}
              className="font-mono text-xs font-semibold text-slate-100 hover:text-indigo-300 truncate transition-colors cursor-pointer"
            >
              {mf.fileName}
            </button>

            {/* Validation / Duplicate Status */}
            {!mf.isValid ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/25">
                <XCircle className="w-3 h-3" />
                Invalid
              </span>
            ) : mf.isZipWrapped ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/25"
                title="ZIP-wrapped .manifest file — Steam requires raw 0x71F617D0 binary"
              >
                <AlertTriangle className="w-3 h-3" />
                ZIP-Wrapped
              </span>
            ) : mf.isDuplicate ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/25"
                title={`Duplicate SHA-256 content of ${mf.duplicateOf}`}
              >
                <AlertTriangle className="w-3 h-3" />
                Duplicate
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3" />
                Verified
              </span>
            )}

            {mf.directivesCount !== undefined && mf.fileType === 'lua' && (
              <span className="text-[10px] font-mono text-slate-400 bg-white/[0.04] px-1.5 py-0.5 rounded">
                {mf.directivesCount} directive{mf.directivesCount === 1 ? '' : 's'}
              </span>
            )}

            {mf.depotId && mf.fileType === 'manifest' && (
              <span className="text-[10px] font-mono text-slate-400 bg-white/[0.04] px-1.5 py-0.5 rounded">
                Depot {mf.depotId}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500 font-mono">
            <span>{formatBytes(mf.sizeBytes)}</span>
            <span>·</span>
            <span>sha256:{mf.sha256.slice(0, 10)}</span>
            <span>·</span>
            <span>{formatRelativeTime(mf.modifiedAt)}</span>
          </div>
        </div>
      </div>

      {/* Right Side: AppID Linker + Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <select
          value={mf.appId}
          onChange={(e) => void onAssociateManifest(mf.filePath, e.target.value)}
          aria-label={`Associate ${mf.fileName} with Steam AppID`}
          className="px-2.5 py-1.5 rounded-lg bg-[#0D1018] border border-white/[0.07] hover:border-white/[0.14] text-xs text-slate-300 focus:border-indigo-500/50 focus:outline-none max-w-[200px] truncate cursor-pointer"
        >
          <option value="unassigned">Unassigned AppID</option>
          {!games.some((g) => g.appId === mf.appId) &&
            mf.appId !== 'unassigned' && (
              <option value={mf.appId}>AppID {mf.appId}</option>
            )}
          {games.map((g) => (
            <option key={g.appId} value={g.appId}>
              {g.name} ({g.appId})
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => onInspectManifest(mf)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.07] border border-transparent hover:border-white/[0.08] transition-colors cursor-pointer"
          title="Inspect file contents & directives"
        >
          <Eye className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => void onDeleteManifest(mf.filePath)}
          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/15 border border-transparent hover:border-rose-500/20 transition-colors cursor-pointer"
          title="Delete manifest file"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-white/[0.06] space-y-4 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-100 tracking-tight">
              Manifest Manager
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {luaCount} Lua script{luaCount === 1 ? '' : 's'} in{' '}
              <span className="font-mono text-slate-300">stplug-in</span> ·{' '}
              {depotCount} depot manifest{depotCount === 1 ? '' : 's'} in{' '}
              <span className="font-mono text-slate-300">depotcache</span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenBackups}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-[#141824] hover:bg-[#1B2131] text-slate-300 border border-white/[0.08] transition-colors cursor-pointer"
            >
              <History className="w-3.5 h-3.5 text-emerald-400" />
              <span>Backups ({backupCount})</span>
            </button>

            <button
              type="button"
              onClick={() => onOpenImport(selectedAppIdFilter || undefined)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import .lua / .manifest</span>
            </button>
          </div>
        </div>

        {/* Directory Status Strip */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          <div className="px-3.5 py-2 rounded-xl bg-[#111520] border border-white/[0.06] flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-indigo-400 font-semibold mr-2">
                Lua Target
              </span>
              <span className="font-mono text-[11px] text-slate-300 truncate">
                {luaDir.path}
              </span>
            </div>
            {isDesktopElectron() && (
              <button
                type="button"
                onClick={() => void lunexClient.openPath(luaDir.path)}
                className="text-slate-400 hover:text-slate-200 shrink-0 cursor-pointer"
                title="Open Lua folder"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="px-3.5 py-2 rounded-xl bg-[#111520] border border-white/[0.06] flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-sky-400 font-semibold mr-2">
                Depot Target
              </span>
              <span className="font-mono text-[11px] text-slate-300 truncate">
                {manifestDir.path}
              </span>
            </div>
            {isDesktopElectron() && (
              <button
                type="button"
                onClick={() => void lunexClient.openPath(manifestDir.path)}
                className="text-slate-400 hover:text-slate-200 shrink-0 cursor-pointer"
                title="Open Depotcache folder"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Search + Filter Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by filename, AppID, depot, or game..."
                className="w-full pl-9 pr-8 py-2 rounded-xl bg-[#111520] border border-white/[0.08] focus:border-indigo-500/50 focus:outline-none text-xs text-slate-100 placeholder:text-slate-500"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {selectedAppIdFilter && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-indigo-500/15 text-indigo-200 border border-indigo-500/30 text-xs shrink-0">
                <span className="font-medium truncate max-w-[140px]">
                  {activeFilterGame
                    ? `${activeFilterGame.name} (${selectedAppIdFilter})`
                    : `AppID ${selectedAppIdFilter}`}
                </span>
                <button
                  type="button"
                  onClick={onClearAppIdFilter}
                  className="hover:text-white cursor-pointer"
                  title="Clear AppID filter"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-xl bg-[#111520] p-1 border border-white/[0.06] text-xs">
              {(
                [
                  { id: 'all', label: `All (${manifests.length})` },
                  { id: 'lua', label: `.lua (${luaCount})` },
                  { id: 'manifest', label: `.manifest (${depotCount})` },
                  { id: 'issues', label: `Issues (${issuesCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setTypeFilter(tab.id)}
                  className={clsx(
                    'px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer',
                    typeFilter === tab.id
                      ? 'bg-indigo-500/20 text-indigo-200'
                      : 'text-slate-400 hover:text-slate-200'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setGroupByGame((v) => !v)}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer',
                groupByGame
                  ? 'bg-indigo-500/15 text-indigo-200 border-indigo-500/25'
                  : 'bg-[#111520] text-slate-400 border-white/[0.06] hover:text-slate-200'
              )}
              title="Group files by associated Steam AppID"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Group by Game</span>
            </button>
          </div>
        </div>
      </div>

      {/* Manifest List */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {filtered.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-[#141824] border border-white/[0.07] flex items-center justify-center text-slate-500 mb-3">
              <FileCode2 className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-slate-200">
              {selectedAppIdFilter
                ? `No manifests linked to AppID ${selectedAppIdFilter} yet`
                : 'No manifests match your filter'}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Drop .lua or .manifest files anywhere in Lunex or click Import below.
            </p>
            <div className="mt-4 flex items-center gap-2">
              {selectedAppIdFilter && (
                <button
                  type="button"
                  onClick={() => onSelectAppIdFilter(null)}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 transition-colors cursor-pointer"
                >
                  Show All Manifests
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpenImport(selectedAppIdFilter || undefined)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Import Files</span>
              </button>
            </div>
          </div>
        ) : groupByGame ? (
          grouped.map((group) => {
            const matchedGame = games.find((g) => g.appId === group.appId);
            const diag = matchedGame?.installDiagnostics;
            return (
              <div
                key={group.appId}
                className="rounded-2xl bg-[#121621] border border-white/[0.07] overflow-hidden"
              >
                <div className="px-4 py-2.5 bg-[#161B28] border-b border-white/[0.06] flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold text-slate-100 truncate">
                      {group.title}
                    </span>
                    {group.appId !== 'unassigned' && (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-300">
                        AppID {group.appId}
                      </span>
                    )}
                    {matchedGame && diag && diag.status !== 'ready' && (
                      <button
                        type="button"
                        onClick={() => onDiagnoseGame(matchedGame)}
                        className={clsx(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors cursor-pointer',
                          diag.status === 'blocked'
                            ? 'bg-rose-500/15 text-rose-200 border-rose-500/30 hover:bg-rose-500/25'
                            : 'bg-amber-500/15 text-amber-200 border-amber-500/30 hover:bg-amber-500/25'
                        )}
                      >
                        <Wrench className="w-3 h-3" />
                        <span>
                          {diag.status === 'blocked' ? 'Fix Install Blockers' : 'Check Setup'}
                        </span>
                      </button>
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">
                    {group.items.length} file{group.items.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="divide-y divide-white/[0.05]">
                  {group.items.map(renderManifestRow)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-2xl bg-[#121621] border border-white/[0.07] divide-y divide-white/[0.05] overflow-hidden">
            {filtered.map(renderManifestRow)}
          </div>
        )}
      </div>
    </div>
  );
}
