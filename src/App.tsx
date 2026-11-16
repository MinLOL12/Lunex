import { Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AddGameModal } from './components/AddGameModal';
import { ImportModal } from './components/ImportModal';
import { InstallDiagnosticsModal } from './components/InstallDiagnosticsModal';
import { ManifestDetailModal } from './components/ManifestDetailModal';
import { OperationsLogPanel } from './components/OperationsLogPanel';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { ToastContainer } from './components/ToastContainer';
import { lunexClient } from './lib/client';
import type {
  ImportFileOutcome,
  LiveSteamAppInfo,
  LunexSettings,
  ManagedManifest,
  NavSection,
  RepairInstallResult,
  SystemState,
  ToastItem,
} from './types/lunex';
import { LibraryView } from './views/LibraryView';
import { ManifestsView } from './views/ManifestsView';
import { SettingsView } from './views/SettingsView';

export default function App() {
  const [state, setState] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);

  const [activeSection, setActiveSection] = useState<NavSection>('library');
  const [selectedAppIdFilter, setSelectedAppIdFilter] = useState<string | null>(
    null
  );

  // Modals & Drawers
  const [addGameOpen, setAddGameOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDefaultAppId, setImportDefaultAppId] = useState<
    string | undefined
  >(undefined);
  const [droppedFiles, setDroppedFiles] = useState<File[] | undefined>(
    undefined
  );
  const [inspectedManifest, setInspectedManifest] =
    useState<ManagedManifest | null>(null);
  const [diagnosedGameAppId, setDiagnosedGameAppId] = useState<string | null>(
    null
  );
  const [opsPanelOpen, setOpsPanelOpen] = useState(false);
  const [opsPanelTab, setOpsPanelTab] = useState<'operations' | 'backups'>(
    'operations'
  );

  // Global drag-and-drop indicator
  const [windowDragging, setWindowDragging] = useState(false);

  // Toast notifications
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback(
    (type: ToastItem['type'], title: string, message?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev.slice(-4), { id, type, title, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const data = await lunexClient.getState();
      setState(data);
    } catch (err) {
      pushToast(
        'error',
        'Failed to load Lunex state',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  // Close active overlays on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (diagnosedGameAppId) setDiagnosedGameAppId(null);
        else if (inspectedManifest) setInspectedManifest(null);
        else if (importOpen) setImportOpen(false);
        else if (addGameOpen) setAddGameOpen(false);
        else if (opsPanelOpen) setOpsPanelOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    diagnosedGameAppId,
    inspectedManifest,
    importOpen,
    addGameOpen,
    opsPanelOpen,
  ]);

  const handleRescan = async () => {
    setIsScanning(true);
    try {
      const updated = await lunexClient.rescan();
      setState(updated);
      pushToast(
        'success',
        'Steam Directories Scanned',
        `Found ${updated.games.length} games and ${updated.manifests.length} manifest files.`
      );
    } catch (err) {
      pushToast(
        'error',
        'Scan Failed',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setIsScanning(false);
    }
  };

  const handleAddManualGame = async (appId: string, customName?: string) => {
    const updated = await lunexClient.addManualGame(appId, customName);
    setState(updated);
    const added = updated.games.find((g) => g.appId === appId);
    pushToast(
      'success',
      `Added ${added?.name ?? `AppID ${appId}`}`,
      `AppID ${appId} is now available in your library.`
    );
  };

  const handleRemoveManualGame = async (appId: string) => {
    try {
      const updated = await lunexClient.removeManualGame(appId);
      setState(updated);
      pushToast('info', 'Removed Manual Entry', `AppID ${appId} removed.`);
    } catch (err) {
      pushToast(
        'error',
        'Remove Failed',
        err instanceof Error ? err.message : undefined
      );
    }
  };

  const handleOpenImport = (defaultAppId?: string, files?: File[]) => {
    setImportDefaultAppId(defaultAppId);
    setDroppedFiles(files);
    setImportOpen(true);
  };

  const handleImported = async (outcomes: ImportFileOutcome[]) => {
    const fresh = await lunexClient.getState().catch(() => null);
    if (fresh) {
      setState(fresh);
    } else {
      await refreshState();
    }
    const ok = outcomes.filter(
      (o) => o.status === 'imported' || o.status === 'replaced'
    );
    const skipped = outcomes.filter((o) => o.status === 'duplicate_skipped');
    const failed = outcomes.filter(
      (o) => o.status === 'invalid_rejected' || o.status === 'error'
    );

    if (ok.length > 0) {
      const backedUp = ok.filter((o) => o.backedUpTo).length;
      pushToast(
        'success',
        `Imported ${ok.length} Manifest File${ok.length === 1 ? '' : 's'}`,
        backedUp > 0
          ? `${backedUp} existing file(s) automatically backed up before replacement.`
          : ok.map((o) => o.fileName).join(', ')
      );

      if (fresh) {
        const affectedAppIds = Array.from(
          new Set(
            ok.map((o) => o.appId).filter((id): id is string => Boolean(id))
          )
        );
        const blockedGame = fresh.games.find(
          (g) =>
            affectedAppIds.includes(g.appId) &&
            g.installDiagnostics?.status === 'blocked'
        );
        if (blockedGame) {
          pushToast(
            'warning',
            `${blockedGame.name}: Install Setup Incomplete`,
            blockedGame.installDiagnostics!.issues[0]?.title ||
              'Open Fix Install on the game card before installing in Steam.'
          );
        } else if (fresh.steamEnvironment?.needsSteamRestart) {
          pushToast(
            'info',
            'Restart Steam to Apply Imported Manifests',
            'Open Fix Install → Stop Steam, Fix All & Restart so Steam reloads manifests and config.vdf.'
          );
        }
      }
    }
    if (skipped.length > 0) {
      pushToast(
        'warning',
        `Skipped ${skipped.length} Duplicate File${skipped.length === 1 ? '' : 's'}`,
        skipped[0].message
      );
    }
    if (failed.length > 0) {
      pushToast(
        'error',
        `Rejected ${failed.length} Invalid File${failed.length === 1 ? '' : 's'}`,
        failed[0].message
      );
    }
  };

  const handleRepaired = (result: RepairInstallResult) => {
    setState(result.state);
    if (result.warnings.length > 0) {
      pushToast('warning', `Repair Notice (AppID ${result.appId})`, result.warnings[0]);
    } else if (result.fixedCount > 0) {
      pushToast(
        'success',
        `Repaired AppID ${result.appId}`,
        result.actionsTaken[0]
      );
    } else if (result.remainingIssues.length > 0) {
      pushToast(
        'warning',
        'Manual Step Required',
        result.remainingIssues[0].title
      );
    } else {
      pushToast('info', 'No Issues Found', 'All manifest files and caches look ready.');
    }
  };

  const handleDiagnosticsStateUpdated = (
    updatedState: SystemState,
    liveInfo?: LiveSteamAppInfo
  ) => {
    setState(updatedState);
    if (liveInfo) {
      if (liveInfo.error) {
        pushToast('warning', 'Live Steam Check', liveInfo.error);
      } else {
        pushToast(
          'success',
          `Live Steam Depots Loaded (${liveInfo.name ?? liveInfo.appId})`,
          `Steam is online · ${liveInfo.depots.length} depots checked (Build ${liveInfo.buildId ?? '?'}).`
        );
      }
    }
  };

  const handleAssociateManifest = async (filePath: string, appId: string) => {
    try {
      const updated = await lunexClient.associateManifest(filePath, appId);
      setState(updated);
      const refreshed = updated.manifests.find((m) => m.filePath === filePath);
      if (inspectedManifest && refreshed) {
        setInspectedManifest(refreshed);
      }
      pushToast(
        'success',
        'Manifest Association Updated',
        appId === 'unassigned'
          ? 'Unlinked manifest from AppID.'
          : `Linked manifest to AppID ${appId}.`
      );
    } catch (err) {
      pushToast(
        'error',
        'Association Failed',
        err instanceof Error ? err.message : undefined
      );
    }
  };

  const handleDeleteManifest = async (filePath: string) => {
    try {
      const updated = await lunexClient.deleteManifest(filePath);
      setState(updated);
      pushToast(
        'success',
        'Manifest Deleted',
        updated.settings.autoBackup
          ? 'Removed file and archived safety backup.'
          : 'Removed file from disk.'
      );
    } catch (err) {
      pushToast(
        'error',
        'Delete Failed',
        err instanceof Error ? err.message : undefined
      );
    }
  };

  const handleRestoreBackup = async (backupId: string) => {
    try {
      const updated = await lunexClient.restoreBackup(backupId);
      setState(updated);
      pushToast(
        'success',
        'Backup Restored',
        'Restored manifest back to target Steam directory.'
      );
    } catch (err) {
      pushToast(
        'error',
        'Restore Failed',
        err instanceof Error ? err.message : undefined
      );
    }
  };

  const handleSaveSettings = async (partial: Partial<LunexSettings>) => {
    try {
      const updated = await lunexClient.updateSettings(partial);
      setState(updated);
      pushToast(
        'success',
        'Settings Saved',
        'Directory paths and preferences updated.'
      );
    } catch (err) {
      pushToast(
        'error',
        'Could Not Save Settings',
        err instanceof Error ? err.message : undefined
      );
    }
  };

  const handleClearOperations = async () => {
    const updated = await lunexClient.clearOperations();
    setState(updated);
  };

  if (loading || !state) {
    return (
      <div className="h-screen w-screen bg-[#0B0D12] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <img
            src="./lunex-icon.svg"
            alt="Lunex"
            className="w-10 h-10 animate-pulse"
          />
          <span className="text-xs font-medium text-slate-400">
            Initializing Lunex...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen w-screen flex flex-col bg-[#0B0D12] text-slate-100 overflow-hidden"
      onDragOver={(e) => {
        if (!importOpen && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setWindowDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setWindowDragging(false);
      }}
      onDrop={(e) => {
        if (!importOpen && e.dataTransfer.files?.length) {
          e.preventDefault();
          setWindowDragging(false);
          handleOpenImport(
            selectedAppIdFilter || undefined,
            Array.from(e.dataTransfer.files)
          );
        }
      }}
    >
      <TitleBar
        steamReady={state.directories.steam.exists}
        steamPath={state.directories.steam.path}
        isSimulatedSteam={state.isSimulatedSteam}
        operations={state.operations}
        onOpenImport={() =>
          handleOpenImport(selectedAppIdFilter || undefined)
        }
        onToggleOperations={() => {
          setOpsPanelTab('operations');
          setOpsPanelOpen((v) => !v);
        }}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        <Sidebar
          activeSection={activeSection}
          onSelectSection={(sec) => {
            setActiveSection(sec);
            if (sec !== 'manifests') {
              setSelectedAppIdFilter(null);
            }
          }}
          gameCount={state.games.length}
          manifestCount={state.manifests.length}
          backupCount={state.backups.length}
          autoBackup={state.settings.autoBackup}
          isScanning={isScanning}
          onRescan={() => void handleRescan()}
        />

        <main className="flex-1 min-w-0 bg-[#0B0D12] overflow-hidden">
          {activeSection === 'library' && (
            <LibraryView
              games={state.games}
              onOpenAddModal={() => setAddGameOpen(true)}
              onQuickAddAppId={handleAddManualGame}
              onManageManifests={(appId) => {
                setSelectedAppIdFilter(appId);
                setActiveSection('manifests');
              }}
              onImportForGame={(appId) => handleOpenImport(appId)}
              onRemoveManualGame={(appId) => void handleRemoveManualGame(appId)}
              onDiagnoseGame={(game) => setDiagnosedGameAppId(game.appId)}
            />
          )}

          {activeSection === 'manifests' && (
            <ManifestsView
              manifests={state.manifests}
              games={state.games}
              luaDir={state.directories.lua}
              manifestDir={state.directories.manifest}
              backupCount={state.backups.length}
              selectedAppIdFilter={selectedAppIdFilter}
              onClearAppIdFilter={() => setSelectedAppIdFilter(null)}
              onSelectAppIdFilter={setSelectedAppIdFilter}
              onOpenImport={(appId) => handleOpenImport(appId)}
              onOpenBackups={() => {
                setOpsPanelTab('backups');
                setOpsPanelOpen(true);
              }}
              onAssociateManifest={handleAssociateManifest}
              onDeleteManifest={handleDeleteManifest}
              onInspectManifest={(mf) => setInspectedManifest(mf)}
              onDiagnoseGame={(game) => setDiagnosedGameAppId(game.appId)}
            />
          )}

          {activeSection === 'settings' && (
            <SettingsView
              settings={state.settings}
              directories={state.directories}
              steamEnvironment={state.steamEnvironment}
              platform={state.platform}
              backupCount={state.backups.length}
              onSaveSettings={handleSaveSettings}
              onOpenBackups={() => {
                setOpsPanelTab('backups');
                setOpsPanelOpen(true);
              }}
            />
          )}
        </main>

        {/* Full-Window Drop Overlay */}
        {windowDragging && !importOpen && (
          <div className="absolute inset-3 z-30 rounded-2xl border-2 border-dashed border-indigo-400 bg-[#0D111C]/90 backdrop-blur-xs flex flex-col items-center justify-center pointer-events-none">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300 mb-3">
              <Upload className="w-7 h-7" />
            </div>
            <p className="text-sm font-semibold text-slate-100">
              Drop .lua or .manifest files to validate & import
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Lunex will inspect headers, detect duplicates, and back up existing files
            </p>
          </div>
        )}
      </div>

      {/* Modals & Drawers */}
      <AddGameModal
        isOpen={addGameOpen}
        onClose={() => setAddGameOpen(false)}
        onAddGame={handleAddManualGame}
      />

      <ImportModal
        isOpen={importOpen}
        defaultAppId={importDefaultAppId}
        initialDroppedFiles={droppedFiles}
        games={state.games}
        autoBackup={state.settings.autoBackup}
        isSimulatedSteam={state.isSimulatedSteam}
        onClose={() => {
          setImportOpen(false);
          setDroppedFiles(undefined);
        }}
        onImported={(outcomes) => void handleImported(outcomes)}
        onOpenSettings={() => setActiveSection('settings')}
      />

      <InstallDiagnosticsModal
        game={
          diagnosedGameAppId
            ? state.games.find((g) => g.appId === diagnosedGameAppId) ?? null
            : null
        }
        isSimulatedSteam={state.isSimulatedSteam}
        onClose={() => setDiagnosedGameAppId(null)}
        onRepaired={handleRepaired}
        onStateUpdated={handleDiagnosticsStateUpdated}
        onOpenImportForGame={(appId) => handleOpenImport(appId)}
        onOpenSettings={() => setActiveSection('settings')}
      />

      <ManifestDetailModal
        manifest={inspectedManifest}
        games={state.games}
        onClose={() => setInspectedManifest(null)}
        onAssociate={handleAssociateManifest}
        onDelete={handleDeleteManifest}
      />

      <OperationsLogPanel
        isOpen={opsPanelOpen}
        initialTab={opsPanelTab}
        operations={state.operations}
        backups={state.backups}
        onClose={() => setOpsPanelOpen(false)}
        onClearOperations={handleClearOperations}
        onRestoreBackup={handleRestoreBackup}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
