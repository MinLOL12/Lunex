import clsx from 'clsx';
import {
  FileCode2,
  Gamepad2,
  RefreshCw,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import type { NavSection } from '../types/lunex';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  gameCount: number;
  manifestCount: number;
  backupCount: number;
  autoBackup: boolean;
  isScanning: boolean;
  onRescan: () => void;
}

export function Sidebar({
  activeSection,
  onSelectSection,
  gameCount,
  manifestCount,
  backupCount,
  autoBackup,
  isScanning,
  onRescan,
}: SidebarProps) {
  const navItems: {
    id: NavSection;
    label: string;
    icon: typeof Gamepad2;
    badge?: number;
  }[] = [
    {
      id: 'library',
      label: 'Library',
      icon: Gamepad2,
      badge: gameCount,
    },
    {
      id: 'manifests',
      label: 'Manifests',
      icon: FileCode2,
      badge: manifestCount,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
    },
  ];

  return (
    <aside className="w-56 shrink-0 bg-[#0F1219] border-r border-white/[0.06] flex flex-col justify-between p-3 select-none">
      <nav className="space-y-1">
        <div className="px-2.5 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          Navigation
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              className={clsx(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer',
                active
                  ? 'bg-indigo-500/14 text-white border border-indigo-500/25 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] border border-transparent'
              )}
            >
              <span className="flex items-center gap-2.5">
                <Icon
                  className={clsx(
                    'w-4 h-4 transition-colors',
                    active ? 'text-indigo-400' : 'text-slate-500'
                  )}
                />
                <span>{item.label}</span>
              </span>
              {item.badge !== undefined && (
                <span
                  className={clsx(
                    'text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded-md',
                    active
                      ? 'bg-indigo-500/25 text-indigo-200'
                      : 'bg-white/[0.05] text-slate-400'
                  )}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="space-y-2.5 pt-3 border-t border-white/[0.06]">
        <div className="p-3 rounded-xl bg-[#141822] border border-white/[0.06] space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-slate-300 font-medium">
              <ShieldCheck
                className={clsx(
                  'w-3.5 h-3.5',
                  autoBackup ? 'text-emerald-400' : 'text-slate-500'
                )}
              />
              Auto Backup
            </span>
            <span
              className={clsx(
                'text-[10px] font-mono px-1.5 py-0.5 rounded',
                autoBackup
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-slate-700/40 text-slate-400'
              )}
            >
              {autoBackup ? 'ON' : 'OFF'}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {backupCount} saved backup{backupCount === 1 ? '' : 's'} ready for restore
          </p>
        </div>

        <button
          type="button"
          onClick={onRescan}
          disabled={isScanning}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-slate-300 bg-[#141822] hover:bg-[#191F2D] border border-white/[0.07] transition-colors disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw
            className={clsx('w-3.5 h-3.5 text-slate-400', isScanning && 'animate-spin')}
          />
          <span>{isScanning ? 'Scanning Steam...' : 'Rescan Directories'}</span>
        </button>
      </div>
    </aside>
  );
}
