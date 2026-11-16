import clsx from 'clsx';
import {
  Gamepad2,
  Plus,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { GameCard } from '../components/GameCard';
import type { SteamGame } from '../types/lunex';

interface LibraryViewProps {
  games: SteamGame[];
  onOpenAddModal: () => void;
  onQuickAddAppId: (appId: string) => Promise<void>;
  onManageManifests: (appId: string) => void;
  onImportForGame: (appId: string) => void;
  onRemoveManualGame: (appId: string) => void;
  onDiagnoseGame: (game: SteamGame) => void;
}

type StatusFilter = 'all' | 'installed' | 'manifest' | 'manual';
type SortMode = 'status' | 'name' | 'appid' | 'size';

export function LibraryView({
  games,
  onOpenAddModal,
  onQuickAddAppId,
  onManageManifests,
  onImportForGame,
  onRemoveManualGame,
  onDiagnoseGame,
}: LibraryViewProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortMode>('status');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const blockedGames = useMemo(
    () => games.filter((g) => g.installDiagnostics?.status === 'blocked'),
    [games]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const installedCount = useMemo(
    () =>
      games.filter(
        (g) => g.status === 'installed' || g.status === 'update_required'
      ).length,
    [games]
  );

  const manifestLinkedCount = useMemo(
    () => games.filter((g) => g.luaCount + g.manifestCount > 0).length,
    [games]
  );

  const manualCount = useMemo(
    () => games.filter((g) => g.isManual).length,
    [games]
  );

  const filteredGames = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = games.filter((g) => {
      if (statusFilter === 'installed') {
        if (g.status !== 'installed' && g.status !== 'update_required')
          return false;
      } else if (statusFilter === 'manifest') {
        if (g.luaCount + g.manifestCount === 0) return false;
      } else if (statusFilter === 'manual') {
        if (!g.isManual) return false;
      }

      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        g.appId.toLowerCase().includes(q) ||
        g.linkedDepots.some((d) => d.includes(q))
      );
    });

    if (sortBy === 'name') {
      return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (sortBy === 'appid') {
      return [...list].sort(
        (a, b) => Number.parseInt(a.appId, 10) - Number.parseInt(b.appId, 10)
      );
    }
    if (sortBy === 'size') {
      return [...list].sort(
        (a, b) => (b.sizeOnDisk ?? 0) - (a.sizeOnDisk ?? 0)
      );
    }
    return list;
  }, [games, query, statusFilter, sortBy]);

  const numericSearchCandidate =
    /^\d{2,10}$/.test(query.trim()) &&
    !games.some((g) => g.appId === query.trim())
      ? query.trim()
      : null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header & Controls */}
      <div className="px-6 pt-6 pb-4 border-b border-white/[0.06] space-y-4 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-100 tracking-tight">
              Game Library
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {installedCount} installed on Steam · {manifestLinkedCount} with linked manifests
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenAddModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-[#171C29] hover:bg-[#1E2536] text-slate-100 border border-white/[0.09] transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 text-indigo-400" />
            <span>Add Game by AppID</span>
          </button>
        </div>

        {/* Search & Filter Row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Search Bar */}
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search games by name or AppID... (Ctrl+K)"
              className="w-full pl-9 pr-8 py-2 rounded-xl bg-[#111520] border border-white/[0.08] focus:border-indigo-500/50 focus:outline-none text-xs text-slate-100 placeholder:text-slate-500 transition-colors"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 p-0.5 cursor-pointer"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter Pills + Sort */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-xl bg-[#111520] p-1 border border-white/[0.06] text-xs">
              {(
                [
                  { id: 'all', label: `All (${games.length})` },
                  { id: 'installed', label: `Installed (${installedCount})` },
                  {
                    id: 'manifest',
                    label: `With Manifests (${manifestLinkedCount})`,
                  },
                  { id: 'manual', label: `Manual (${manualCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={clsx(
                    'px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer',
                    statusFilter === tab.id
                      ? 'bg-indigo-500/20 text-indigo-200'
                      : 'text-slate-400 hover:text-slate-200'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#111520] border border-white/[0.06] text-xs text-slate-400">
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortMode)}
                className="bg-transparent text-slate-300 focus:outline-none cursor-pointer"
                aria-label="Sort games"
              >
                <option value="status" className="bg-[#141925]">
                  Sort: Status
                </option>
                <option value="name" className="bg-[#141925]">
                  Sort: Name (A–Z)
                </option>
                <option value="appid" className="bg-[#141925]">
                  Sort: AppID
                </option>
                <option value="size" className="bg-[#141925]">
                  Sort: Size
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Grid Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {blockedGames.length > 0 && (
          <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/25 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="text-xs">
                <span className="font-semibold text-rose-200">
                  {blockedGames.length} game{blockedGames.length === 1 ? '' : 's'} ha
                  {blockedGames.length === 1 ? 's' : 've'} Steam install blockers
                </span>
                <p className="text-slate-400 mt-0.5">
                  Missing/pruned <span className="font-mono">.manifest</span> files, unsynced <span className="font-mono">config.vdf</span> keys, commented <span className="font-mono">setManifestid()</span>, or stuck Steam caches cause &quot;No internet connection&quot; errors.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDiagnoseGame(blockedGames[0])}
              className="px-3 py-1.5 rounded-xl text-xs font-medium bg-rose-500/20 hover:bg-rose-500/30 text-rose-100 border border-rose-500/30 transition-colors shrink-0 cursor-pointer"
            >
              Diagnose &amp; Fix ({blockedGames[0].name})
            </button>
          </div>
        )}
        {filteredGames.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-[#141824] border border-white/[0.07] flex items-center justify-center text-slate-500 mb-3">
              <Gamepad2 className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-slate-200">
              No matching games found
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {query
                ? `No library entry matched "${query}". You can add any Steam game manually using its AppID.`
                : 'No games match the selected filter.'}
            </p>
            <div className="mt-4 flex items-center gap-2">
              {numericSearchCandidate ? (
                <button
                  type="button"
                  onClick={() => void onQuickAddAppId(numericSearchCandidate)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add AppID {numericSearchCandidate} Now</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onOpenAddModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-white/[0.07] hover:bg-white/[0.11] text-slate-200 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Game by AppID</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredGames.map((game) => (
              <GameCard
                key={game.appId}
                game={game}
                onManageManifests={onManageManifests}
                onImportForGame={onImportForGame}
                onRemoveManualGame={onRemoveManualGame}
                onDiagnoseGame={onDiagnoseGame}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
