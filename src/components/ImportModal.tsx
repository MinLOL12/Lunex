import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  FileCheck2,
  FlaskConical,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  fileToBase64,
  formatBytes,
  isDesktopElectron,
  lunexClient,
} from '../lib/client';
import type {
  ImportFileOutcome,
  IncomingFilePayload,
  SteamGame,
  ValidationResult,
} from '../types/lunex';

interface StagedFile {
  id: string;
  fileName: string;
  base64Content: string;
  targetAppId: string;
  validation?: ValidationResult;
}

interface ImportModalProps {
  isOpen: boolean;
  defaultAppId?: string;
  initialDroppedFiles?: File[];
  games: SteamGame[];
  autoBackup: boolean;
  isSimulatedSteam?: boolean;
  onClose: () => void;
  onImported: (outcomes: ImportFileOutcome[]) => void;
  onOpenSettings?: () => void;
}

export function ImportModal({
  isOpen,
  defaultAppId,
  initialDroppedFiles,
  games,
  autoBackup,
  isSimulatedSteam,
  onClose,
  onImported,
  onOpenSettings,
}: ImportModalProps) {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [allowReplaceDuplicates, setAllowReplaceDuplicates] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Optional inline Lua composer
  const [mode, setMode] = useState<'files' | 'paste'>('files');
  const [luaFileName, setLuaFileName] = useState('');
  const [luaScript, setLuaScript] = useState('');

  // Sample test packs in web preview
  const [samples, setSamples] = useState<
    { label: string; description: string; files: IncomingFilePayload[] }[]
  >([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setStaged([]);
      setMode('files');
      setLuaFileName(defaultAppId ? `${defaultAppId}.lua` : '');
      setLuaScript('');
      setAllowReplaceDuplicates(false);
      return;
    }
    if (!isDesktopElectron()) {
      lunexClient
        .getSamplePacks()
        .then(setSamples)
        .catch(() => setSamples([]));
    }
  }, [isOpen, defaultAppId]);

  useEffect(() => {
    if (isOpen && initialDroppedFiles && initialDroppedFiles.length > 0) {
      void ingestBrowserFiles(initialDroppedFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialDroppedFiles]);

  const runValidation = async (items: StagedFile[]) => {
    if (items.length === 0) {
      setStaged([]);
      return;
    }
    setValidating(true);
    try {
      const payloads: IncomingFilePayload[] = items.map((s) => ({
        fileName: s.fileName,
        base64Content: s.base64Content,
        targetAppId: s.targetAppId || undefined,
      }));
      const results = await lunexClient.validateFiles(payloads);
      setStaged(
        items.map((item, idx) => {
          const val = results[idx];
          return {
            ...item,
            targetAppId:
              item.targetAppId ||
              defaultAppId ||
              val?.detectedAppId ||
              '',
            validation: val,
          };
        })
      );
    } finally {
      setValidating(false);
    }
  };

  const ingestBrowserFiles = async (fileList: File[] | FileList) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;

    const rawPayloads: IncomingFilePayload[] = await Promise.all(
      arr.map(async (f) => ({
        fileName: f.name,
        base64Content: await fileToBase64(f),
        targetAppId: defaultAppId || undefined,
      }))
    );

    const hasZip = rawPayloads.some((p) =>
      p.fileName.toLowerCase().endsWith('.zip')
    );
    const expanded = hasZip
      ? await lunexClient.unpackZip(rawPayloads)
      : rawPayloads;

    const converted: StagedFile[] = expanded.map((p) => ({
      id: `${p.fileName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fileName: p.fileName,
      base64Content: p.base64Content,
      targetAppId: p.targetAppId || defaultAppId || '',
    }));

    const combined = [...staged, ...converted];
    await runValidation(combined);
  };

  const ingestPayloads = async (payloads: IncomingFilePayload[]) => {
    const converted: StagedFile[] = payloads.map((p) => ({
      id: `${p.fileName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fileName: p.fileName,
      base64Content: p.base64Content,
      targetAppId: p.targetAppId || defaultAppId || '',
    }));
    const combined = [...staged, ...converted];
    await runValidation(combined);
  };

  const handleStagePastedLua = async () => {
    const cleanScript = luaScript.trim();
    if (!cleanScript) return;
    let name = luaFileName.trim() || (defaultAppId ? `${defaultAppId}.lua` : 'manifest.lua');
    if (!name.toLowerCase().endsWith('.lua')) {
      name += '.lua';
    }
    const base64Content = btoa(unescape(encodeURIComponent(cleanScript)));
    setLuaScript('');
    setMode('files');
    await ingestPayloads([
      {
        fileName: name,
        base64Content,
        targetAppId: defaultAppId,
      },
    ]);
  };

  const handleUpdateTargetAppId = (id: string, nextAppId: string) => {
    setStaged((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, targetAppId: nextAppId } : item
      )
    );
  };

  const handleRemoveStaged = (id: string) => {
    setStaged((prev) => prev.filter((item) => item.id !== id));
  };

  const handleImportAll = async () => {
    if (staged.length === 0) return;
    setImporting(true);
    try {
      const payloads: IncomingFilePayload[] = staged.map((s) => ({
        fileName: s.fileName,
        base64Content: s.base64Content,
        targetAppId: s.targetAppId.trim() || undefined,
      }));
      const res = await lunexClient.importFiles(payloads, {
        allowReplaceDuplicates,
        syncLuaDirectives: true,
      });
      onImported(res.outcomes);
      onClose();
    } finally {
      setImporting(false);
    }
  };

  if (!isOpen) return null;

  const validCount = staged.filter((s) => s.validation?.valid).length;
  const replaceCount = staged.filter(
    (s) => s.validation?.duplicateStatus === 'will_replace'
  ).length;
  const duplicateCount = staged.filter(
    (s) => s.validation?.duplicateStatus === 'exact_duplicate'
  ).length;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-[#131824] border border-white/[0.08] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-500/15 border border-indigo-500/25 text-indigo-400">
              <Upload className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Import .lua & .manifest Files
              </h2>
              <p className="text-xs text-slate-400">
                Files are validated for integrity & duplicates before writing to Steam
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-[#0C0F17] p-0.5 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setMode('files')}
                className={clsx(
                  'px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer',
                  mode === 'files'
                    ? 'bg-indigo-500/20 text-indigo-200'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                Upload Files
              </button>
              <button
                type="button"
                onClick={() => setMode('paste')}
                className={clsx(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer',
                  mode === 'paste'
                    ? 'bg-indigo-500/20 text-indigo-200'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                <Code2 className="w-3 h-3" />
                Paste .lua
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {mode === 'files' ? (
            <>
              {/* Dropzone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files?.length) {
                    void ingestBrowserFiles(e.dataTransfer.files);
                  }
                }}
                onClick={() => fileInputRef.current?.click()}
                className={clsx(
                  'border-2 border-dashed rounded-2xl p-6 text-center transition-all cursor-pointer',
                  isDragging
                    ? 'border-indigo-400 bg-indigo-500/10'
                    : 'border-white/[0.1] hover:border-indigo-500/40 bg-[#0D1018]/70 hover:bg-[#0D1018]'
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".lua,.manifest,.zip"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) {
                      void ingestBrowserFiles(e.target.files);
                      e.target.value = '';
                    }
                  }}
                />
                <div className="w-10 h-10 mx-auto mb-2.5 rounded-xl bg-indigo-500/12 border border-indigo-500/25 flex items-center justify-center text-indigo-400">
                  <FileCheck2 className="w-5 h-5" />
                </div>
                <p className="text-xs font-medium text-slate-200">
                  Drop <span className="font-mono text-indigo-300">.lua</span>,{' '}
                  <span className="font-mono text-sky-300">.manifest</span>, or{' '}
                  <span className="font-mono text-emerald-300">.zip</span> bundles here, or click to browse
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Checks Valve DepotManifest headers, unwraps ZIP-compressed manifests, validates Lua directives, and syncs setManifestid()
                </p>
              </div>

              {isSimulatedSteam && (
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <span>
                      Lunex is currently importing into its <strong>Workspace Steam</strong> folder because no local Steam install was auto-detected. Set your real Steam path in Settings for Steam to use these files.
                    </span>
                  </div>
                  {onOpenSettings && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenSettings();
                      }}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 shrink-0 cursor-pointer"
                    >
                      Settings
                    </button>
                  )}
                </div>
              )}

              {/* Sample Test Bundles in Web Preview */}
              {samples.length > 0 && (
                <div className="rounded-xl bg-[#0E121B] border border-white/[0.06] p-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400 mb-2">
                    <FlaskConical className="w-3.5 h-3.5 text-sky-400" />
                    <span>Quick Test Payloads (Stage sample files to test validation & backup)</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {samples.map((sample) => (
                      <button
                        key={sample.label}
                        type="button"
                        onClick={() => void ingestPayloads(sample.files)}
                        className="text-left p-2.5 rounded-lg bg-white/[0.03] hover:bg-indigo-500/12 border border-white/[0.06] hover:border-indigo-500/25 transition-colors cursor-pointer"
                      >
                        <div className="text-[11px] font-medium text-slate-200 line-clamp-1">
                          {sample.label}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-2">
                          {sample.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3 rounded-xl bg-[#0D1018] border border-white/[0.07] p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Target Filename
                  </label>
                  <input
                    type="text"
                    value={luaFileName}
                    onChange={(e) => setLuaFileName(e.target.value)}
                    placeholder="e.g. 1086940.lua"
                    className="w-full px-3 py-2 rounded-lg bg-[#141925] border border-white/[0.08] text-xs font-mono text-slate-100 focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Lua Manifest Script
                </label>
                <textarea
                  rows={6}
                  value={luaScript}
                  onChange={(e) => setLuaScript(e.target.value)}
                  placeholder={`addappid(1086940)\naddappid(1086941, 1, "decryption_key_hex")\nsetManifestid(1086941, "5512901928374651092", 0)`}
                  className="w-full px-3 py-2 rounded-lg bg-[#141925] border border-white/[0.08] text-xs font-mono text-slate-100 focus:border-indigo-500/50 focus:outline-none resize-none"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!luaScript.trim()}
                  onClick={() => void handleStagePastedLua()}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white transition-colors cursor-pointer"
                >
                  Validate & Stage Script
                </button>
              </div>
            </div>
          )}

          {/* Staged Validation Queue */}
          {staged.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300">
                  Pre-Import Validation ({staged.length} file{staged.length === 1 ? '' : 's'})
                </span>
                {validating && (
                  <span className="text-indigo-400 text-[11px]">Validating...</span>
                )}
              </div>

              <div className="space-y-2">
                {staged.map((item) => {
                  const val = item.validation;
                  const isValid = val?.valid ?? false;
                  const dup = val?.duplicateStatus ?? 'none';

                  return (
                    <div
                      key={item.id}
                      className={clsx(
                        'p-3 rounded-xl border bg-[#0E121B] flex flex-col gap-2.5',
                        !val
                          ? 'border-white/[0.07]'
                          : !isValid
                            ? 'border-rose-500/35 bg-rose-950/10'
                            : dup === 'exact_duplicate'
                              ? 'border-amber-500/30'
                              : 'border-white/[0.08]'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-semibold text-slate-100 truncate">
                              {item.fileName}
                            </span>
                            {val && (
                              <span
                                className={clsx(
                                  'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border',
                                  val.fileType === 'lua'
                                    ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25'
                                    : val.fileType === 'manifest'
                                      ? 'bg-sky-500/15 text-sky-300 border-sky-500/25'
                                      : 'bg-rose-500/15 text-rose-300 border-rose-500/25'
                                )}
                              >
                                {val.fileType}
                              </span>
                            )}
                            {val && (
                              <span className="text-[11px] font-mono text-slate-500">
                                {formatBytes(val.sizeBytes)} · sha256:{val.sha256.slice(0, 8)}
                              </span>
                            )}
                          </div>

                          {/* Validation Status Messages */}
                          {val && !val.valid && (
                            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-rose-300">
                              <XCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                              <span>{val.errors.join(' ')}</span>
                            </p>
                          )}

                          {val && val.valid && val.warnings.length > 0 && (
                            <div className="mt-1 space-y-1">
                              {val.warnings.map((warn, wIdx) => (
                                <p
                                  key={wIdx}
                                  className="flex items-start gap-1.5 text-[11px] text-amber-300"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400 mt-0.5" />
                                  <span>{warn}</span>
                                </p>
                              ))}
                            </div>
                          )}

                          {val && val.valid && val.warnings.length === 0 && (
                            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-emerald-300">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                              <span>
                                Verified {val.fileType === 'lua' ? `(${val.directives?.length ?? 0} depot directive(s))` : 'Steam DepotManifest header'}
                              </span>
                            </p>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveStaged(item.id)}
                          className="p-1 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
                          title="Remove from queue"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* AppID Association Controls for Valid Files */}
                      {val?.valid && (
                        <div className="flex items-center gap-2 pt-2 border-t border-white/[0.05] text-xs">
                          <span className="text-slate-400 text-[11px] shrink-0">
                            Associate AppID:
                          </span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={item.targetAppId}
                            onChange={(e) =>
                              handleUpdateTargetAppId(item.id, e.target.value)
                            }
                            placeholder="AppID (e.g. 1091500)"
                            className="w-36 px-2.5 py-1 rounded-lg bg-[#141925] border border-white/[0.08] font-mono text-xs text-slate-200 focus:border-indigo-500/50 focus:outline-none"
                          />
                          <select
                            value={
                              games.some((g) => g.appId === item.targetAppId)
                                ? item.targetAppId
                                : ''
                            }
                            onChange={(e) => {
                              if (e.target.value) {
                                handleUpdateTargetAppId(item.id, e.target.value);
                              }
                            }}
                            className="flex-1 min-w-0 px-2.5 py-1 rounded-lg bg-[#141925] border border-white/[0.08] text-xs text-slate-300 focus:border-indigo-500/50 focus:outline-none"
                          >
                            <option value="">Select from Library...</option>
                            {games.map((g) => (
                              <option key={g.appId} value={g.appId}>
                                {g.name} ({g.appId})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Backup & Duplicate Notices */}
          {replaceCount > 0 && autoBackup && (
            <div className="flex items-center gap-2.5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-200">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>
                Automatic Backup is active: {replaceCount} existing manifest
                {replaceCount === 1 ? '' : 's'} will be backed up before replacement.
              </span>
            </div>
          )}

          {duplicateCount > 0 && (
            <label className="flex items-center gap-2.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 cursor-pointer">
              <input
                type="checkbox"
                checked={allowReplaceDuplicates}
                onChange={(e) => setAllowReplaceDuplicates(e.target.checked)}
                className="rounded border-amber-500/40 bg-black/40 text-indigo-500"
              />
              <span>
                Re-write exact duplicate files anyway ({duplicateCount} detected by SHA-256)
              </span>
            </label>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06] bg-[#0F131D] shrink-0">
          <span className="text-xs text-slate-400">
            {staged.length === 0
              ? 'No files staged yet'
              : `${validCount} of ${staged.length} file(s) passed validation`}
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-300 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={importing || staged.length === 0}
              onClick={() => void handleImportAll()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>
                {importing
                  ? 'Importing...'
                  : `Import ${staged.length > 0 ? `(${staged.length})` : ''}`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
