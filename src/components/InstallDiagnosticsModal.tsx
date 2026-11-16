import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  RefreshCw,
  Settings,
  ShieldAlert,
  Terminal,
  Upload,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatBytes, isDesktopElectron, lunexClient } from '../lib/client';
import type {
  LiveSteamAppInfo,
  RepairInstallResult,
  SteamGame,
  SystemState,
} from '../types/lunex';

interface InstallDiagnosticsModalProps {
  game: SteamGame | null;
  isSimulatedSteam: boolean;
  onClose: () => void;
  onRepaired: (result: RepairInstallResult) => void;
  onStateUpdated: (state: SystemState, liveInfo?: LiveSteamAppInfo) => void;
  onOpenImportForGame: (appId: string) => void;
  onOpenSettings: () => void;
}

export function InstallDiagnosticsModal({
  game,
  isSimulatedSteam,
  onClose,
  onRepaired,
  onStateUpdated,
  onOpenImportForGame,
  onOpenSettings,
}: InstallDiagnosticsModalProps) {
  const [repairing, setRepairing] = useState(false);
  const [checkingLive, setCheckingLive] = useState(false);
  const [lastReport, setLastReport] = useState<RepairInstallResult | null>(null);
  const [showRawLog, setShowRawLog] = useState(false);
  const [copiedCmds, setCopiedCmds] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  useEffect(() => {
    setLastReport(null);
    setShowRawLog(false);
  }, [game?.appId]);

  if (!game) return null;

  const diag = game.installDiagnostics;
  const issues = diag?.issues ?? [];
  const expectedDepots = diag?.expectedDepots ?? [];
  const steamLog = diag?.steamLog;
  const liveInfo = diag?.liveAppInfo;

  const hasAutoFixable = issues.some((i) => i.autoFixable);
  const hasPathMismatch = issues.some((i) => i.code === 'steam_path_mismatch');
  const needsSteamLocationFix = issues.some(
    (i) => i.code === 'simulated_steam' || i.code === 'custom_dir_mismatch'
  );
  const needsMissingFiles = issues.some(
    (i) =>
      i.code === 'missing_depot_manifest' ||
      i.code === 'missing_required_depot' ||
      i.code === 'outdated_manifest' ||
      i.code === 'missing_lua' ||
      i.code === 'steam_log_manifest_failed'
  );
  const canManageSteam = isDesktopElectron() && !isSimulatedSteam;

  // Build exact missing/outdated depot manifest list & Steam Console commands
  const recoveryTargets = new Map<string, { depotId: string; manifestId: string }>();
  for (const dep of expectedDepots) {
    if (dep.steamLogRequestedManifestId) {
      recoveryTargets.set(`${dep.depotId}_${dep.steamLogRequestedManifestId}`, {
        depotId: dep.depotId,
        manifestId: dep.steamLogRequestedManifestId,
      });
    } else if (
      dep.liveManifestId &&
      (!dep.diskManifestId || dep.diskManifestId !== dep.liveManifestId)
    ) {
      recoveryTargets.set(`${dep.depotId}_${dep.liveManifestId}`, {
        depotId: dep.depotId,
        manifestId: dep.liveManifestId,
      });
    } else if (dep.luaManifestId && !dep.diskManifestFile) {
      recoveryTargets.set(`${dep.depotId}_${dep.luaManifestId}`, {
        depotId: dep.depotId,
        manifestId: dep.luaManifestId,
      });
    }
  }
  for (const fm of steamLog?.failedManifests ?? []) {
    recoveryTargets.set(`${fm.depotId}_${fm.manifestId}`, {
      depotId: fm.depotId,
      manifestId: fm.manifestId,
    });
  }
  const recoveryList = Array.from(recoveryTargets.values());

  const handleRepair = async (restartSteam: boolean) => {
    setRepairing(true);
    try {
      const result = await lunexClient.repairInstall(game.appId, {
        restartSteam,
        clearDownloadCache: true,
        adoptRunningSteamPath: hasPathMismatch,
      });
      setLastReport(result);
      onRepaired(result);
    } finally {
      setRepairing(false);
    }
  };

  const handleCheckLive = async () => {
    setCheckingLive(true);
    try {
      const res = await lunexClient.checkLiveAppInfo(game.appId);
      onStateUpdated(res.state, res.liveInfo);
    } catch {
      // Non-fatal error handled by state/toast
    } finally {
      setCheckingLive(false);
    }
  };

  const handleCopyCommands = async () => {
    if (recoveryList.length === 0) return;
    const cmds = recoveryList
      .map((t) => `download_depot ${game.appId} ${t.depotId} ${t.manifestId}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(cmds);
      setCopiedCmds(true);
      setTimeout(() => setCopiedCmds(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleCopyDiagnosticReport = async () => {
    const lines = [
      `Lunex Steam Install Diagnostic Report — ${game.name} (AppID ${game.appId})`,
      `Status: ${diag?.status ?? 'unknown'} | .lua: ${game.luaCount} | .manifest: ${game.manifestCount}`,
      `Steam Running: ${diag?.steamRunning ? 'Yes' : 'No'} | Plugin Detected: ${diag?.pluginDetected ? 'Yes' : 'No'}`,
      liveInfo
        ? `Live Steam Check: ${liveInfo.steamReachable ? 'Reachable' : 'Unreachable'} (Build ${liveInfo.buildId ?? '?'})`
        : 'Live Steam Check: Not run yet',
      '',
      'Issues:',
      ...issues.map(
        (i) => `- [${i.severity.toUpperCase()}] ${i.title}: ${i.description}`
      ),
      '',
      'Depots:',
      ...expectedDepots.map(
        (d) =>
          `- Depot ${d.depotId}: key=${d.hasDecryptionKey ? 'ok' : 'missing'} (vdf=${d.keyInConfigVdf ? 'yes' : 'no'}), luaPin=${d.luaManifestId ?? 'none'}, disk=${d.diskManifestFile ?? 'missing'}, live=${d.liveManifestId ?? 'n/a'}, logFail=${d.steamLogRequestedManifestId ?? 'none'}`
      ),
    ];
    if (steamLog?.recentLines.length) {
      lines.push('', 'Steam content_log.txt excerpt:', ...steamLog.recentLines);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-[#131824] border border-white/[0.08] shadow-2xl overflow-hidden">
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
                {liveInfo?.buildId ? ` · Live Build ${liveInfo.buildId}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleCopyDiagnosticReport()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-slate-300 hover:text-white bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.07] transition-colors cursor-pointer"
              title="Copy full diagnostic report"
            >
              {copiedReport ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Report</span>
                </>
              )}
            </button>
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
            <div className="space-y-1.5 flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-semibold text-slate-100">
                  {diag?.status === 'ready'
                    ? 'Local Manifests, Keys & Caches Look Ready for Steam'
                    : diag?.status === 'needs_attention'
                      ? 'Warnings Detected — Recommended Fixes Available'
                      : 'Install Blocked — Exact Cause of Steam "No Internet Connection" Found'}
                </span>
                {liveInfo && (
                  <span
                    className={clsx(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border',
                      liveInfo.steamReachable
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25'
                        : 'bg-rose-500/15 text-rose-300 border-rose-500/25'
                    )}
                  >
                    <Globe className="w-3 h-3" />
                    {liveInfo.steamReachable
                      ? 'Internet & Steam Online'
                      : 'Steam API Unreachable'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {diag?.status === 'ready'
                  ? 'Your .lua script, setManifestid() pins, config.vdf keys, and raw 0x71F617D0 manifests in depotcache & config/depotcache match. Click "Check Live Steam Depots" if Steam still reports "No internet connection" to check if Steam expects a newer manifest or extra depot.'
                  : 'Steam reports "No internet connection" whenever CDepotDownloadMgr cannot load the exact <depot>_<manifest>.manifest locally and Valve returns Access Denied for an online manifest request code — even when your internet works fine.'}
              </p>
            </div>
          </div>

          {/* Steam content_log.txt Evidence Box */}
          {steamLog &&
            (steamLog.failedManifests.length > 0 ||
              steamLog.missingKeyDepots.length > 0 ||
              steamLog.corruptManifestFiles.length > 0 ||
              Boolean(steamLog.lastErrorSummary)) && (
              <div className="rounded-xl bg-rose-950/35 border border-rose-500/30 overflow-hidden">
                <div className="px-4 py-2.5 flex items-center justify-between gap-2 border-b border-rose-500/20">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-rose-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-rose-200">
                        Steam Log Evidence (logs/content_log.txt)
                      </div>
                      {steamLog.lastErrorSummary && (
                        <div className="text-[11px] font-mono text-rose-300/90 truncate">
                          {steamLog.lastErrorTimestamp
                            ? `[${steamLog.lastErrorTimestamp}] `
                            : ''}
                          {steamLog.lastErrorSummary}
                        </div>
                      )}
                    </div>
                  </div>
                  {steamLog.recentLines.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowRawLog((v) => !v)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 shrink-0 cursor-pointer"
                    >
                      <span>{showRawLog ? 'Hide Log' : 'Raw Log'}</span>
                      {showRawLog ? (
                        <ChevronUp className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                    </button>
                  )}
                </div>
                {showRawLog && steamLog.recentLines.length > 0 && (
                  <pre className="p-3 text-[10px] font-mono text-slate-300 bg-[#090B11] overflow-x-auto max-h-40 leading-relaxed whitespace-pre-wrap">
                    {steamLog.recentLines.join('\n')}
                  </pre>
                )}
              </div>
            )}

          {/* Last Repair Report */}
          {lastReport && (
            <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/25 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-semibold text-indigo-200">
                  {lastReport.fixedCount > 0
                    ? `Applied ${lastReport.fixedCount} Fix${lastReport.fixedCount === 1 ? '' : 'es'}`
                    : 'Diagnostics Refreshed'}
                </span>
                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                  {lastReport.steamStopped && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                      Steam Stopped First
                    </span>
                  )}
                  {lastReport.configVdfSyncedCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                      config.vdf +{lastReport.configVdfSyncedCount}
                    </span>
                  )}
                  {lastReport.downloadCacheCleared && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                      httpcache Cleared
                    </span>
                  )}
                </div>
              </div>

              {lastReport.actionsTaken.length > 0 && (
                <ul className="space-y-1 text-[11px] text-slate-300 list-disc pl-4">
                  {lastReport.actionsTaken.map((act, idx) => (
                    <li key={idx}>{act}</li>
                  ))}
                </ul>
              )}

              {lastReport.warnings.length > 0 && (
                <div className="space-y-1 pt-1 border-t border-indigo-500/20">
                  {lastReport.warnings.map((w, idx) => (
                    <p
                      key={idx}
                      className="text-[11px] text-amber-300 flex items-start gap-1.5"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </p>
                  ))}
                </div>
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
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-300">
                  Depot Verification ({expectedDepots.length})
                </span>
                <span className="text-[10px] text-slate-500">
                  Checks .lua, config.vdf, depotcache, config/depotcache &amp; live Steam
                </span>
              </div>
              <div className="divide-y divide-white/[0.05]">
                {expectedDepots.map((dep) => {
                  const hasHeaderMismatch =
                    Boolean(dep.headerManifestId) &&
                    Boolean(dep.diskManifestId) &&
                    dep.diskManifestFile !==
                      `${dep.depotId}_${dep.headerManifestId}.manifest`;
                  const isOutdatedVsLive =
                    Boolean(dep.liveManifestId) &&
                    Boolean(dep.diskManifestId) &&
                    dep.liveManifestId !== dep.diskManifestId;
                  const manifestMatched =
                    Boolean(dep.diskManifestFile) &&
                    !dep.isZipWrapped &&
                    !hasHeaderMismatch &&
                    Boolean(dep.luaManifestId) &&
                    dep.luaManifestId === dep.diskManifestId &&
                    !dep.failedInSteamLog;

                  return (
                    <div
                      key={dep.depotId}
                      className="px-4 py-2.5 space-y-1.5 text-xs font-mono"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-indigo-300 font-semibold">
                            Depot {dep.depotId}
                          </span>
                          {dep.liveSizeBytes !== undefined && (
                            <span className="text-[10px] text-slate-500 font-sans">
                              {formatBytes(dep.liveSizeBytes)}
                            </span>
                          )}
                          {dep.liveOsList && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400 font-sans">
                              {dep.liveOsList}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                          <span
                            className={clsx(
                              'px-1.5 py-0.5 rounded',
                              dep.keyInvalid
                                ? 'bg-rose-500/15 text-rose-300'
                                : dep.hasDecryptionKey
                                  ? dep.keyInConfigVdf
                                    ? 'bg-emerald-500/12 text-emerald-300'
                                    : 'bg-amber-500/15 text-amber-300'
                                  : 'bg-rose-500/15 text-rose-300'
                            )}
                          >
                            {dep.keyInvalid
                              ? 'Invalid Key'
                              : dep.hasDecryptionKey
                                ? dep.keyInConfigVdf
                                  ? 'Key + config.vdf'
                                  : 'Key (.lua only)'
                                : 'No Key'}
                          </span>

                          <span
                            className={clsx(
                              'px-1.5 py-0.5 rounded',
                              manifestMatched && dep.inConfigDepotcache
                                ? 'bg-emerald-500/12 text-emerald-300'
                                : manifestMatched
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-rose-500/15 text-rose-300'
                            )}
                          >
                            {dep.failedInSteamLog
                              ? 'Failed in Steam Log'
                              : dep.diskManifestFile
                                ? dep.isZipWrapped
                                  ? 'Compressed'
                                  : hasHeaderMismatch
                                    ? 'Header Mismatch'
                                    : dep.luaManifestId
                                      ? dep.luaManifestId === dep.diskManifestId
                                        ? dep.inConfigDepotcache
                                          ? 'Pinned & Dual-Cached'
                                          : 'Pinned (Mirror Needed)'
                                        : 'ID Mismatch'
                                      : dep.commentedManifestId
                                        ? 'Commented setManifestid'
                                        : 'Missing setManifestid'
                                : dep.inConfigDepotcache || dep.inVault
                                  ? 'Deleted by Steam (Restorable)'
                                  : 'Missing .manifest'}
                          </span>

                          {isOutdatedVsLive && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                              Outdated vs Live
                            </span>
                          )}
                        </div>
                      </div>

                      {(dep.liveManifestId || dep.steamLogRequestedManifestId) && (
                        <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-4 gap-y-0.5">
                          <span>Local: {dep.diskManifestId ?? 'none'}</span>
                          {dep.liveManifestId && (
                            <span
                              className={
                                isOutdatedVsLive
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                              }
                            >
                              Live Steam: {dep.liveManifestId}
                            </span>
                          )}
                          {dep.steamLogRequestedManifestId && (
                            <span className="text-rose-300">
                              Steam Requested: {dep.steamLogRequestedManifestId}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Missing/Outdated Manifest Recovery Box */}
          {recoveryList.length > 0 && (
            <div className="rounded-xl bg-[#0D111A] border border-sky-500/25 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs font-semibold text-sky-200">
                  <Terminal className="w-4 h-4 text-sky-400 shrink-0" />
                  <span>
                    Required Manifest File{recoveryList.length === 1 ? '' : 's'} / Steam Console Fallback
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleCopyCommands()}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 border border-sky-500/25 cursor-pointer"
                  >
                    {copiedCmds ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Console Cmds</span>
                      </>
                    )}
                  </button>
                  {canManageSteam && (
                    <button
                      type="button"
                      onClick={() => void lunexClient.openSteamConsole()}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-200 border border-white/[0.08] cursor-pointer"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Open Steam Console</span>
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Exact filename(s) Steam needs in <span className="font-mono text-slate-300">Steam/depotcache</span> (or run the commands below in Steam Console):
              </p>
              <div className="rounded-lg bg-[#080A10] border border-white/[0.05] p-2.5 text-[11px] font-mono text-sky-200 space-y-1 overflow-x-auto">
                {recoveryList.map((t) => (
                  <div key={`${t.depotId}_${t.manifestId}`}>
                    {t.depotId}_{t.manifestId}.manifest
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-t border-white/[0.06] bg-[#0F131D] shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={checkingLive}
              onClick={() => void handleCheckLive()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 text-sky-200 border border-sky-500/25 transition-colors cursor-pointer"
              title="Query live SteamCMD metadata (api.steamcmd.net) & verify Steam internet reachability"
            >
              <Globe
                className={clsx('w-3.5 h-3.5', checkingLive && 'animate-spin')}
              />
              <span>
                {checkingLive ? 'Checking Live...' : 'Check Live Steam Depots'}
              </span>
            </button>

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
                <span>Settings</span>
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
                <span>Import Files</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {canManageSteam ? (
              <>
                <button
                  type="button"
                  disabled={repairing}
                  onClick={() => void handleRepair(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white transition-colors cursor-pointer"
                  title="Stops Steam completely, writes config.vdf & dual-caches manifests, clears download cache & stuck ACF, then restarts Steam cleanly"
                >
                  <RefreshCw
                    className={clsx('w-3.5 h-3.5', repairing && 'animate-spin')}
                  />
                  <span>
                    {repairing
                      ? 'Stopping Steam & Fixing...'
                      : 'Stop Steam, Fix All & Restart'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => void lunexClient.launchSteamInstall(game.appId)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-emerald-500/18 hover:bg-emerald-500/28 text-emerald-200 border border-emerald-500/30 transition-colors cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Install in Steam</span>
                </button>
              </>
            ) : (
              hasAutoFixable && (
                <button
                  type="button"
                  disabled={repairing}
                  onClick={() => void handleRepair(false)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white transition-colors cursor-pointer"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  <span>{repairing ? 'Repairing...' : 'Auto-Fix Issues'}</span>
                </button>
              )
            )}

            <button
              type="button"
              onClick={() => {
                setLastReport(null);
                onClose();
              }}
              className="px-3 py-2 rounded-xl text-xs font-medium text-slate-300 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
