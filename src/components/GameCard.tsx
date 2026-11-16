import clsx from 'clsx';
import {
  Check,
  Copy,
  FileCode2,
  FolderCode,
  HardDrive,
  Trash2,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../lib/client';
import type { GameInstallStatus, SteamGame } from '../types/lunex';

interface GameCardProps {
  game: SteamGame;
  onManageManifests: (appId: string) => void;
  onImportForGame: (appId: string) => void;
  onRemoveManualGame: (appId: string) => void;
}

const PALETTES = [
  'from-indigo-500/25 via-sky-500/15 to-slate-900',
  'from-cyan-500/25 via-blue-600/15 to-slate-900',
  'from-violet-500/25 via-indigo-600/15 to-slate-900',
  'from-emerald-500/25 via-teal-600/15 to-slate-900',
  'from-amber-500/25 via-orange-600/15 to-slate-900',
  'from-rose-500/25 via-purple-600/15 to-slate-900',
];

function getPaletteForAppId(appId: string): string {
  let hash = 0;
  for (let i = 0; i < appId.length; i++) {
    hash = (hash * 31 + appId.charCodeAt(i)) | 0;
  }
  return PALETTES[Math.abs(hash) % PALETTES.length];
}

function getInitials(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'ST';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function statusMeta(status: GameInstallStatus): {
  label: string;
  dotClass: string;
  badgeClass: string;
} {
  switch (status) {
    case 'installed':
      return {
        label: 'Installed',
        dotClass: 'bg-emerald-400',
        badgeClass:
          'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
      };
    case 'update_required':
      return {
        label: 'Update Queued',
        dotClass: 'bg-amber-400',
        badgeClass: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
      };
    case 'manifest_only':
      return {
        label: 'Manifest Linked',
        dotClass: 'bg-sky-400',
        badgeClass: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
      };
    default:
      return {
        label: 'Not Installed',
        dotClass: 'bg-slate-400',
        badgeClass: 'bg-slate-500/12 text-slate-300 border-slate-500/25',
      };
  }
}

export function GameCard({
  game,
  onManageManifests,
  onImportForGame,
  onRemoveManualGame,
}: GameCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const meta = statusMeta(game.status);
  const palette = getPaletteForAppId(game.appId);
  const initials = getInitials(game.name);
  const steamHeaderUrl =
    game.localIconDataUrl ||
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${game.appId}/header.jpg`;

  const totalManifestFiles = game.luaCount + game.manifestCount;

  const handleCopyAppId = async () => {
    try {
      await navigator.clipboard.writeText(game.appId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="group relative flex flex-col rounded-2xl bg-[#131722] hover:bg-[#161B28] border border-white/[0.07] hover:border-indigo-500/30 transition-all duration-200 overflow-hidden shadow-sm">
      {/* Banner / Icon Header */}
      <div
        className={clsx(
          'relative h-28 w-full overflow-hidden bg-gradient-to-br flex items-center justify-center',
          palette
        )}
      >
        {/* Crisp Stylized Monogram Emblem Fallback */}
        <div className="flex items-center gap-3 select-none">
          <div className="w-11 h-11 rounded-xl bg-black/40 border border-white/10 backdrop-blur-xs flex items-center justify-center text-sm font-bold tracking-wider text-slate-100 shadow-inner">
            {initials}
          </div>
        </div>

        {/* Steam Artwork Overlay when available */}
        {!imgFailed && (
          <img
            src={steamHeaderUrl}
            alt={game.name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:scale-[1.03] transition-transform duration-300"
          />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-[#131722] via-[#131722]/30 to-transparent" />

        {/* Status Pill Top-Right */}
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
          <span
            className={clsx(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border backdrop-blur-md shadow-xs',
              meta.badgeClass
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', meta.dotClass)} />
            {meta.label}
          </span>
        </div>

        {/* Manual Tag Top-Left */}
        {game.isManual && (
          <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[10px] font-medium bg-black/60 text-slate-300 border border-white/10 backdrop-blur-md">
            Manual Entry
          </span>
        )}
      </div>

      {/* Card Body */}
      <div className="flex-1 flex flex-col justify-between p-4 pt-2.5 gap-3">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3
              className="text-sm font-semibold text-slate-100 leading-snug line-clamp-1"
              title={game.name}
            >
              {game.name}
            </h3>
          </div>

          <div className="mt-1.5 flex items-center flex-wrap gap-2 text-[11px] text-slate-400">
            <button
              type="button"
              onClick={handleCopyAppId}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/[0.05] hover:bg-white/[0.09] font-mono tabular-nums text-slate-300 transition-colors cursor-pointer"
              title="Copy Steam AppID"
            >
              <span>AppID {game.appId}</span>
              {copied ? (
                <Check className="w-3 h-3 text-emerald-400" />
              ) : (
                <Copy className="w-3 h-3 text-slate-500" />
              )}
            </button>

            {game.sizeOnDisk && game.sizeOnDisk > 0 ? (
              <span className="inline-flex items-center gap-1 text-slate-400 font-mono tabular-nums">
                <HardDrive className="w-3 h-3 text-slate-500" />
                {formatBytes(game.sizeOnDisk)}
              </span>
            ) : null}
          </div>
        </div>

        {/* Linked Manifests Row */}
        <div className="space-y-3 pt-2 border-t border-white/[0.05]">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-slate-500">Linked Files</span>
            <div className="flex items-center gap-1.5 font-mono tabular-nums">
              <span
                className={clsx(
                  'px-1.5 py-0.5 rounded border',
                  game.luaCount > 0
                    ? 'bg-indigo-500/12 text-indigo-300 border-indigo-500/20'
                    : 'bg-white/[0.03] text-slate-500 border-white/[0.05]'
                )}
              >
                {game.luaCount} .lua
              </span>
              <span
                className={clsx(
                  'px-1.5 py-0.5 rounded border',
                  game.manifestCount > 0
                    ? 'bg-sky-500/12 text-sky-300 border-sky-500/20'
                    : 'bg-white/[0.03] text-slate-500 border-white/[0.05]'
                )}
              >
                {game.manifestCount} .manifest
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onManageManifests(game.appId)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/[0.05] hover:bg-white/[0.09] text-slate-200 border border-white/[0.06] transition-colors cursor-pointer"
            >
              {totalManifestFiles > 0 ? (
                <>
                  <FolderCode className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Manifests ({totalManifestFiles})</span>
                </>
              ) : (
                <>
                  <FileCode2 className="w-3.5 h-3.5 text-slate-400" />
                  <span>View Slot</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => onImportForGame(game.appId)}
              className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/25 transition-colors cursor-pointer"
              title={`Import .lua or .manifest for ${game.name}`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import</span>
            </button>

            {game.isManual && game.status !== 'installed' && (
              <button
                type="button"
                onClick={() => onRemoveManualGame(game.appId)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/15 border border-transparent hover:border-rose-500/20 transition-colors cursor-pointer"
                title="Remove manual game entry"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
