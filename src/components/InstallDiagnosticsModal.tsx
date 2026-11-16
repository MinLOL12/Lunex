import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Settings,
  ShieldAlert,
  Upload,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { isDesktopElectron, lunexClient } from '../lib/client';
import type { RepairInstallResult, SteamGame } from '../types/lunex';

interface InstallDiagnosticsModalProps {
  game: SteamGame | null;
  isSimulatedSteam: boolean;
  onClose: () => void;
  onRepaired: (result: RepairInstallResult) => void;
  onOpenImportForGame: (appId: string) => void;
  onOpenSettings: () => void;
}

export function InstallDiagnosticsModal({
  game,
  isSimulatedSteam,
  onClose,
  onRepaired,
  onOpenImportForGame,
  onOpenSettings,
}: InstallDiagnosticsModalProps) {
  const [repairing, setRepairing] = useState(false);
  const [lastReport, setLastReport] = useState<RepairInstallResult | null>(null);

  if (!game) return null;

  const diag = game.installDiagnostics;
  const issues = diag?.issues ?? [];
  const expectedDepots = diag?.expectedDepots ?? [];
  const hasAutoFixable = issues.some((i) => i.autoFixable);
  const needsSteamLocationFix = issues.some(
    (i) => i.code === 'simulated_steam' || i.code === 'custom_dir_mismatch'
  );
  const needsMissingFiles = issues.some(
    (i) => i.code === 'missing_depot_manifest' || i.code === 'missing_lua'
  );
  const canRestartSteam = isDesktopElectron() && !isSimulatedSteam;

  const handleRepair = async (restartSteam: boolean) => {
    setRepairing(true);
    try {
      const result = await lunexClient.repairInstall(game.appId, {
        restartSteam,
      });
      setLastReport(result);
      onRepaired(result);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-[#131824] border border-white/[0.08] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={clsx(
                'p-2 rounded-xl border shrink-0',
                diag?.status === 'ready'
                  ? 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400'
                  : diag?.status === 'needs_attention'
                    ? 'bg-amber-500/15 border-amber-500/25 text-amber-400'
                    : 'bg-rose-500/15 border-rose-500/25 text-rose-400'
              )}
            >
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-100 truncate">
                Steam Install Diagnostics — {game.name}
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                AppID {game.appId} · {game.luaCount} .lua · {game.manifestCount} .manifest
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setLastReport(null);
              onClose();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Summary Banner */}
          <div
            className={clsx(
              'p-4 rounded-xl border flex items-start gap-3',
              diag?.status === 'ready'
                ? 'bg-emerald-500/10 border-emerald-500/25'
                : diag?.status === 'needs_attention'
                  ? 'bg-amber-500/10 border-amber-500/25'
                  : 'bg-rose-500/10 border-rose-500/30'
            )}
          >
            {diag?.status === 'ready' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : diag?.status === 'needs_attention' ? (
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-100">
                {diag?.status === 'ready'
                  ? 'All Manifests & Directives Ready for Steam'
                  : diag?.status === 'needs_attention'
                    ? 'Warnings Detected — Review Before Installing'
                    : 'Install Blocked — This Causes Steam "Download Queued" → "No Internet" Errors'}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {diag?.status === 'ready'
                  ? 'Your .lua script, setManifestid() pins, decryption keys, and raw 0x71F617D0 .manifest files in depotcache match. If Steam still queued an old attempt, restart Steam and click Install in Steam.'
                  : 'When Steam cannot read a local depot .manifest, has no setManifestid() pin, or hits a stuck download cache, it tries to request the manifest from Valve servers and reports "No internet connection" even when your internet works.'}
              </p>
            </div>
          </div>

          {/* Last Repair Report */}
          {lastReport && (
            <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/25 space-y-1.5">
              <div className="text-xs font-semibold text-indigo-200">
                {lastReport.fixedCount > 0
                  ? `Applied ${lastReport.fixedCount} Automatic Fix${lastReport.fixedCount === 1 ? '' : 'es'}`
                  : 'Diagnostics Refreshed'}
              </div>
              {lastReport.actionsTaken.length > 0 ? (
                <ul className="space-y-1 text-[11px] text-slate-300 list-disc pl-4">
                  {lastReport.actionsTaken.map((act, idx) => (
                    <li key={idx}>{act}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-slate-400">
                  No automatic file changes were applicable; review any remaining issues below.
                </p>
              )}
            </div>
          )}

          {/* Issues List */}
          {issues.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-300">
                Detected Issues ({issues.length})
              </div>
              {issues.map((issue, idx) => (
                <div
                  key={`${issue.code}-${issue.depotId ?? ''}-${idx}`}
                  className={clsx(
                    'p-3.5 rounded-xl border bg-[#0E121B] space-y-1.5',
                    issue.severity === 'error'
                      ? 'border-rose-500/30'
                      : 'border-amber-500/25'
                  )}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      {issue.severity === 'error' ? (
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                      )}
                      <span className="text-xs font-semibold text-slate-100">
                        {issue.title}
                      </span>
                    </div>

                    {issue.autoFixable ? (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">
                        Auto-Fixable
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-white/[0.06] text-slate-400">
                        Action Needed
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed pl-6">
                    {issue.description}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Expected Depots Table */}
          {expectedDepots.length > 0 && (
            <div className="rounded-xl bg-[#0D1018] border border-white/[0.06] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.06] text-xs font-semibold text-slate-300">
                Depot Verification ({expectedDepots.length})
              </div>
              <div className="divide-y divide-white/[0.05]">
                {expectedDepots.map((dep) => {
                  const manifestMatched =
                    Boolean(dep.diskManifestFile) &&
                    !dep.isZipWrapped &&
                    (!dep.luaManifestId ||
                      dep.luaManifestId === dep.diskManifestId);

                  return (
                    <div
                      key={dep.depotId}
                      className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
                    >
                      <span className="text-indigo-300 font-semibold">
                        Depot {dep.depotId}
                      </span>
                      <div className="flex items-center gap-2 flex-wrap text-[11px]">
                        <span
                          className={clsx(
                            'px-1.5 py-0.5 rounded',
                            dep.hasDecryptionKey
                              ? 'bg-emerald-500/12 text-emerald-300'
                              : 'bg-rose-500/15 text-rose-300'
                          )}
                        >
                          {dep.hasDecryptionKey ? 'Key OK' : 'No Key'}
                        </span>
                        <span
                          className={clsx(
                            'px-1.5 py-0.5 rounded',
                            manifestMatched
                              ? 'bg-emerald-500/12 text-emerald-300'
                              : 'bg-rose-500/15 text-rose-300'
                          )}
                        >
                          {dep.diskManifestFile
                            ? dep.isZipWrapped
                              ? 'ZIP-Wrapped'
                              : dep.luaManifestId
                                ? dep.luaManifestId === dep.diskManifestId
                                  ? 'Pinned & Cached'
                                  : 'ID Mismatch'
                                : 'Missing setManifestid'
                            : 'Missing .manifest'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-t border-white/[0.06] bg-[#0F131D] shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            {needsSteamLocationFix && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/25 transition-colors cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>Fix Steam Path in Settings</span>
              </button>
            )}

            {needsMissingFiles && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenImportForGame(game.appId);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-white/[0.07] hover:bg-white/[0.12] text-slate-200 border border-white/[0.08] transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-indigo-400" />
                <span>Import Missing Files</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {hasAutoFixable && (
              <button
                type="button"
                disabled={repairing}
                onClick={() => void handleRepair(false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white transition-colors cursor-pointer"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span>{repairing ? 'Repairing...' : 'Auto-Fix Issues'}</span>
              </button>
            )}

            {canRestartSteam && (
              <button
                type="button"
                disabled={repairing}
                onClick={() => void handleRepair(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/30 transition-colors cursor-pointer"
              >
                <RefreshCw className={clsx('w-3.5 h-3.5', repairing && 'animate-spin')} />
                <span>Fix & Restart Steam</span>
              </button>
            )}

            {isDesktopElectron() && !isSimulatedSteam && (
              <button
                type="button"
                onClick={() => void lunexClient.launchSteamInstall(game.appId)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-white/[0.07] hover:bg-white/[0.12] text-slate-200 border border-white/[0.08] transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Install in Steam</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setLastReport(null);
                onClose();
              }}
              className="px-3.5 py-2 rounded-xl text-xs font-medium text-slate-300 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
