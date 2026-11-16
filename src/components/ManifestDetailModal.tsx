import clsx from 'clsx';
import {
  CheckCircle2,
  ExternalLink,
  FileCode2,
  Link2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  formatBytes,
  isDesktopElectron,
  lunexClient,
} from '../lib/client';
import type {
  ManagedManifest,
  ManifestInspection,
  SteamGame,
} from '../types/lunex';

interface ManifestDetailModalProps {
  manifest: ManagedManifest | null;
  games: SteamGame[];
  onClose: () => void;
  onAssociate: (filePath: string, appId: string) => Promise<void>;
  onDelete: (filePath: string) => Promise<void>;
}

export function ManifestDetailModal({
  manifest,
  games,
  onClose,
  onAssociate,
  onDelete,
}: ManifestDetailModalProps) {
  const [inspection, setInspection] = useState<ManifestInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [appIdInput, setAppIdInput] = useState('');
  const [savingAssoc, setSavingAssoc] = useState(false);

  useEffect(() => {
    if (!manifest) {
      setInspection(null);
      return;
    }
    setAppIdInput(manifest.appId === 'unassigned' ? '' : manifest.appId);
    setLoading(true);
    lunexClient
      .inspectManifest(manifest.filePath)
      .then(setInspection)
      .catch(() => setInspection(null))
      .finally(() => setLoading(false));
  }, [manifest]);

  if (!manifest) return null;

  const handleSaveAssoc = async () => {
    setSavingAssoc(true);
    try {
      await onAssociate(
        manifest.filePath,
        appIdInput.trim() || 'unassigned'
      );
    } finally {
      setSavingAssoc(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div className="w-full max-w-2xl max-h-[86vh] flex flex-col rounded-2xl bg-[#131824] border border-white/[0.08] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 shrink-0">
              <FileCode2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-mono font-semibold text-slate-100 truncate">
                {manifest.fileName}
              </h2>
              <p className="text-[11px] font-mono text-slate-400 truncate">
                {manifest.filePath}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="p-3 rounded-xl bg-[#0D1018] border border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Type
              </div>
              <div className="mt-1 text-xs font-mono font-semibold text-slate-200 uppercase">
                .{manifest.fileType}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#0D1018] border border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                File Size
              </div>
              <div className="mt-1 text-xs font-mono font-semibold text-slate-200">
                {formatBytes(manifest.sizeBytes)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#0D1018] border border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Validation
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs font-medium">
                {manifest.isValid ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-300">Valid</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-rose-400" />
                    <span className="text-rose-300">Invalid</span>
                  </>
                )}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#0D1018] border border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                SHA-256
              </div>
              <div
                className="mt-1 text-xs font-mono text-slate-300 truncate"
                title={manifest.sha256}
              >
                {manifest.sha256.slice(0, 14)}…
              </div>
            </div>
          </div>

          {/* AppID Association Controls */}
          <div className="p-4 rounded-xl bg-[#0D1018] border border-white/[0.06] space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
              <Link2 className="w-3.5 h-3.5 text-indigo-400" />
              <span>Steam AppID Association</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={appIdInput}
                onChange={(e) => setAppIdInput(e.target.value)}
                placeholder="Numeric AppID (e.g. 1091500)"
                className="w-40 px-3 py-1.5 rounded-lg bg-[#141925] border border-white/[0.08] font-mono text-xs text-slate-100 focus:border-indigo-500/50 focus:outline-none"
              />
              <select
                value={games.some((g) => g.appId === appIdInput) ? appIdInput : ''}
                onChange={(e) => {
                  if (e.target.value) setAppIdInput(e.target.value);
                }}
                className="flex-1 min-w-[180px] px-3 py-1.5 rounded-lg bg-[#141925] border border-white/[0.08] text-xs text-slate-300 focus:border-indigo-500/50 focus:outline-none"
              >
                <option value="">Choose game from Library...</option>
                {games.map((g) => (
                  <option key={g.appId} value={g.appId}>
                    {g.name} ({g.appId})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={savingAssoc}
                onClick={() => void handleSaveAssoc()}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white transition-colors cursor-pointer"
              >
                {savingAssoc ? 'Saving...' : 'Save Link'}
              </button>
            </div>
          </div>

          {/* Content Inspection */}
          {loading ? (
            <div className="p-6 text-center text-xs text-slate-500">
              Reading manifest payload...
            </div>
          ) : inspection?.manifest.fileType === 'lua' ? (
            <div className="space-y-3">
              {inspection.directives && inspection.directives.length > 0 && (
                <div className="rounded-xl bg-[#0D1018] border border-white/[0.06] overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-white/[0.06] text-xs font-medium text-slate-300">
                    Parsed Steam Directives ({inspection.directives.length})
                  </div>
                  <div className="divide-y divide-white/[0.05]">
                    {inspection.directives.map((d) => (
                      <div
                        key={d.id}
                        className="px-4 py-2 flex items-center justify-between gap-3 text-xs font-mono"
                      >
                        <span className="text-indigo-300 font-semibold">
                          ID {d.id}
                        </span>
                        <span className="text-slate-400 truncate">
                          {d.manifestId
                            ? `Manifest ${d.manifestId}`
                            : 'Root App Entry'}
                        </span>
                        <span
                          className={clsx(
                            'text-[10px] px-1.5 py-0.5 rounded',
                            d.decryptionKey
                              ? 'bg-emerald-500/12 text-emerald-300'
                              : 'bg-white/[0.05] text-slate-400'
                          )}
                        >
                          {d.decryptionKey ? 'Key Present' : 'AppID'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl bg-[#0B0E15] border border-white/[0.06] overflow-hidden">
                <div className="px-4 py-2 border-b border-white/[0.06] text-[11px] font-mono text-slate-400">
                  Lua Script Source
                </div>
                <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
                  {inspection.textContent}
                </pre>
              </div>
            </div>
          ) : inspection ? (
            <div className="rounded-xl bg-[#0D1018] border border-white/[0.06] p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">
                  Binary DepotManifest Header
                </span>
                <span
                  className={clsx(
                    'text-[11px] font-mono px-2 py-0.5 rounded',
                    inspection.magicValid
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                  )}
                >
                  {inspection.magicValid
                    ? 'Magic 0x71F617D0 Verified'
                    : 'Non-Standard Header'}
                </span>
              </div>
              {manifest.depotId && (
                <div className="text-xs font-mono text-slate-400">
                  Depot ID: <span className="text-slate-200">{manifest.depotId}</span>
                  {manifest.manifestId && (
                    <>
                      {' · '}Manifest ID:{' '}
                      <span className="text-slate-200">{manifest.manifestId}</span>
                    </>
                  )}
                </div>
              )}
              <div className="p-3 rounded-lg bg-[#090B10] border border-white/[0.05] font-mono text-[11px] text-sky-300 break-all leading-relaxed">
                {inspection.hexHeader}
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06] bg-[#0F131D]">
          <button
            type="button"
            onClick={async () => {
              await onDelete(manifest.filePath);
              onClose();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium text-rose-300 hover:bg-rose-500/15 border border-rose-500/25 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete File</span>
          </button>

          <div className="flex items-center gap-2">
            {isDesktopElectron() && (
              <button
                type="button"
                onClick={() => void lunexClient.openPath(manifest.filePath)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium text-slate-300 bg-white/[0.05] hover:bg-white/[0.09] transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Show in Explorer</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium bg-white/[0.07] hover:bg-white/[0.12] text-slate-200 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
