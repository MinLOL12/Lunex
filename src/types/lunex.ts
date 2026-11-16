export type GameInstallStatus =
  | 'installed'
  | 'update_required'
  | 'manifest_only'
  | 'not_installed';

export type InstallIssueCode =
  | 'simulated_steam'
  | 'steam_path_mismatch'
  | 'custom_dir_mismatch'
  | 'missing_lua'
  | 'missing_depot_manifest'
  | 'missing_required_depot'
  | 'outdated_manifest'
  | 'missing_set_manifest_id'
  | 'commented_set_manifest_id'
  | 'manifest_id_mismatch'
  | 'manifest_header_mismatch'
  | 'missing_decryption_key'
  | 'invalid_decryption_key'
  | 'config_vdf_keys_missing'
  | 'zip_wrapped_manifest'
  | 'misnamed_manifest'
  | 'depotcache_desync'
  | 'conflicting_st_plugin'
  | 'duplicate_lua_conflict'
  | 'invalid_manifest_file'
  | 'stuck_download_queue'
  | 'steam_log_manifest_failed'
  | 'steam_log_missing_key'
  | 'steam_log_corrupt_manifest'
  | 'hosts_blocking_steam'
  | 'steam_plugin_missing'
  | 'steam_offline_mode'
  | 'steam_restart_required';

export interface InstallIssue {
  code: InstallIssueCode;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  autoFixable: boolean;
  depotId?: string;
  manifestId?: string;
  fileName?: string;
}

export interface ExpectedDepotStatus {
  depotId: string;
  hasDecryptionKey: boolean;
  keyInConfigVdf?: boolean;
  keyInvalid?: boolean;
  luaManifestId?: string;
  commentedManifestId?: string;
  diskManifestFile?: string;
  diskManifestId?: string;
  headerManifestId?: string;
  inDepotcache?: boolean;
  inConfigDepotcache?: boolean;
  inVault?: boolean;
  isZipWrapped?: boolean;
  liveManifestId?: string;
  liveSizeBytes?: number;
  liveOsList?: string;
  liveLanguage?: string;
  isDlcDepot?: boolean;
  isSharedDepot?: boolean;
  failedInSteamLog?: boolean;
  steamLogRequestedManifestId?: string;
}

export interface SteamLogManifestError {
  depotId: string;
  manifestId: string;
  reason: string;
  timestamp?: string;
}

export interface SteamLogDiagnostic {
  logFound: boolean;
  logPath?: string;
  lastErrorTimestamp?: string;
  lastErrorSummary?: string;
  failedManifests: SteamLogManifestError[];
  missingKeyDepots: string[];
  corruptManifestFiles: string[];
  recentLines: string[];
}

export interface LiveSteamDepotInfo {
  depotId: string;
  publicManifestId?: string;
  sizeBytes?: number;
  downloadBytes?: number;
  oslist?: string;
  language?: string;
  dlcAppId?: string;
  isShared?: boolean;
  depotFromApp?: string;
}

export interface LiveSteamAppInfo {
  appId: string;
  name?: string;
  buildId?: string;
  dlcAppIds: string[];
  depots: LiveSteamDepotInfo[];
  fetchedAt: string;
  steamReachable: boolean;
  error?: string;
}

export interface GameInstallDiagnostics {
  status: 'ready' | 'needs_attention' | 'blocked';
  issues: InstallIssue[];
  expectedDepots: ExpectedDepotStatus[];
  hasLua: boolean;
  hasManifestFiles: boolean;
  hasStuckDownloadState: boolean;
  steamRunning: boolean;
  pluginDetected: boolean;
  steamLog?: SteamLogDiagnostic;
  liveAppInfo?: LiveSteamAppInfo;
}

export interface SteamEnvironmentStatus {
  steamRunning: boolean;
  runningSteamPath?: string;
  steamPathMismatch?: boolean;
  pluginDetected: boolean;
  pluginFiles: string[];
  luaDirInSteam: boolean;
  manifestDirInSteam: boolean;
  configDepotcacheExists: boolean;
  offlineModeConfigured: boolean;
  hostsBlockingSteam: string[];
  needsSteamRestart: boolean;
}

export interface SteamGame {
  appId: string;
  name: string;
  status: GameInstallStatus;
  isManual: boolean;
  installDir?: string;
  libraryPath?: string;
  sizeOnDisk?: number;
  lastUpdated?: number;
  luaCount: number;
  manifestCount: number;
  linkedDepots: string[];
  localIconDataUrl?: string;
  installDiagnostics?: GameInstallDiagnostics;
}

export type ManifestFileType = 'lua' | 'manifest';

export interface ParsedLuaDirective {
  id: string;
  decryptionKey?: string;
  keyValid?: boolean;
  manifestId?: string;
  manifestIdValid?: boolean;
  commentedManifestId?: string;
}

export interface ManagedManifest {
  id: string;
  fileName: string;
  filePath: string;
  fileType: ManifestFileType;
  appId: string;
  gameName?: string;
  depotId?: string;
  manifestId?: string;
  headerDepotId?: string;
  headerManifestId?: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
  isValid: boolean;
  validationMessage: string;
  isDuplicate: boolean;
  duplicateOf?: string;
  directivesCount?: number;
  isZipWrapped?: boolean;
}

export interface ValidationResult {
  fileName: string;
  valid: boolean;
  fileType: ManifestFileType | 'unknown';
  detectedAppId?: string;
  detectedDepotId?: string;
  detectedManifestId?: string;
  headerDepotId?: string;
  headerManifestId?: string;
  directives?: ParsedLuaDirective[];
  sha256: string;
  sizeBytes: number;
  errors: string[];
  warnings: string[];
  duplicateStatus: 'none' | 'exact_duplicate' | 'will_replace';
  existingFilePath?: string;
  isZipWrapped?: boolean;
}

export interface IncomingFilePayload {
  fileName: string;
  base64Content: string;
  targetAppId?: string;
}

export interface ImportFileOutcome {
  fileName: string;
  status: 'imported' | 'replaced' | 'duplicate_skipped' | 'invalid_rejected' | 'error';
  message: string;
  appId?: string;
  backedUpTo?: string;
  validation: ValidationResult;
}

export interface BackupRecord {
  id: string;
  originalFileName: string;
  originalPath: string;
  backupFileName: string;
  backupPath: string;
  appId: string;
  fileType: ManifestFileType;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  reason: 'replace' | 'delete' | 'manual' | 'repair';
}

export interface OperationRecord {
  id: string;
  timestamp: string;
  action:
    | 'import'
    | 'validate'
    | 'delete'
    | 'backup'
    | 'restore'
    | 'add_game'
    | 'remove_game'
    | 'scan'
    | 'settings'
    | 'associate'
    | 'repair';
  status: 'success' | 'error' | 'warning';
  title: string;
  details: string;
  fileName?: string;
  appId?: string;
}

export interface DirectoryStatus {
  path: string;
  exists: boolean;
  writable: boolean;
  isCustom: boolean;
  autoDetectedPath: string;
}

export interface LunexSettings {
  steamPath: string;
  customLuaPath: string;
  customManifestPath: string;
  customBackupPath: string;
  autoBackup: boolean;
  launchWithWindows: boolean;
}

export interface SystemState {
  settings: LunexSettings;
  directories: {
    steam: DirectoryStatus;
    lua: DirectoryStatus;
    manifest: DirectoryStatus;
    backup: DirectoryStatus;
  };
  platform: string;
  isElectron: boolean;
  isSimulatedSteam: boolean;
  steamEnvironment: SteamEnvironmentStatus;
  games: SteamGame[];
  manifests: ManagedManifest[];
  backups: BackupRecord[];
  operations: OperationRecord[];
}

export interface ManifestInspection {
  manifest: ManagedManifest;
  textContent?: string;
  directives?: ParsedLuaDirective[];
  hexHeader?: string;
  magicValid?: boolean;
}

export interface RepairInstallOptions {
  restartSteam?: boolean;
  clearDownloadCache?: boolean;
  adoptRunningSteamPath?: boolean;
}

export interface RepairInstallResult {
  appId: string;
  fixedCount: number;
  actionsTaken: string[];
  warnings: string[];
  remainingIssues: InstallIssue[];
  steamStopped: boolean;
  steamRestarted: boolean;
  configVdfSyncedCount: number;
  mirroredManifestCount: number;
  downloadCacheCleared: boolean;
  state: SystemState;
}

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
}

export type NavSection = 'library' | 'manifests' | 'settings';
