import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  Minus,
  Square,
   Upload,
  X,
} from 'lucide-react';
import { isDesktopElectron, lunexClient } from '../lib/client';
import type { OperationRecord } from '../types/lunex';

interface TitleBarProps {
  steamReady: boolean;
  steamPath: string;
  isSimulatedSteam: boolean;
  operations: OperationRecord[];
  onOpenImport: () => void;
  onToggleOperations: () => void;
}

export function TitleBar({
  steamReady,
  steamPath,
  isSimulatedSteam,
  operations,
  onOpenImport,
  onToggleOperations,
}: TitleBarProps) {
  const isElectron = isDesktopElectron();
  const failedCount = operations.filter((o) => o.status === 'error').length;

  return (
    <header className="h-12 shrink-0 bg-[#0D1017] border-b border-white/[0.06] flex items-center justify-between px-4 select-none app-drag-region">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2.5">
          <img
            src="./lunex-icon.svg"
            alt="Lunex"
            className="w-6 h-6 rounded-md shrink-0"
          />
          <span className="text-sm font-semibold tracking-tight text-slate-100">
            Lunex
          </span>
          <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/20">
            v1.0
          </span>
        </div>

        <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-400 pl-3 border-l border-white/[0.06] truncate max-w-md">
          {steamReady ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          )}
          <span className="truncate font-mono text-[11px] text-slate-400" title={steamPath}>
            {steamPath}
          </span>
          {isSimulatedSteam && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-white/[0.06] shrink-0">
              Workspace Steam
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 app-no-drag">
        <button
          type="button"
          onClick={onOpenImport}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors shadow-sm shadow-indigo-950/50 cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Import Files</span>
        </button>

        <button
          type="button"
          onClick={onToggleOperations}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#141924] hover:bg-[#1B2230] text-slate-300 border border-white/[0.07] transition-colors cursor-pointer"
          title="View Successful & Failed File Operations"
        >
          <Activity className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden sm:inline">Operations</span>
          <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-white/[0.06] text-slate-300">
            {operations.length}
          </span>
          {failedCount > 0 && (
            <span className="w-2 h-2 rounded-full bg-rose-500" title={`${failedCount} failed operation(s)`} />
          )}
        </button>

        {isElectron && (
          <div className="flex items-center ml-2 pl-2 border-l border-white/[0.06]">
            <button
              type="button"
              onClick={() => lunexClient.windowControl('minimize')}
              className="p-1.5 rounded hover:bg-white/[0.07] text-slate-400 hover:text-slate-200 transition-colors"
              aria-label="Minimize"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => lunexClient.windowControl('maximize')}
              className="p-1.5 rounded hover:bg-white/[0.07] text-slate-400 hover:text-slate-200 transition-colors"
              aria-label="Maximize"
            >
              <Square className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => lunexClient.windowControl('close')}
              className="p-1.5 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition-colors"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
