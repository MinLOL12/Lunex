import clsx from 'clsx';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  History,
  RotateCcw,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatRelativeTime } from '../lib/client';
import type { BackupRecord, OperationRecord } from '../types/lunex';

interface OperationsLogPanelProps {
  isOpen: boolean;
  initialTab?: 'operations' | 'backups';
  operations: OperationRecord[];
  backups: BackupRecord[];
  onClose: () => void;
  onClearOperations: () => Promise<void>;
  onRestoreBackup: (backupId: string) => Promise<void>;
}

export function OperationsLogPanel({
  isOpen,
  initialTab = 'operations',
  operations,
  backups,
  onClose,
  onClearOperations,
  onRestoreBackup,
}: OperationsLogPanelProps) {
  const [tab, setTab] = useState<'operations' | 'backups'>(initialTab);
  const [filter, setFilter] = useState<'all' | 'success' | 'issues'>('all');
  const [restoringId, setRestoringId] = useState<string | null>(null);

  if (!isOpen) return null;

  const filteredOps = operations.filter((op) => {
    if (filter === 'success') return op.status === 'success';
    if (filter === 'issues') return op.status !== 'success';
    return true;
  });

  const successCount = operations.filter((o) => o.status === 'success').length;
  const issueCount = operations.filter((o) => o.status !== 'success').length;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-md h-full bg-[#111520] border-l border-white/[0.08] shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-slate-100">
              File Operations & Backups
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 pb-2 border-b border-white/[0.06] flex items-center justify-between gap-2">
          <div className="flex rounded-xl bg-[#0B0D14] p-1 border border-white/[0.06]">
            <button
              type="button"
              onClick={() => setTab('operations')}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                tab === 'operations'
                  ? 'bg-indigo-500/20 text-indigo-200'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              Operations ({operations.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('backups')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                tab === 'backups'
                  ? 'bg-indigo-500/20 text-indigo-200'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <History className="w-3.5 h-3.5" />
              Backups ({backups.length})
            </button>
          </div>

          {tab === 'operations' && operations.length > 0 && (
            <button
              type="button"
              onClick={() => void onClearOperations()}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          )}
        </div>

        {tab === 'operations' ? (
          <>
            {/* Status Filter Pills */}
            <div className="px-5 py-2.5 flex items-center gap-1.5 border-b border-white/[0.05] text-[11px]">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={clsx(
                  'px-2.5 py-1 rounded-lg border transition-colors cursor-pointer',
                  filter === 'all'
                    ? 'bg-white/[0.09] text-slate-100 border-white/[0.12]'
                    : 'text-slate-400 border-transparent hover:bg-white/[0.04]'
                )}
              >
                All ({operations.length})
              </button>
              <button
                type="button"
                onClick={() => setFilter('success')}
                className={clsx(
                  'px-2.5 py-1 rounded-lg border transition-colors cursor-pointer',
                  filter === 'success'
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25'
                    : 'text-slate-400 border-transparent hover:bg-white/[0.04]'
                )}
              >
                Successful ({successCount})
              </button>
              <button
                type="button"
                onClick={() => setFilter('issues')}
                className={clsx(
                  'px-2.5 py-1 rounded-lg border transition-colors cursor-pointer',
                  filter === 'issues'
                    ? 'bg-rose-500/15 text-rose-300 border-rose-500/25'
                    : 'text-slate-400 border-transparent hover:bg-white/[0.04]'
                )}
              >
                Failed / Warnings ({issueCount})
              </button>
            </div>

            {/* Operations Feed */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {filteredOps.length === 0 ? (
                <div className="py-16 text-center text-xs text-slate-500">
                  No matching file operations recorded.
                </div>
              ) : (
                filteredOps.map((op) => {
                  const Icon =
                    op.status === 'success'
                      ? CheckCircle2
                      : op.status === 'error'
                        ? XCircle
                        : AlertTriangle;

                  return (
                    <div
                      key={op.id}
                      className={clsx(
                        'p-3.5 rounded-xl border bg-[#0D1018]',
                        op.status === 'success' && 'border-white/[0.06]',
                        op.status === 'error' && 'border-rose-500/30 bg-rose-950/10',
                        op.status === 'warning' && 'border-amber-500/25'
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <Icon
                          className={clsx(
                            'w-4 h-4 mt-0.5 shrink-0',
                            op.status === 'success' && 'text-emerald-400',
                            op.status === 'error' && 'text-rose-400',
                            op.status === 'warning' && 'text-amber-400'
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-100 truncate">
                              {op.title}
                            </span>
                            <span className="text-[10px] font-mono text-slate-500 shrink-0">
                              {formatRelativeTime(op.timestamp)}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed break-words">
                            {op.details}
                          </p>
                          {op.appId && (
                            <span className="inline-block mt-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-300">
                              AppID {op.appId}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {backups.length === 0 ? (
              <div className="py-16 text-center text-xs text-slate-500">
                No automatic backups have been created yet. Backups are saved automatically before replacing or deleting manifests.
              </div>
            ) : (
              backups.map((b) => (
                <div
                  key={b.id}
                  className="p-3.5 rounded-xl bg-[#0D1018] border border-white/[0.07] space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-mono font-semibold text-slate-100 truncate">
                        {b.originalFileName}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {formatBytes(b.sizeBytes)} ·{' '}
                        {b.appId !== 'unassigned'
                          ? `AppID ${b.appId}`
                          : 'Unassigned'}{' '}
                        · {formatRelativeTime(b.createdAt)}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400 shrink-0">
                      Before {b.reason}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-white/[0.05]">
                    <span className="text-[10px] font-mono text-slate-500">
                      sha256:{b.sha256.slice(0, 12)}
                    </span>
                    <button
                      type="button"
                      disabled={restoringId === b.id}
                      onClick={async () => {
                        setRestoringId(b.id);
                        try {
                          await onRestoreBackup(b.id);
                        } finally {
                          setRestoringId(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/25 transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>
                        {restoringId === b.id ? 'Restoring...' : 'Restore'}
                      </span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
