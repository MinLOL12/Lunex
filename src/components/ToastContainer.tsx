import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from 'lucide-react';
import type { ToastItem } from '../types/lunex';

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const Icon =
          toast.type === 'success'
            ? CheckCircle2
            : toast.type === 'error'
              ? XCircle
              : toast.type === 'warning'
                ? AlertTriangle
                : Info;

        return (
          <div
            key={toast.id}
            className={clsx(
              'pointer-events-auto animate-toast-in flex items-start gap-3 p-3.5 rounded-xl border shadow-xl shadow-black/50 backdrop-blur-md bg-[#141925]/95',
              toast.type === 'success' && 'border-emerald-500/30',
              toast.type === 'error' && 'border-rose-500/35',
              toast.type === 'warning' && 'border-amber-500/30',
              toast.type === 'info' && 'border-indigo-500/30'
            )}
          >
            <Icon
              className={clsx(
                'w-4 h-4 mt-0.5 shrink-0',
                toast.type === 'success' && 'text-emerald-400',
                toast.type === 'error' && 'text-rose-400',
                toast.type === 'warning' && 'text-amber-400',
                toast.type === 'info' && 'text-indigo-400'
              )}
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-100 leading-snug">
                {toast.title}
              </p>
              {toast.message && (
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed break-words">
                  {toast.message}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="text-slate-500 hover:text-slate-300 transition-colors p-0.5 cursor-pointer"
              aria-label="Dismiss notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
