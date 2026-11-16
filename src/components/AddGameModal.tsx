import { Gamepad2, Plus, Sparkles, X } from 'lucide-react';
import { useState } from 'react';

interface AddGameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddGame: (appId: string, customName?: string) => Promise<void>;
}

const POPULAR_SUGGESTIONS = [
  { appId: '1086940', name: "Baldur's Gate 3" },
  { appId: '1174180', name: 'Red Dead Redemption 2' },
  { appId: '292030', name: 'The Witcher 3: Wild Hunt' },
  { appId: '814380', name: 'Sekiro: Shadows Die Twice' },
  { appId: '1593500', name: 'God of War' },
  { appId: '2050650', name: 'Resident Evil 4' },
];

export function AddGameModal({
  isOpen,
  onClose,
  onAddGame,
}: AddGameModalProps) {
  const [appId, setAppId] = useState('');
  const [customName, setCustomName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = appId.trim();
    if (!/^\d+$/.test(cleanId)) {
      setError('Enter a valid numeric Steam AppID (e.g. 1086940).');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      await onAddGame(cleanId, customName.trim() || undefined);
      setAppId('');
      setCustomName('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add game');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-2xl bg-[#141925] border border-white/[0.08] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/15 border border-indigo-500/25 text-indigo-400">
              <Gamepad2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Add Game by AppID
              </h2>
              <p className="text-xs text-slate-400">
                Register a Steam title manually to organize manifests
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

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label
              htmlFor="manual-appid-input"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              Steam AppID <span className="text-indigo-400">*</span>
            </label>
            <input
              id="manual-appid-input"
              type="text"
              inputMode="numeric"
              value={appId}
              onChange={(e) => {
                setAppId(e.target.value);
                setError('');
              }}
              placeholder="e.g. 1086940"
              autoFocus
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#0D1018] border border-white/[0.08] focus:border-indigo-500/60 focus:outline-none text-sm font-mono text-slate-100 placeholder:text-slate-600"
            />
          </div>

          <div>
            <label
              htmlFor="manual-name-input"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              Display Title{' '}
              <span className="text-slate-500 font-normal">
                (optional — auto-filled for known titles)
              </span>
            </label>
            <input
              id="manual-name-input"
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="e.g. Baldur's Gate 3"
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#0D1018] border border-white/[0.08] focus:border-indigo-500/60 focus:outline-none text-sm text-slate-100 placeholder:text-slate-600"
            />
          </div>

          {/* Quick Presets */}
          <div className="pt-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400 mb-2">
              <Sparkles className="w-3 h-3 text-indigo-400" />
              <span>Quick Select Popular AppIDs</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {POPULAR_SUGGESTIONS.map((item) => (
                <button
                  key={item.appId}
                  type="button"
                  onClick={() => {
                    setAppId(item.appId);
                    setCustomName(item.name);
                    setError('');
                  }}
                  className="px-2 py-1 rounded-lg text-[11px] bg-white/[0.04] hover:bg-indigo-500/15 text-slate-300 hover:text-indigo-200 border border-white/[0.06] hover:border-indigo-500/25 transition-colors cursor-pointer"
                >
                  <span className="font-mono text-slate-400 mr-1">
                    {item.appId}
                  </span>
                  {item.name}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-rose-500/12 border border-rose-500/25 text-xs text-rose-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-300 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !appId.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{submitting ? 'Adding...' : 'Add to Library'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
