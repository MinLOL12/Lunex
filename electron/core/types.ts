export type GameInstallStatus =
  | 'installed'
  | 'update_required'
  | 'manifest_only'
  | 'not_installed';

export type InstallIssueCode =
  | 'simulated_steam'
  | 'custom_dir_mismatch'
  | 'missing_lua'
  | 'missing_depot_manifest'
  | 'missing_set_manifest_id'
  | 'manifest_id_mismatch'
  | 'missing_decryption_key'
  | 'zip_wrapped_manifest'
  | 'misnamed_manifest'
  | 'invalid_manifest_file'
  | 'stuck_download_queue'
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
  luaManifestId?: string;
  diskManifestFile?: string;
  diskManifestId?: string;
  isZipWrapped?: boolean;
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
}

export interface SteamEnvironmentStatus {
  steamRunning: boolean;
  pluginDetected: boolean;
  pluginFiles: string[];
  luaDirInSteam: boolean;
  manifestDirInSteam: boolean;
  offlineModeConfigured: boolean;
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
  manifestId?: string;
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

export interface RepairInstallResult {
  appId: string;
  fixedCount: number;
  actionsTaken: string[];
  remainingIssues: InstallIssue[];
  steamRestarted: boolean;
  state: SystemState;
}
