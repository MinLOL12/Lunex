import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkHostsBlockingSteam,
  fetchLiveSteamAppInfo,
  parseSteamContentLogText,
} from './steamDiagnostics.js';
import {
  checkSteamOfflineConfig,
  clearSteamOfflineConfig,
  detectSteamPlugins,
  getRunningSteamPath,
  isSteamProcessRunning,
  KNOWN_STEAM_TITLES,
  locateSteamDirectory,
  startSteamClient,
  stopSteamClient,
} from './steamLocator.js';
import type {
  BackupRecord,
  DirectoryStatus,
  ExpectedDepotStatus,
  GameInstallDiagnostics,
  GameInstallStatus,
  ImportFileOutcome,
  IncomingFilePayload,
  InstallIssue,
  LiveSteamAppInfo,
  LunexSettings,
  ManagedManifest,
  ManifestFileType,
  ManifestInspection,
  OperationRecord,
  ParsedLuaDirective,
  RepairInstallOptions,
  RepairInstallResult,
  SteamEnvironmentStatus,
  SteamGame,
  SteamLogDiagnostic,
  SystemState,
  ValidationResult,
} from './types.js';
import {
  computeSha256,
  extractManifestZipBundle,
  isRawSteamDepotManifest,
  isValidDepotDecryptionKey,
  isValidManifestGid,
  parseDepotManifestMetadata,
  parseLuaDirectives,
  STEAM_MANIFEST_MAGIC,
  unwrapZipManifestBuffer,
  upsertLuaManifestDirectives,
  validateManifestBuffer,
  ZIP_LOCAL_MAGIC,
} from './validator.js';
import {
  parseAppManifestAcf,
  parseLibraryFoldersVdf,
  readConfigVdfDepots,
  upsertConfigVdfDepotKeys,
} from './vdfParser.js';

interface ManualGameEntry {
  appId: string;
  name: string;
  addedAt: string;
}

export interface LunexManagerOptions {
  dataDir: string;
  isElectron?: boolean;
  onLaunchWithWindowsChange?: (enabled: boolean) => void;
}

const DEFAULT_SETTINGS: LunexSettings = {
  steamPath: '',
  customLuaPath: '',
  customManifestPath: '',
  customBackupPath: '',
  autoBackup: true,
  launchWithWindows: false,
};

function normalizePathKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readTailIfExists(filePath: string, maxBytes = 512 * 1024): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl !== -1) text = text.slice(nl + 1);
      }
      return text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export class LunexManager {
  private readonly dataDir: string;
  private readonly isElectron: boolean;
  private readonly onLaunchWithWindowsChange?: (enabled: boolean) => void;

  private settings: LunexSettings;
  private manualGames: ManualGameEntry[];
  private associations: Record<string, string>; // key: normalized filePath or fileName -> appId
  private backups: BackupRecord[];
  private operations: OperationRecord[];
  private liveAppInfoCache: Record<string, LiveSteamAppInfo>;
  private modifiedWhileSteamRunning = false;

  constructor(options: LunexManagerOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.isElectron = Boolean(options.isElectron);
    this.onLaunchWithWindowsChange = options.onLaunchWithWindowsChange;

    fs.mkdirSync(this.dataDir, { recursive: true });

    this.settings = this.readJsonFile<LunexSettings>('settings.json', {
      ...DEFAULT_SETTINGS,
    });
    this.manualGames = this.readJsonFile<ManualGameEntry[]>(
      'manual-games.json',
      []
    );
    this.associations = this.readJsonFile<Record<string, string>>(
      'manifest-associations.json',
      {}
    );
    this.backups = this.readJsonFile<BackupRecord[]>('backups-index.json', []);
    this.operations = this.readJsonFile<OperationRecord[]>(
      'operations-log.json',
      []
    );
    this.liveAppInfoCache = this.readJsonFile<Record<string, LiveSteamAppInfo>>(
      'live-appinfo-cache.json',
      {}
    );

    if (this.operations.length === 0) {
      const located = locateSteamDirectory(this.dataDir);
      this.recordOperation({
        action: 'scan',
        status: 'success',
        title: 'Steam Environment Initialized',
        details: located.isSimulated
          ? `Initialized workspace Steam directory at ${located.steamPath}`
          : `Detected Steam installation at ${located.steamPath}`,
      });
    }
  }

  private filePath(name: string): string {
    return path.join(this.dataDir, name);
  }

  private getManifestVaultDir(): string {
    return path.join(this.dataDir, 'manifest-vault');
  }

  private readJsonFile<T>(name: string, fallback: T): T {
    const target = this.filePath(name);
    try {
      if (!fs.existsSync(target)) return fallback;
      const raw = fs.readFileSync(target, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private writeJsonFile(name: string, data: unknown): void {
    const target = this.filePath(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
  }

  private recordOperation(
    entry: Omit<OperationRecord, 'id' | 'timestamp'>
  ): OperationRecord {
    const record: OperationRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.operations.unshift(record);
    if (this.operations.length > 200) {
      this.operations = this.operations.slice(0, 200);
    }
    this.writeJsonFile('operations-log.json', this.operations);
    return record;
  }

  private checkDirectoryStatus(
    targetPath: string,
    autoDetectedPath: string,
    isCustom: boolean,
    autoCreateIfDefault = false
  ): DirectoryStatus {
    const resolved = path.resolve(targetPath);
    if (autoCreateIfDefault && !isCustom && !fs.existsSync(resolved)) {
      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch {
        // Leave exists=false if unable to create
      }
    }

    let exists = false;
    let writable = false;
    try {
      const stat = fs.statSync(resolved);
      exists = stat.isDirectory();
      if (exists) {
        fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
        writable = true;
      }
    } catch {
      // Directory missing or not writable
    }

    return {
      path: resolved,
      exists,
      writable,
      isCustom,
      autoDetectedPath: path.resolve(autoDetectedPath),
    };
  }

  public resolveDirectories(): {
    steam: DirectoryStatus;
    lua: DirectoryStatus;
    manifest: DirectoryStatus;
    backup: DirectoryStatus;
    isSimulatedSteam: boolean;
  } {
    const located = locateSteamDirectory(this.dataDir);
    const effectiveSteam = this.settings.steamPath.trim()
      ? path.resolve(this.settings.steamPath.trim())
      : located.steamPath;

    const defaultLua = path.join(effectiveSteam, 'config', 'stplug-in');
    const effectiveLua = this.settings.customLuaPath.trim()
      ? path.resolve(this.settings.customLuaPath.trim())
      : defaultLua;

    const defaultManifest = path.join(effectiveSteam, 'depotcache');
    const effectiveManifest = this.settings.customManifestPath.trim()
      ? path.resolve(this.settings.customManifestPath.trim())
      : defaultManifest;

    const defaultBackup = path.join(this.dataDir, 'backups');
    const effectiveBackup = this.settings.customBackupPath.trim()
      ? path.resolve(this.settings.customBackupPath.trim())
      : defaultBackup;

    const steamExists = (() => {
      try {
        return fs.statSync(effectiveSteam).isDirectory();
      } catch {
        return false;
      }
    })();

    return {
      steam: this.checkDirectoryStatus(
        effectiveSteam,
        located.steamPath,
        Boolean(this.settings.steamPath.trim()),
        false
      ),
      lua: this.checkDirectoryStatus(
        effectiveLua,
        defaultLua,
        Boolean(this.settings.customLuaPath.trim()),
        steamExists
      ),
      manifest: this.checkDirectoryStatus(
        effectiveManifest,
        defaultManifest,
        Boolean(this.settings.customManifestPath.trim()),
        steamExists
      ),
      backup: this.checkDirectoryStatus(
        effectiveBackup,
        defaultBackup,
        Boolean(this.settings.customBackupPath.trim()),
        true
      ),
      isSimulatedSteam:
        located.isSimulated && !Boolean(this.settings.steamPath.trim()),
    };
  }

  private getLibraryRoots(steamPath: string, steamExists: boolean): Set<string> {
    const libraryRoots = new Set<string>();
    if (!steamExists) return libraryRoots;

    libraryRoots.add(steamPath);
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (fs.existsSync(vdfPath)) {
      try {
        const content = fs.readFileSync(vdfPath, 'utf8');
        for (const libPath of parseLibraryFoldersVdf(content)) {
          if (fs.existsSync(libPath)) {
            libraryRoots.add(path.resolve(libPath));
          }
        }
      } catch {
        // Ignore malformed libraryfolders.vdf
      }
    }
    return libraryRoots;
  }

  private readConfigVdfKeys(steamPath: string): Map<string, string> {
    const configPath = path.join(steamPath, 'config', 'config.vdf');
    if (!fs.existsSync(configPath)) return new Map();
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      return readConfigVdfDepots(raw);
    } catch {
      return new Map();
    }
  }

  /**
   * Indexes canonical <depotId>_<manifestId>.manifest files in an auxiliary folder
   * (such as Steam/config/depotcache or Lunex's protected manifest-vault).
   */
  private indexAuxiliaryManifestDir(
    dirPath: string
  ): { byKey: Map<string, string>; byDepot: Map<string, { manifestId: string; filePath: string; fileName: string }[]> } {
    const byKey = new Map<string, string>();
    const byDepot = new Map<
      string,
      { manifestId: string; filePath: string; fileName: string }[]
    >();
    if (!fs.existsSync(dirPath)) return { byKey, byDepot };

    try {
      for (const fileName of fs.readdirSync(dirPath)) {
        if (path.extname(fileName).toLowerCase() !== '.manifest') continue;
        const m = /^(\d+)_(\d+)\.manifest$/i.exec(fileName);
        if (!m) continue;
        const fullPath = path.join(dirPath, fileName);
        const key = `${m[1]}_${m[2]}`;
        byKey.set(key, fullPath);
        const list = byDepot.get(m[1]) ?? [];
        list.push({ manifestId: m[2], filePath: fullPath, fileName });
        byDepot.set(m[1], list);
      }
    } catch {
      // Ignore unreadable auxiliary folder
    }

    return { byKey, byDepot };
  }

  /**
   * Saves a raw 0x71F617D0 manifest to Lunex's protected vault and (when targeting Steam's
   * default depotcache) mirrors it to Steam/config/depotcache as well so SteamTools and
   * Steam client both have intact copies even if Steam prunes depotcache.
   */
  private mirrorRawManifest(
    fileName: string,
    rawBuffer: Buffer,
    dirs: ReturnType<LunexManager['resolveDirectories']>
  ): { mirroredToConfigDepotcache: boolean } {
    let mirroredToConfigDepotcache = false;

    try {
      const vaultDir = this.getManifestVaultDir();
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, fileName), rawBuffer);
    } catch {
      // Non-fatal vault write error
    }

    const manifestDirInSteam =
      normalizePathKey(dirs.manifest.path) ===
      normalizePathKey(path.join(dirs.steam.path, 'depotcache'));

    if (manifestDirInSteam && dirs.steam.exists) {
      try {
        const configDepotcacheDir = path.join(
          dirs.steam.path,
          'config',
          'depotcache'
        );
        fs.mkdirSync(configDepotcacheDir, { recursive: true });
        const mirrorPath = path.join(configDepotcacheDir, fileName);
        if (
          !fs.existsSync(mirrorPath) ||
          computeSha256(fs.readFileSync(mirrorPath)) !== computeSha256(rawBuffer)
        ) {
          fs.writeFileSync(mirrorPath, rawBuffer);
          mirroredToConfigDepotcache = true;
        }
      } catch {
        // Non-fatal mirror error
      }
    }

    return { mirroredToConfigDepotcache };
  }

  private tryReadLocalSteamIcon(
    steamRoot: string,
    appId: string
  ): string | undefined {
    const candidates = [
      path.join(steamRoot, 'appcache', 'librarycache', `${appId}_icon.jpg`),
      path.join(steamRoot, 'appcache', 'librarycache', appId, 'icon.jpg'),
      path.join(steamRoot, 'appcache', 'librarycache', `${appId}_header.jpg`),
    ];
    for (const iconPath of candidates) {
      try {
        if (fs.existsSync(iconPath)) {
          const stat = fs.statSync(iconPath);
          if (stat.isFile() && stat.size > 0 && stat.size < 1_048_576) {
            const buf = fs.readFileSync(iconPath);
            return `data:image/jpeg;base64,${buf.toString('base64')}`;
          }
        }
      } catch {
        // Ignore unreadable icon cache
      }
    }
    return undefined;
  }

  /**
   * Scans Steam libraries, managed .lua & .manifest directories, Steam/config/depotcache,
   * Steam/logs/content_log.txt, and cached live SteamCMD info to return synchronized SystemState.
   */
  public getState(): SystemState {
    const dirs = this.resolveDirectories();
    const gamesMap = new Map<string, SteamGame>();
    const depotToAppId = new Map<string, string>();
    const stuckDownloadApps = new Set<string>();
    const acfMountedDepotsByApp = new Map<string, Record<string, string>>();

    const steamRunning = !dirs.isSimulatedSteam && isSteamProcessRunning();
    if (!steamRunning) {
      this.modifiedWhileSteamRunning = false;
    }

    const runningSteamPath = steamRunning ? getRunningSteamPath() ?? undefined : undefined;
    const steamPathMismatch = Boolean(
      runningSteamPath &&
        normalizePathKey(runningSteamPath) !== normalizePathKey(dirs.steam.path)
    );

    const pluginCheck = dirs.steam.exists
      ? detectSteamPlugins(dirs.steam.path)
      : { detected: false, files: [] };

    const configDepotcacheDir = path.join(
      dirs.steam.path,
      'config',
      'depotcache'
    );
    const configDepotcacheExists =
      dirs.steam.exists && fs.existsSync(configDepotcacheDir);

    const hostsBlockingSteam = !dirs.isSimulatedSteam
      ? checkHostsBlockingSteam()
      : [];

    const steamEnvironment: SteamEnvironmentStatus = {
      steamRunning,
      runningSteamPath,
      steamPathMismatch,
      pluginDetected: pluginCheck.detected,
      pluginFiles: pluginCheck.files,
      luaDirInSteam:
        normalizePathKey(dirs.lua.path) ===
        normalizePathKey(path.join(dirs.steam.path, 'config', 'stplug-in')),
      manifestDirInSteam:
        normalizePathKey(dirs.manifest.path) ===
        normalizePathKey(path.join(dirs.steam.path, 'depotcache')),
      configDepotcacheExists,
      offlineModeConfigured:
        dirs.steam.exists && checkSteamOfflineConfig(dirs.steam.path),
      hostsBlockingSteam,
      needsSteamRestart: this.modifiedWhileSteamRunning && steamRunning,
    };

    // 1. Discover Steam library folders via libraryfolders.vdf + root steamapps
    const libraryRoots = this.getLibraryRoots(dirs.steam.path, dirs.steam.exists);

    // 2. Parse appmanifest_*.acf and detect stuck download staging folders/state files
    for (const libRoot of libraryRoots) {
      const steamapps = path.join(libRoot, 'steamapps');
      if (!fs.existsSync(steamapps)) continue;

      const downloadingDir = path.join(steamapps, 'downloading');
      if (fs.existsSync(downloadingDir)) {
        try {
          for (const item of fs.readdirSync(downloadingDir)) {
            if (/^\d+$/.test(item)) {
              stuckDownloadApps.add(item);
            } else {
              const stateMatch = /^state_(\d+)_/i.exec(item);
              if (stateMatch) stuckDownloadApps.add(stateMatch[1]);
            }
          }
        } catch {
          // Ignore unreadable downloading dir
        }
      }

      const tempDir = path.join(steamapps, 'temp');
      if (fs.existsSync(tempDir)) {
        try {
          for (const item of fs.readdirSync(tempDir)) {
            if (/^\d+$/.test(item)) stuckDownloadApps.add(item);
          }
        } catch {
          // Ignore unreadable temp dir
        }
      }

      let entries: string[] = [];
      try {
        entries = fs.readdirSync(steamapps);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
        try {
          const acfContent = fs.readFileSync(path.join(steamapps, entry), 'utf8');
          const parsed = parseAppManifestAcf(acfContent);
          if (!parsed) continue;

          const isFullyInstalled =
            parsed.stateFlags === 4 ||
            ((parsed.stateFlags & 4) === 4 && (parsed.stateFlags & 2) === 0);
          const status: GameInstallStatus = isFullyInstalled
            ? 'installed'
            : 'update_required';

          if (Object.keys(parsed.mountedDepots).length > 0) {
            acfMountedDepotsByApp.set(parsed.appId, parsed.mountedDepots);
          }

          if (!isFullyInstalled) {
            const installCommonPath = parsed.installDir
              ? path.join(steamapps, 'common', parsed.installDir)
              : '';
            const installDirMissing =
              !installCommonPath || !fs.existsSync(installCommonPath);
            const hasIncompleteDownload =
              parsed.sizeOnDisk === 0 ||
              (parsed.stateFlags & 1024) !== 0 ||
              (parsed.stateFlags & 512) !== 0 ||
              (parsed.bytesToDownload > 0 &&
                parsed.bytesDownloaded < parsed.bytesToDownload) ||
              Object.keys(parsed.stagedDepots).length > 0 ||
              installDirMissing;

            if (hasIncompleteDownload) {
              stuckDownloadApps.add(parsed.appId);
            }
          }

          gamesMap.set(parsed.appId, {
            appId: parsed.appId,
            name: parsed.name,
            status,
            isManual: false,
            installDir: parsed.installDir,
            libraryPath: libRoot,
            sizeOnDisk: parsed.sizeOnDisk,
            lastUpdated: parsed.lastUpdated,
            luaCount: 0,
            manifestCount: 0,
            linkedDepots: [],
            localIconDataUrl: this.tryReadLocalSteamIcon(
              dirs.steam.path,
              parsed.appId
            ),
          });
        } catch {
          // Skip unreadable ACF file
        }
      }
    }

    // 3. Merge manual game entries
    for (const manual of this.manualGames) {
      const liveName = this.liveAppInfoCache[manual.appId]?.name;
      const existing = gamesMap.get(manual.appId);
      if (existing) {
        if (
          existing.name.startsWith('Steam App ') &&
          (liveName || manual.name)
        ) {
          existing.name = liveName || manual.name;
        }
        existing.isManual = true;
      } else {
        gamesMap.set(manual.appId, {
          appId: manual.appId,
          name:
            liveName ||
            manual.name ||
            KNOWN_STEAM_TITLES[manual.appId] ||
            `Steam App ${manual.appId}`,
          status: 'not_installed',
          isManual: true,
          luaCount: 0,
          manifestCount: 0,
          linkedDepots: [],
          localIconDataUrl: dirs.steam.exists
            ? this.tryReadLocalSteamIcon(dirs.steam.path, manual.appId)
            : undefined,
        });
      }
    }

    // 4. Scan Lua files first so we build depotId -> parent AppID mappings
    const rawManifests: ManagedManifest[] = [];
    const shaFirstSeen = new Map<string, string>();
    const luaDirectivesByAppId = new Map<string, ParsedLuaDirective[]>();
    const manifestsByAppId = new Map<string, ManagedManifest[]>();
    const depotManifestsByKey = new Map<string, ManagedManifest>();
    const depotManifestsByDepot = new Map<string, ManagedManifest[]>();
    const stFilesByAppId = new Map<string, string[]>();

    // Detect binary .st files in config/stplug-in that can conflict with updated .lua scripts
    if (fs.existsSync(dirs.lua.path)) {
      try {
        for (const entry of fs.readdirSync(dirs.lua.path)) {
          const stMatch = /^(\d+)\.st$/i.exec(entry);
          if (stMatch) {
            const list = stFilesByAppId.get(stMatch[1]) ?? [];
            list.push(path.join(dirs.lua.path, entry));
            stFilesByAppId.set(stMatch[1], list);
          }
        }
      } catch {
        // Ignore unreadable lua dir
      }
    }

    const scanDirectory = (dirPath: string, expectedExt: '.lua' | '.manifest') => {
      if (!fs.existsSync(dirPath)) return;
      let files: string[] = [];
      try {
        files = fs.readdirSync(dirPath).sort();
      } catch {
        return;
      }

      for (const fileName of files) {
        if (path.extname(fileName).toLowerCase() !== expectedExt) continue;
        const fullPath = path.join(dirPath, fileName);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }

        let buf: Buffer;
        try {
          buf = fs.readFileSync(fullPath);
        } catch {
          continue;
        }

        const val = validateManifestBuffer(fileName, buf);
        const assocOverride =
          this.associations[fullPath] ?? this.associations[fileName];

        let resolvedAppId = assocOverride || '';

        if (expectedExt === '.lua') {
          if (!resolvedAppId && val.detectedAppId) {
            resolvedAppId = val.detectedAppId;
          }
          if (resolvedAppId && val.directives) {
            for (const directive of val.directives) {
              depotToAppId.set(directive.id, resolvedAppId);
            }
            const existingDirs = luaDirectivesByAppId.get(resolvedAppId) ?? [];
            existingDirs.push(...val.directives);
            luaDirectivesByAppId.set(resolvedAppId, existingDirs);
          }
        } else {
          const effectiveDepotId = val.headerDepotId ?? val.detectedDepotId;
          if (!resolvedAppId && effectiveDepotId) {
            if (depotToAppId.has(effectiveDepotId)) {
              resolvedAppId = depotToAppId.get(effectiveDepotId)!;
            } else if (gamesMap.has(effectiveDepotId)) {
              resolvedAppId = effectiveDepotId;
            } else {
              const numericDepot = Number.parseInt(effectiveDepotId, 10);
              if (!Number.isNaN(numericDepot) && numericDepot > 1) {
                const candidateAppId = String(numericDepot - 1);
                if (
                  gamesMap.has(candidateAppId) ||
                  KNOWN_STEAM_TITLES[candidateAppId]
                ) {
                  resolvedAppId = candidateAppId;
                }
              }
            }
          }
        }

        if (!resolvedAppId) {
          resolvedAppId = 'unassigned';
        }

        const prevFileWithHash = shaFirstSeen.get(val.sha256);
        const isDuplicate = Boolean(
          prevFileWithHash && prevFileWithHash !== fileName
        );
        if (!prevFileWithHash) {
          shaFirstSeen.set(val.sha256, fileName);
        }

        const validationMessage = val.valid
          ? val.warnings.length > 0
            ? val.warnings[0]
            : 'Verified'
          : val.errors[0] || 'Invalid file';

        const mfRecord: ManagedManifest = {
          id: `${expectedExt.slice(1)}:${fileName}`,
          fileName,
          filePath: fullPath,
          fileType: expectedExt === '.lua' ? 'lua' : 'manifest',
          appId: resolvedAppId,
          depotId: val.detectedDepotId,
          manifestId: val.detectedManifestId,
          headerDepotId: val.headerDepotId,
          headerManifestId: val.headerManifestId,
          sizeBytes: val.sizeBytes,
          sha256: val.sha256,
          modifiedAt: stat.mtime.toISOString(),
          isValid: val.valid,
          validationMessage,
          isDuplicate,
          duplicateOf: isDuplicate ? prevFileWithHash : undefined,
          directivesCount: val.directives?.length,
          isZipWrapped: val.isZipWrapped,
        };

        rawManifests.push(mfRecord);

        const keyDepot = mfRecord.headerDepotId ?? mfRecord.depotId;
        const keyManifest = mfRecord.headerManifestId ?? mfRecord.manifestId;
        if (mfRecord.fileType === 'manifest' && keyDepot) {
          if (keyManifest) {
            depotManifestsByKey.set(`${keyDepot}_${keyManifest}`, mfRecord);
          }
          if (mfRecord.depotId && mfRecord.manifestId) {
            depotManifestsByKey.set(
              `${mfRecord.depotId}_${mfRecord.manifestId}`,
              mfRecord
            );
          }
          const byDepot = depotManifestsByDepot.get(keyDepot) ?? [];
          byDepot.push(mfRecord);
          depotManifestsByDepot.set(keyDepot, byDepot);
        }
      }
    };

    scanDirectory(dirs.lua.path, '.lua');
    scanDirectory(dirs.manifest.path, '.manifest');

    // 5. Link manifests to games & ensure Lua-discovered games appear in Library
    for (const mf of rawManifests) {
      if (mf.appId !== 'unassigned' && /^\d+$/.test(mf.appId)) {
        let game = gamesMap.get(mf.appId);
        const liveName = this.liveAppInfoCache[mf.appId]?.name;
        if (!game) {
          game = {
            appId: mf.appId,
            name:
              liveName ||
              KNOWN_STEAM_TITLES[mf.appId] ||
              `Steam App ${mf.appId}`,
            status: 'manifest_only',
            isManual: false,
            luaCount: 0,
            manifestCount: 0,
            linkedDepots: [],
            localIconDataUrl: dirs.steam.exists
              ? this.tryReadLocalSteamIcon(dirs.steam.path, mf.appId)
              : undefined,
          };
          gamesMap.set(mf.appId, game);
        } else {
          if (liveName && game.name.startsWith('Steam App ')) {
            game.name = liveName;
          }
          if (game.status === 'not_installed' && mf.isValid) {
            game.status = 'manifest_only';
          }
        }

        if (mf.fileType === 'lua') {
          game.luaCount += 1;
        } else {
          game.manifestCount += 1;
          const depId = mf.headerDepotId ?? mf.depotId;
          if (depId && !game.linkedDepots.includes(depId)) {
            game.linkedDepots.push(depId);
          }
        }
        mf.gameName = game.name;

        const list = manifestsByAppId.get(mf.appId) ?? [];
        list.push(mf);
        manifestsByAppId.set(mf.appId, list);
      }
    }

    // 6. Read auxiliary caches + Steam content_log.txt ONCE for fast per-game diagnostics
    const configVdfPath = path.join(dirs.steam.path, 'config', 'config.vdf');
    const configVdfExists = dirs.steam.exists && fs.existsSync(configVdfPath);
    const configVdfKeys = configVdfExists
      ? this.readConfigVdfKeys(dirs.steam.path)
      : new Map<string, string>();

    const configDepotcacheIndex = this.indexAuxiliaryManifestDir(
      configDepotcacheDir
    );
    const vaultIndex = this.indexAuxiliaryManifestDir(
      this.getManifestVaultDir()
    );

    const primaryContentLogPath = path.join(
      dirs.steam.path,
      'logs',
      'content_log.txt'
    );
    const prevContentLogPath = path.join(
      dirs.steam.path,
      'logs',
      'content_log.previous.txt'
    );
    const primaryLogText = dirs.steam.exists
      ? readTailIfExists(primaryContentLogPath)
      : null;
    const prevLogText =
      dirs.steam.exists && (!primaryLogText || primaryLogText.trim().length === 0)
        ? readTailIfExists(prevContentLogPath)
        : null;

    for (const game of gamesMap.values()) {
      const gameManifests = manifestsByAppId.get(game.appId) ?? [];
      const hasStuck = stuckDownloadApps.has(game.appId);
      const hasCachedLive = Boolean(this.liveAppInfoCache[game.appId]);
      if (gameManifests.length === 0 && !hasStuck && !hasCachedLive) {
        continue;
      }

      const luaDirectives = luaDirectivesByAppId.get(game.appId) ?? [];
      const knownDepotIds = new Set<string>(game.linkedDepots);
      for (const d of luaDirectives) knownDepotIds.add(d.id);

      let steamLog: SteamLogDiagnostic | undefined;
      if (primaryLogText !== null) {
        steamLog = parseSteamContentLogText(
          primaryLogText,
          game.appId,
          knownDepotIds,
          primaryContentLogPath
        );
        if (
          steamLog.recentLines.length === 0 &&
          fs.existsSync(prevContentLogPath)
        ) {
          const prevText = readTailIfExists(prevContentLogPath);
          if (prevText) {
            const prevParsed = parseSteamContentLogText(
              prevText,
              game.appId,
              knownDepotIds,
              prevContentLogPath
            );
            if (prevParsed.recentLines.length > 0) {
              steamLog = prevParsed;
            }
          }
        }
      } else if (prevLogText !== null) {
        steamLog = parseSteamContentLogText(
          prevLogText,
          game.appId,
          knownDepotIds,
          prevContentLogPath
        );
      }

      game.installDiagnostics = this.computeGameDiagnostics({
        game,
        gameManifests,
        luaDirectives,
        depotManifestsByKey,
        depotManifestsByDepot,
        configDepotcacheIndex,
        vaultIndex,
        configVdfExists,
        configVdfKeys,
        stConflictFiles: stFilesByAppId.get(game.appId) ?? [],
        acfMountedDepots: acfMountedDepotsByApp.get(game.appId) ?? {},
        hasStuckDownloadState: hasStuck,
        isSimulatedSteam: dirs.isSimulatedSteam,
        steamPath: dirs.steam.path,
        steamEnvironment,
        steamLog,
        liveAppInfo: this.liveAppInfoCache[game.appId],
      });
    }

    const games = Array.from(gamesMap.values()).sort((a, b) => {
      const rank = (s: GameInstallStatus) =>
        s === 'installed'
          ? 0
          : s === 'update_required'
            ? 1
            : s === 'manifest_only'
              ? 2
              : 3;
      const diff = rank(a.status) - rank(b.status);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });

    const validBackups = this.backups.filter((b) => fs.existsSync(b.backupPath));
    if (validBackups.length !== this.backups.length) {
      this.backups = validBackups;
      this.writeJsonFile('backups-index.json', this.backups);
    }

    return {
      settings: { ...this.settings },
      directories: {
        steam: dirs.steam,
        lua: dirs.lua,
        manifest: dirs.manifest,
        backup: dirs.backup,
      },
      platform: process.platform,
      isElectron: this.isElectron,
      isSimulatedSteam: dirs.isSimulatedSteam,
      steamEnvironment,
      games,
      manifests: rawManifests,
      backups: [...this.backups],
      operations: [...this.operations],
    };
  }

  private computeGameDiagnostics(params: {
    game: SteamGame;
    gameManifests: ManagedManifest[];
    luaDirectives: ParsedLuaDirective[];
    depotManifestsByKey: Map<string, ManagedManifest>;
    depotManifestsByDepot: Map<string, ManagedManifest[]>;
    configDepotcacheIndex: ReturnType<LunexManager['indexAuxiliaryManifestDir']>;
    vaultIndex: ReturnType<LunexManager['indexAuxiliaryManifestDir']>;
    configVdfExists: boolean;
    configVdfKeys: Map<string, string>;
    stConflictFiles: string[];
    acfMountedDepots: Record<string, string>;
    hasStuckDownloadState: boolean;
    isSimulatedSteam: boolean;
    steamPath: string;
    steamEnvironment: SteamEnvironmentStatus;
    steamLog?: SteamLogDiagnostic;
    liveAppInfo?: LiveSteamAppInfo;
  }): GameInstallDiagnostics {
    const {
      game,
      gameManifests,
      luaDirectives,
      depotManifestsByKey,
      depotManifestsByDepot,
      configDepotcacheIndex,
      vaultIndex,
      configVdfExists,
      configVdfKeys,
      stConflictFiles,
      acfMountedDepots,
      hasStuckDownloadState,
      isSimulatedSteam,
      steamPath,
      steamEnvironment,
      steamLog,
      liveAppInfo,
    } = params;

    const issues: InstallIssue[] = [];
    const expectedDepots: ExpectedDepotStatus[] = [];

    const luaFiles = gameManifests.filter((m) => m.fileType === 'lua');
    const depotFiles = gameManifests.filter((m) => m.fileType === 'manifest');

    const liveDlcSet = new Set(liveAppInfo?.dlcAppIds ?? []);
    const liveDepotMap = new Map(
      (liveAppInfo?.depots ?? []).map((d) => [d.depotId, d])
    );

    const logFailedByDepot = new Map<string, { manifestId: string; reason: string }>();
    for (const fm of steamLog?.failedManifests ?? []) {
      logFailedByDepot.set(fm.depotId, {
        manifestId: fm.manifestId,
        reason: fm.reason,
      });
    }
    const logMissingKeySet = new Set(steamLog?.missingKeyDepots ?? []);

    // 1. Environment & Steam path checks
    if (steamEnvironment.steamPathMismatch && steamEnvironment.runningSteamPath) {
      issues.push({
        code: 'steam_path_mismatch',
        severity: 'error',
        title: 'Lunex Is Editing a Different Steam Folder Than Running Steam',
        description: `Running Steam is at "${steamEnvironment.runningSteamPath}", but Lunex is writing manifests to "${steamPath}". Running Steam will never see these files until Lunex switches to the active Steam folder.`,
        autoFixable: true,
      });
    }

    if (isSimulatedSteam) {
      issues.push({
        code: 'simulated_steam',
        severity: 'warning',
        title: 'Using Workspace Steam Directory',
        description:
          'Lunex could not auto-detect a local Steam installation and is using a workspace folder. Set your real Steam path in Settings so Steam sees these manifests.',
        autoFixable: false,
      });
    }

    if (!steamEnvironment.luaDirInSteam || !steamEnvironment.manifestDirInSteam) {
      issues.push({
        code: 'custom_dir_mismatch',
        severity: 'error',
        title: 'Custom Manifest Path Outside Steam Directory',
        description:
          'Custom .lua or .manifest directory points outside your Steam installation. Steam only reads config/stplug-in and depotcache inside its own Steam folder.',
        autoFixable: false,
      });
    }

    if (steamEnvironment.hostsBlockingSteam.length > 0) {
      issues.push({
        code: 'hosts_blocking_steam',
        severity: 'error',
        title: 'Windows Hosts File Is Blocking Steam Servers',
        description: `Your system hosts file redirects Steam domains (${steamEnvironment.hostsBlockingSteam.slice(0, 3).join(', ')}). Remove those entries from C:\\Windows\\System32\\drivers\\etc\\hosts so Steam can connect.`,
        autoFixable: false,
      });
    }

    if (steamEnvironment.offlineModeConfigured) {
      issues.push({
        code: 'steam_offline_mode',
        severity: 'error',
        title: 'Steam Configured for Offline Mode',
        description:
          'Steam configuration (steam.cfg or config/loginusers.vdf) requests Offline Mode, which prevents downloading game chunks. Auto-Fix clears this while Steam is stopped.',
        autoFixable: true,
      });
    }

    // 2. Conflicting binary .st plugins or duplicate .lua scripts in config/stplug-in
    if (stConflictFiles.length > 0 && luaFiles.length > 0) {
      issues.push({
        code: 'conflicting_st_plugin',
        severity: 'error',
        title: `Conflicting Binary Plugin: ${path.basename(stConflictFiles[0])}`,
        description: `Steam/config/stplug-in contains both "${path.basename(stConflictFiles[0])}" and "${luaFiles[0].fileName}". SteamTools may load stale manifest pins from the .st file and ignore edits to your .lua file. Auto-Fix backs up and removes the stale .st file.`,
        autoFixable: true,
        fileName: path.basename(stConflictFiles[0]),
      });
    }

    if (luaFiles.length > 1) {
      issues.push({
        code: 'duplicate_lua_conflict',
        severity: 'warning',
        title: `Multiple .lua Files Target AppID ${game.appId}`,
        description: `Found ${luaFiles.length} .lua scripts (${luaFiles.map((f) => f.fileName).join(', ')}) for this game. Conflicting setManifestid() lines across multiple scripts can break Steam manifest pinning.`,
        autoFixable: false,
      });
    }

    // 3. Invalid, ZIP/GZIP-wrapped, header-mismatched, or misnamed .manifest files
    for (const mf of gameManifests) {
      if (!mf.isValid) {
        issues.push({
          code: 'invalid_manifest_file',
          severity: 'error',
          title: `Invalid File: ${mf.fileName}`,
          description: mf.validationMessage,
          autoFixable: false,
          fileName: mf.fileName,
        });
      } else if (mf.isZipWrapped) {
        issues.push({
          code: 'zip_wrapped_manifest',
          severity: 'error',
          title: `Compressed Depot Manifest: ${mf.fileName}`,
          description:
            'This .manifest file is still ZIP/GZIP-compressed instead of raw 0x71F617D0 binary. Steam fails to read it locally, tries to download from Valve servers, and fails with "No internet connection".',
          autoFixable: true,
          depotId: mf.headerDepotId ?? mf.depotId,
          manifestId: mf.headerManifestId ?? mf.manifestId,
          fileName: mf.fileName,
        });
      } else if (
        mf.fileType === 'manifest' &&
        mf.headerDepotId &&
        mf.headerManifestId &&
        mf.fileName !== `${mf.headerDepotId}_${mf.headerManifestId}.manifest`
      ) {
        issues.push({
          code: 'manifest_header_mismatch',
          severity: 'error',
          title: `Binary Header Mismatch: ${mf.fileName}`,
          description: `Inside this file, Valve's 0x1F4812BE header identifies Depot ${mf.headerDepotId} / Manifest ${mf.headerManifestId}, but the filename is "${mf.fileName}". Steam rejects mismatched filenames and fails with "No internet connection".`,
          autoFixable: true,
          depotId: mf.headerDepotId,
          manifestId: mf.headerManifestId,
          fileName: mf.fileName,
        });
      } else if (
        mf.fileType === 'manifest' &&
        mf.depotId &&
        mf.manifestId &&
        mf.fileName !== `${mf.depotId}_${mf.manifestId}.manifest`
      ) {
        issues.push({
          code: 'misnamed_manifest',
          severity: 'error',
          title: `Misnamed Depot Manifest: ${mf.fileName}`,
          description: `Steam depotcache requires "${mf.depotId}_${mf.manifestId}.manifest". Without this exact filename, Steam tries to fetch the manifest online and fails.`,
          autoFixable: true,
          depotId: mf.depotId,
          manifestId: mf.manifestId,
          fileName: mf.fileName,
        });
      }
    }

    // 4. Missing .lua script when .manifest files exist
    if (depotFiles.length > 0 && luaFiles.length === 0) {
      const anyKeyInVdf = depotFiles.some((d) => {
        const dep = d.headerDepotId ?? d.depotId;
        return Boolean(dep && isValidDepotDecryptionKey(configVdfKeys.get(dep)));
      });
      issues.push({
        code: 'missing_lua',
        severity: 'error',
        title: 'Missing .lua Script in stplug-in',
        description:
          'You imported .manifest file(s), but there is no .lua script in Steam/config/stplug-in. Without addappid() decryption keys and setManifestid(), Steam queues the download and fails with a connection error.',
        autoFixable: anyKeyInVdf,
      });
    }

    // 5. Inspect depots declared in .lua directives (skipping bare DLC/App unlock IDs!)
    const seenDepotIds = new Set<string>();
    const hasAnyKeyedOrPinnedDepot = luaDirectives.some(
      (d) =>
        d.id !== game.appId &&
        (Boolean(d.decryptionKey) ||
          Boolean(d.manifestId) ||
          Boolean(d.commentedManifestId))
    );

    const depotDirectives = luaDirectives.filter((d) => {
      if (d.id === game.appId) {
        return Boolean(d.manifestId || d.decryptionKey || d.commentedManifestId);
      }
      // If it explicitly carries a key, manifest pin, local manifest file, config.vdf key, or Steam log error -> inspect it as a depot
      const hasAnyDepotSignal =
        Boolean(d.decryptionKey) ||
        Boolean(d.manifestId) ||
        Boolean(d.commentedManifestId) ||
        depotManifestsByDepot.has(d.id) ||
        configVdfKeys.has(d.id) ||
        logFailedByDepot.has(d.id) ||
        logMissingKeySet.has(d.id);
      if (hasAnyDepotSignal) return true;

      // Live PICS confirms whether this ID is a real depot vs a DLC AppID
      if (liveAppInfo && !liveAppInfo.error) {
        if (liveDepotMap.has(d.id)) return true;
        if (liveDlcSet.has(d.id)) return false;
      }

      // Heuristic offline: bare addappid(dlcId) alongside keyed depots is a DLC/app unlock, not a missing-key depot
      return !hasAnyKeyedOrPinnedDepot;
    });

    const missingKeysInConfigVdf: string[] = [];
    const desyncedConfigDepotcacheFiles: string[] = [];

    for (const dir of depotDirectives) {
      if (seenDepotIds.has(dir.id)) continue;
      seenDepotIds.add(dir.id);

      const luaKeyPresent = Boolean(dir.decryptionKey);
      const luaKeyValid = isValidDepotDecryptionKey(dir.decryptionKey);
      const vdfKey = configVdfKeys.get(dir.id);
      const vdfKeyValid = isValidDepotDecryptionKey(vdfKey);
      const hasValidKey = luaKeyValid || vdfKeyValid;

      if (luaKeyValid && configVdfExists && !vdfKeyValid) {
        missingKeysInConfigVdf.push(dir.id);
      }

      const exactDiskMatch = dir.manifestId
        ? depotManifestsByKey.get(`${dir.id}_${dir.manifestId}`)
        : undefined;
      const anyDiskForDepot = depotManifestsByDepot.get(dir.id)?.[0];
      const diskMatch = exactDiskMatch ?? anyDiskForDepot;

      const effectiveDiskManifestId =
        diskMatch?.headerManifestId ?? diskMatch?.manifestId;
      const targetManifestIdForAux =
        dir.manifestId ?? dir.commentedManifestId ?? effectiveDiskManifestId;

      const inConfigDepotcache = targetManifestIdForAux
        ? configDepotcacheIndex.byKey.has(`${dir.id}_${targetManifestIdForAux}`)
        : configDepotcacheIndex.byDepot.has(dir.id);
      const inVault = targetManifestIdForAux
        ? vaultIndex.byKey.has(`${dir.id}_${targetManifestIdForAux}`)
        : vaultIndex.byDepot.has(dir.id);

      const liveDepot = liveDepotMap.get(dir.id);
      const logFail = logFailedByDepot.get(dir.id);

      expectedDepots.push({
        depotId: dir.id,
        hasDecryptionKey: hasValidKey,
        keyInConfigVdf: vdfKeyValid,
        keyInvalid: luaKeyPresent && !luaKeyValid,
        luaManifestId: dir.manifestId,
        commentedManifestId: dir.commentedManifestId,
        diskManifestFile: diskMatch?.fileName,
        diskManifestId: effectiveDiskManifestId,
        headerManifestId: diskMatch?.headerManifestId,
        inDepotcache: Boolean(diskMatch),
        inConfigDepotcache,
        inVault,
        isZipWrapped: diskMatch?.isZipWrapped,
        liveManifestId: liveDepot?.publicManifestId,
        liveSizeBytes: liveDepot?.sizeBytes,
        liveOsList: liveDepot?.oslist,
        liveLanguage: liveDepot?.language,
        isDlcDepot: Boolean(liveDepot?.dlcAppId),
        isSharedDepot: liveDepot?.isShared,
        failedInSteamLog: Boolean(logFail),
        steamLogRequestedManifestId: logFail?.manifestId,
      });

      if (luaKeyPresent && !luaKeyValid) {
        issues.push({
          code: 'invalid_decryption_key',
          severity: 'error',
          title: `Invalid Placeholder Decryption Key for Depot ${dir.id}`,
          description: `Depot ${dir.id} has a malformed or all-zero decryption key ("${dir.decryptionKey?.slice(0, 16)}..."). Real Steam depot keys are 64 non-zero hex characters. Obtain a genuine .lua key file for this game.`,
          autoFixable: false,
          depotId: dir.id,
        });
      } else if (!hasValidKey) {
        issues.push({
          code: 'missing_decryption_key',
          severity: 'error',
          title: `Missing Decryption Key for Depot ${dir.id}`,
          description: `Depot ${dir.id} has no 64-character hex decryption key in the .lua script or config.vdf. Steam cannot decrypt or install this depot without its key.`,
          autoFixable: false,
          depotId: dir.id,
        });
      }

      if (dir.manifestId && !isValidManifestGid(dir.manifestId)) {
        issues.push({
          code: 'manifest_id_mismatch',
          severity: 'error',
          title: `Invalid Placeholder setManifestid() for Depot ${dir.id}`,
          description: `.lua contains placeholder setManifestid(${dir.id}, "${dir.manifestId}").${effectiveDiskManifestId ? ` Auto-Fix will update it to match "${diskMatch?.fileName}".` : ''}`,
          autoFixable: Boolean(effectiveDiskManifestId),
          depotId: dir.id,
          manifestId: effectiveDiskManifestId,
        });
      } else if (dir.manifestId && !exactDiskMatch) {
        const recoverableFromConfig = configDepotcacheIndex.byKey.has(
          `${dir.id}_${dir.manifestId}`
        );
        const recoverableFromVault = vaultIndex.byKey.has(
          `${dir.id}_${dir.manifestId}`
        );

        if (recoverableFromConfig || recoverableFromVault) {
          issues.push({
            code: 'depotcache_desync',
            severity: 'error',
            title: `Steam Deleted ${dir.id}_${dir.manifestId}.manifest from depotcache`,
            description: `Steam/depotcache is missing "${dir.id}_${dir.manifestId}.manifest" (Steam frequently prunes unowned depotcache manifests, triggering "No internet connection"), but a clean copy exists in ${recoverableFromConfig ? 'Steam/config/depotcache' : 'Lunex Manifest Vault'}. Auto-Fix restores it immediately.`,
            autoFixable: true,
            depotId: dir.id,
            manifestId: dir.manifestId,
            fileName: `${dir.id}_${dir.manifestId}.manifest`,
          });
        } else if (anyDiskForDepot && effectiveDiskManifestId) {
          issues.push({
            code: 'manifest_id_mismatch',
            severity: 'error',
            title: `Manifest ID Mismatch for Depot ${dir.id}`,
            description: `.lua pins setManifestid(${dir.id}, "${dir.manifestId}"), but depotcache has "${anyDiskForDepot.fileName}" (${effectiveDiskManifestId}). Steam fails trying to download the missing manifest online.`,
            autoFixable: true,
            depotId: dir.id,
            manifestId: effectiveDiskManifestId,
            fileName: anyDiskForDepot.fileName,
          });
        } else {
          issues.push({
            code: 'missing_depot_manifest',
            severity: 'error',
            title: `Missing Depot Manifest: ${dir.id}_${dir.manifestId}.manifest`,
            description: `The .lua script requires "${dir.id}_${dir.manifestId}.manifest" in Steam/depotcache, but it is missing on disk. Steam cannot fetch manifests for unowned depots from Valve CDN and reports "No internet connection".`,
            autoFixable: false,
            depotId: dir.id,
            manifestId: dir.manifestId,
            fileName: `${dir.id}_${dir.manifestId}.manifest`,
          });
        }
      } else if (!dir.manifestId) {
        const recoverableAux =
          configDepotcacheIndex.byDepot.get(dir.id)?.[0] ??
          vaultIndex.byDepot.get(dir.id)?.[0];

        if (anyDiskForDepot && effectiveDiskManifestId) {
          if (dir.commentedManifestId) {
            issues.push({
              code: 'commented_set_manifest_id',
              severity: 'error',
              title: `Commented-Out setManifestid() in .lua for Depot ${dir.id}`,
              description: `Your .lua script has "-- setManifestid(${dir.id}, ...)" commented out! Steam ignores commented lines and tries to download online instead of using "${anyDiskForDepot.fileName}". Auto-Fix uncomments and syncs it.`,
              autoFixable: true,
              depotId: dir.id,
              manifestId: effectiveDiskManifestId,
              fileName: anyDiskForDepot.fileName,
            });
          } else {
            issues.push({
              code: 'missing_set_manifest_id',
              severity: 'error',
              title: `Missing setManifestid() in .lua for Depot ${dir.id}`,
              description: `"${anyDiskForDepot.fileName}" is in depotcache, but the .lua script lacks setManifestid(${dir.id}, "${effectiveDiskManifestId}", 0). Without it, Steam ignores the local file and fails contacting Valve servers.`,
              autoFixable: true,
              depotId: dir.id,
              manifestId: effectiveDiskManifestId,
              fileName: anyDiskForDepot.fileName,
            });
          }
        } else if (recoverableAux) {
          issues.push({
            code: 'depotcache_desync',
            severity: 'error',
            title: `Recoverable Depot Manifest Missing from Steam/depotcache: ${recoverableAux.fileName}`,
            description: `"${recoverableAux.fileName}" exists in Steam/config/depotcache or Lunex Vault, but is missing from Steam/depotcache. Auto-Fix restores it and pins setManifestid() in .lua.`,
            autoFixable: true,
            depotId: dir.id,
            manifestId: recoverableAux.manifestId,
            fileName: recoverableAux.fileName,
          });
        } else {
          issues.push({
            code: 'missing_depot_manifest',
            severity: 'error',
            title: `No Local .manifest File for Depot ${dir.id}`,
            description: `Depot ${dir.id} is declared in .lua, but has no .manifest file in Steam/depotcache. When SteamTools's online manifest server cannot supply it, Steam fails with "No internet connection".${liveDepot?.publicManifestId ? ` Latest live manifest is ${dir.id}_${liveDepot.publicManifestId}.manifest.` : ''}`,
            autoFixable: false,
            depotId: dir.id,
            manifestId: liveDepot?.publicManifestId,
          });
        }
      } else if (
        exactDiskMatch &&
        steamEnvironment.manifestDirInSteam &&
        !inConfigDepotcache
      ) {
        desyncedConfigDepotcacheFiles.push(exactDiskMatch.fileName);
      }

      // Live PICS outdated-manifest check
      if (
        liveDepot?.publicManifestId &&
        effectiveDiskManifestId &&
        liveDepot.publicManifestId !== effectiveDiskManifestId
      ) {
        issues.push({
          code: 'outdated_manifest',
          severity: 'warning',
          title: `Outdated Manifest for Depot ${dir.id} vs Live Steam`,
          description: `Your cached manifest is ${effectiveDiskManifestId}, while Steam's current public branch expects ${liveDepot.publicManifestId}. If your SteamTools build does not enforce setManifestid(), Steam requests ${dir.id}_${liveDepot.publicManifestId}.manifest and fails with "No internet connection".`,
          autoFixable: false,
          depotId: dir.id,
          manifestId: liveDepot.publicManifestId,
          fileName: `${dir.id}_${liveDepot.publicManifestId}.manifest`,
        });
      }
    }

    // 6. Check depot .manifest files linked to this game that aren't in .lua yet
    for (const mf of depotFiles) {
      const depId = mf.headerDepotId ?? mf.depotId;
      const manId = mf.headerManifestId ?? mf.manifestId;
      if (!depId || seenDepotIds.has(depId)) continue;
      seenDepotIds.add(depId);

      const hasValidKey = isValidDepotDecryptionKey(configVdfKeys.get(depId));
      const inConfigDepotcache = manId
        ? configDepotcacheIndex.byKey.has(`${depId}_${manId}`)
        : false;
      const inVault = manId ? vaultIndex.byKey.has(`${depId}_${manId}`) : false;
      const liveDepot = liveDepotMap.get(depId);
      const logFail = logFailedByDepot.get(depId);

      expectedDepots.push({
        depotId: depId,
        hasDecryptionKey: hasValidKey,
        keyInConfigVdf: hasValidKey,
        diskManifestFile: mf.fileName,
        diskManifestId: manId,
        headerManifestId: mf.headerManifestId,
        inDepotcache: true,
        inConfigDepotcache,
        inVault,
        isZipWrapped: mf.isZipWrapped,
        liveManifestId: liveDepot?.publicManifestId,
        liveSizeBytes: liveDepot?.sizeBytes,
        liveOsList: liveDepot?.oslist,
        liveLanguage: liveDepot?.language,
        isDlcDepot: Boolean(liveDepot?.dlcAppId),
        isSharedDepot: liveDepot?.isShared,
        failedInSteamLog: Boolean(logFail),
        steamLogRequestedManifestId: logFail?.manifestId,
      });

      if (luaFiles.length > 0 && manId) {
        issues.push({
          code: 'missing_set_manifest_id',
          severity: 'error',
          title: `Unlinked Depot ${depId} in .lua`,
          description: `"${mf.fileName}" is in depotcache, but ${luaFiles[0].fileName} does not include setManifestid(${depId}, "${manId}", 0).`,
          autoFixable: true,
          depotId: depId,
          manifestId: manId,
          fileName: mf.fileName,
        });
      }

      if (steamEnvironment.manifestDirInSteam && !inConfigDepotcache) {
        desyncedConfigDepotcacheFiles.push(mf.fileName);
      }
    }

    // 7. Live SteamCMD required base Windows depots missing completely from .lua & depotcache
    if (liveAppInfo && !liveAppInfo.error) {
      for (const liveDep of liveAppInfo.depots) {
        if (seenDepotIds.has(liveDep.depotId)) continue;
        if (liveDep.isShared || liveDep.dlcAppId || liveDep.language) continue;
        if (!liveDep.publicManifestId) continue;
        if (
          liveDep.oslist &&
          !liveDep.oslist.toLowerCase().includes('windows')
        ) {
          continue;
        }
        // Ignore tiny placeholder depots (< 1 KB) unless Steam log explicitly asked for them
        if (
          typeof liveDep.sizeBytes === 'number' &&
          liveDep.sizeBytes < 1024 &&
          !logFailedByDepot.has(liveDep.depotId)
        ) {
          continue;
        }

        const logFail = logFailedByDepot.get(liveDep.depotId);
        expectedDepots.push({
          depotId: liveDep.depotId,
          hasDecryptionKey: isValidDepotDecryptionKey(
            configVdfKeys.get(liveDep.depotId)
          ),
          keyInConfigVdf: isValidDepotDecryptionKey(
            configVdfKeys.get(liveDep.depotId)
          ),
          inDepotcache: false,
          inConfigDepotcache: false,
          inVault: false,
          liveManifestId: liveDep.publicManifestId,
          liveSizeBytes: liveDep.sizeBytes,
          liveOsList: liveDep.oslist,
          liveLanguage: liveDep.language,
          failedInSteamLog: Boolean(logFail),
          steamLogRequestedManifestId: logFail?.manifestId,
        });

        issues.push({
          code: 'missing_required_depot',
          severity: 'error',
          title: `Missing Required Windows Depot ${liveDep.depotId}`,
          description: `Live Steam metadata requires Depot ${liveDep.depotId} (manifest ${liveDep.depotId}_${liveDep.publicManifestId}.manifest), which is missing from both your .lua script and depotcache. Steam fails with "No internet connection" when any required depot is missing.`,
          autoFixable: false,
          depotId: liveDep.depotId,
          manifestId: liveDep.publicManifestId,
          fileName: `${liveDep.depotId}_${liveDep.publicManifestId}.manifest`,
        });
      }
    }

    // 8. Mirror sync warning for Steam/config/depotcache (needed by SteamTools)
    if (desyncedConfigDepotcacheFiles.length > 0 && luaFiles.length > 0) {
      issues.push({
        code: 'depotcache_desync',
        severity: 'warning',
        title: `Mirror ${desyncedConfigDepotcacheFiles.length} Manifest(s) to Steam/config/depotcache`,
        description: `SteamTools reads pinned manifests from Steam/config/depotcache while Steam reads Steam/depotcache. Auto-Fix mirrors ${desyncedConfigDepotcacheFiles.slice(0, 2).join(', ')}${desyncedConfigDepotcacheFiles.length > 2 ? ` (+${desyncedConfigDepotcacheFiles.length - 2} more)` : ''} to both folders and Lunex Vault so Steam can't lose them.`,
        autoFixable: true,
      });
    }

    // 9. Decryption keys in .lua not yet synced into Steam/config/config.vdf
    if (missingKeysInConfigVdf.length > 0) {
      issues.push({
        code: 'config_vdf_keys_missing',
        severity: 'warning',
        title: `${missingKeysInConfigVdf.length} Depot Key(s) Not Yet Synced to Steam config.vdf`,
        description: `Decryption key(s) for depot(s) ${missingKeysInConfigVdf.join(', ')} exist in .lua but not in Steam/config/config.vdf. Stopping Steam and syncing them into config.vdf ensures Steam can decrypt even if a plugin hook misses GetDepotDecryptionKey.`,
        autoFixable: true,
      });
    }

    // 10. Real Steam `logs/content_log.txt` evidence (THE SMOKING GUN!)
    if (steamLog) {
      for (const fm of steamLog.failedManifests) {
        const key = `${fm.depotId}_${fm.manifestId}`;
        const hasExactInDepotcache = depotManifestsByKey.has(key);
        const hasExactInAux =
          configDepotcacheIndex.byKey.has(key) || vaultIndex.byKey.has(key);
        const localDepot = expectedDepots.find((d) => d.depotId === fm.depotId);
        const localPinned = localDepot?.luaManifestId;
        const localDisk = localDepot?.diskManifestId;

        let description: string;
        let autoFixable = false;

        if (hasExactInAux && !hasExactInDepotcache) {
          description = `Steam's content_log.txt shows it failed downloading ${key}.manifest (${fm.reason}). A local copy exists in Steam/config/depotcache or Vault — Auto-Fix restores it into Steam/depotcache!`;
          autoFixable = true;
        } else if (
          localPinned &&
          localDisk &&
          localPinned === localDisk &&
          localPinned !== fm.manifestId
        ) {
          description = `Steam's content_log.txt proves Steam IGNORED setManifestid(${fm.depotId}, "${localPinned}") and tried to download manifest "${fm.manifestId}" instead (${fm.reason}). Cause: either Steam wasn't restarted after editing .lua, a stale .st file overrode it, your SteamTools plugin isn't active/needs updating, or your SteamTools version ignores setManifestid() and requires the newer "${key}.manifest" file.`;
          autoFixable =
            stConflictFiles.length > 0 ||
            steamEnvironment.needsSteamRestart ||
            hasStuckDownloadState;
        } else if (hasExactInDepotcache) {
          description = `Steam's content_log.txt failed on ${key}.manifest (${fm.reason}) even though that filename exists in depotcache. Check if the file is ZIP-wrapped, has a header mismatch, or if Steam's download cache / httpcache needs clearing while Steam is closed.`;
          autoFixable = true;
        } else {
          description = `Steam's content_log.txt directly reports: failed to fetch "${key}.manifest" (${fm.reason}) — this is why Steam displays "No internet connection". You need "${key}.manifest" in Steam/depotcache${localDisk ? ` (or ensure setManifestid(${fm.depotId}, "${localDisk}", 0) is actively loaded by SteamTools)` : ''}.`;
          autoFixable = Boolean(localDisk && !localPinned);
        }

        issues.push({
          code: 'steam_log_manifest_failed',
          severity: 'error',
          title: `Steam Log Error: Failed Manifest ${fm.depotId}_${fm.manifestId}`,
          description,
          autoFixable,
          depotId: fm.depotId,
          manifestId: fm.manifestId,
          fileName: `${key}.manifest`,
        });
      }

      for (const depotId of steamLog.missingKeyDepots) {
        const hasLuaKey = luaDirectives.some(
          (d) => d.id === depotId && isValidDepotDecryptionKey(d.decryptionKey)
        );
        issues.push({
          code: 'steam_log_missing_key',
          severity: 'error',
          title: `Steam Log Error: Missing Decryption Key for Depot ${depotId}`,
          description: hasLuaKey
            ? `Steam's content_log.txt reported a missing decryption key for Depot ${depotId}, even though your .lua script has a key. Stop Steam & run Auto-Fix so Lunex writes the key into Steam/config/config.vdf and restarts Steam.`
            : `Steam's content_log.txt reported a missing decryption key for Depot ${depotId}, and no valid 64-hex key was found in your .lua script or config.vdf.`,
          autoFixable: hasLuaKey,
          depotId,
        });
      }

      for (const corrupt of steamLog.corruptManifestFiles) {
        issues.push({
          code: 'steam_log_corrupt_manifest',
          severity: 'error',
          title: 'Steam Log Error: Failed to Load Local Manifest From Disk',
          description: `Steam's content_log.txt could not parse a local manifest (${corrupt}). Run Auto-Fix to unwrap/validate depotcache files and clear Steam's download cache, or re-import a clean raw .manifest.`,
          autoFixable: true,
        });
      }
    }

    // 11. Stuck Steam download state (incomplete ACF, stale MountedDepots, or leftover downloading/temp files)
    const missingMountedDepot = Object.entries(acfMountedDepots).find(
      ([depId, manId]) =>
        game.status === 'update_required' &&
        !depotManifestsByKey.has(`${depId}_${manId}`)
    );

    if (hasStuckDownloadState || missingMountedDepot) {
      issues.push({
        code: 'stuck_download_queue',
        severity: 'error',
        title: 'Stuck Steam Download Queue / Incomplete AppManifest Cache',
        description: missingMountedDepot
          ? `appmanifest_${game.appId}.acf references an old mounted manifest (${missingMountedDepot[0]}_${missingMountedDepot[1]}) that is missing from depotcache, causing Steam's delta updater to fail with "No connection". Auto-Fix stops Steam, backs up & resets the stuck ACF, clears downloading/temp staging, and clears Steam's httpcache.`
          : `Steam left behind an incomplete appmanifest_${game.appId}.acf or downloading/${game.appId} staging cache from a failed attempt. Auto-Fix stops Steam, clears staging + httpcache, and lets Steam perform a clean install.`,
        autoFixable: true,
      });
    }

    // 12. Missing Steam plugin DLL / Steam restart needed
    if (
      !isSimulatedSteam &&
      process.platform === 'win32' &&
      !steamEnvironment.pluginDetected &&
      luaFiles.length > 0
    ) {
      issues.push({
        code: 'steam_plugin_missing',
        severity: 'warning',
        title: 'Steam Plugin DLL Not Detected in Steam Folder',
        description: `No Steam plugin DLL (e.g. xinput1_4.dll, hid.dll, dwmapi.dll) was found in "${steamPath}". Unmodified Steam completely ignores config/stplug-in/*.lua files.`,
        autoFixable: false,
      });
    }

    if (steamEnvironment.needsSteamRestart) {
      issues.push({
        code: 'steam_restart_required',
        severity: 'warning',
        title: 'Restart Steam to Load Imported Manifests',
        description:
          'Manifests were imported or modified while Steam is running. Steam must be completely stopped and restarted so it reloads stplug-in scripts, depotcache, and config.vdf.',
        autoFixable: this.isElectron,
      });
    }

    const hasError = issues.some((i) => i.severity === 'error');
    const hasWarning = issues.some((i) => i.severity === 'warning');

    return {
      status: hasError ? 'blocked' : hasWarning ? 'needs_attention' : 'ready',
      issues,
      expectedDepots,
      hasLua: luaFiles.length > 0,
      hasManifestFiles: depotFiles.length > 0,
      hasStuckDownloadState: hasStuckDownloadState || Boolean(missingMountedDepot),
      steamRunning: steamEnvironment.steamRunning,
      pluginDetected: steamEnvironment.pluginDetected,
      steamLog,
      liveAppInfo,
    };
  }

  /**
   * Queries live public Steam metadata (api.steamcmd.net) for an AppID, tests Steam
   * internet reachability, caches the result, and returns refreshed SystemState.
   */
  public async checkLiveAppInfo(
    appId: string
  ): Promise<{ liveInfo: LiveSteamAppInfo; state: SystemState }> {
    const cleanAppId = appId.trim();
    if (!/^\d+$/.test(cleanAppId)) {
      throw new Error('AppID must be numeric.');
    }

    const liveInfo = await fetchLiveSteamAppInfo(cleanAppId);
    this.liveAppInfoCache[cleanAppId] = liveInfo;
    this.writeJsonFile('live-appinfo-cache.json', this.liveAppInfoCache);

    this.recordOperation({
      action: 'scan',
      status: liveInfo.error ? 'warning' : 'success',
      title: liveInfo.error
        ? `Live Steam Check Warning (AppID ${cleanAppId})`
        : `Checked Live Steam Depots: ${liveInfo.name ?? cleanAppId}`,
      details: liveInfo.error
        ? liveInfo.error
        : `Steam is reachable. Found ${liveInfo.depots.length} depot(s), ${liveInfo.dlcAppIds.length} DLC(s), public build ${liveInfo.buildId ?? 'unknown'}.`,
      appId: cleanAppId,
    });

    return {
      liveInfo,
      state: this.getState(),
    };
  }

  /**
   * Unpacks .zip bundles containing .lua and .manifest files into IncomingFilePayload[].
   */
  public unpackZipFiles(files: IncomingFilePayload[]): IncomingFilePayload[] {
    const expanded: IncomingFilePayload[] = [];
    for (const item of files) {
      const safeName = path.basename(item.fileName.trim());
      if (path.extname(safeName).toLowerCase() === '.zip') {
        const buffer = Buffer.from(item.base64Content, 'base64');
        const extracted = extractManifestZipBundle(buffer);
        if (extracted.length > 0) {
          for (const inner of extracted) {
            expanded.push({
              fileName: inner.fileName,
              base64Content: inner.data.toString('base64'),
              targetAppId: item.targetAppId,
            });
          }
          continue;
        }
      }
      expanded.push(item);
    }
    return expanded;
  }

  /**
   * Pre-validates incoming files without writing them, reporting errors, warnings,
   * detected AppIDs/depots, duplicate/replacement status, and cross-file install readiness.
   */
  public validateIncomingFiles(files: IncomingFilePayload[]): ValidationResult[] {
    const expandedFiles = this.unpackZipFiles(files);
    const state = this.getState();
    const existingByHash = new Map<string, ManagedManifest>();
    const existingByTarget = new Map<string, ManagedManifest>();
    const existingDepotFiles = new Set<string>();
    const existingLuaAppIds = new Set<string>();

    for (const mf of state.manifests) {
      existingByHash.set(mf.sha256, mf);
      existingByTarget.set(path.resolve(mf.filePath), mf);
      const dep = mf.headerDepotId ?? mf.depotId;
      const man = mf.headerManifestId ?? mf.manifestId;
      if (mf.fileType === 'manifest' && dep && man) {
        existingDepotFiles.add(`${dep}_${man}`);
      }
      if (mf.fileType === 'lua' && mf.appId !== 'unassigned') {
        existingLuaAppIds.add(mf.appId);
      }
    }

    const baseResults = expandedFiles.map((item) => {
      const safeName = path.basename(item.fileName.trim());
      const buffer = Buffer.from(item.base64Content, 'base64');
      return {
        item,
        safeName,
        base: validateManifestBuffer(safeName, buffer),
      };
    });

    const batchDepotManifests = new Set<string>();
    const batchLuaAppIds = new Set<string>();
    const batchLuaDepotIds = new Set<string>();

    for (const { item, base } of baseResults) {
      if (!base.valid) continue;
      const dep = base.headerDepotId ?? base.detectedDepotId;
      const man = base.headerManifestId ?? base.detectedManifestId;
      if (base.fileType === 'manifest' && dep && man) {
        batchDepotManifests.add(`${dep}_${man}`);
      }
      if (base.fileType === 'lua') {
        const appId = item.targetAppId?.trim() || base.detectedAppId;
        if (appId) batchLuaAppIds.add(appId);
        for (const d of base.directives ?? []) {
          batchLuaDepotIds.add(d.id);
        }
      }
    }

    return baseResults.map(({ item, safeName, base }) => {
      let duplicateStatus: ValidationResult['duplicateStatus'] = 'none';
      let existingFilePath: string | undefined;

      const canonicalDepot = base.headerDepotId ?? base.detectedDepotId;
      const canonicalManifest = base.headerManifestId ?? base.detectedManifestId;

      if (base.fileType !== 'unknown') {
        const effectiveName =
          base.fileType === 'manifest' && canonicalDepot && canonicalManifest
            ? `${canonicalDepot}_${canonicalManifest}.manifest`
            : safeName;

        const targetDir =
          base.fileType === 'lua'
            ? state.directories.lua.path
            : state.directories.manifest.path;
        const targetPath = path.resolve(path.join(targetDir, effectiveName));

        const hashMatch = existingByHash.get(base.sha256);
        const pathMatch = existingByTarget.get(targetPath);

        if (hashMatch) {
          duplicateStatus = 'exact_duplicate';
          existingFilePath = hashMatch.filePath;
          base.warnings.push(
            `Identical file content already exists as "${hashMatch.fileName}".`
          );
        } else if (pathMatch) {
          duplicateStatus = 'will_replace';
          existingFilePath = pathMatch.filePath;
          base.warnings.push(
            `An existing "${effectiveName}" will be replaced${this.settings.autoBackup ? ' (automatic backup enabled)' : ''}.`
          );
        }
      }

      if (item.targetAppId && /^\d+$/.test(item.targetAppId.trim())) {
        base.detectedAppId = item.targetAppId.trim();
      }

      if (base.valid && base.fileType === 'lua') {
        const missingDepots: string[] = [];
        for (const d of base.directives ?? []) {
          if (d.manifestId && isValidManifestGid(d.manifestId)) {
            const key = `${d.id}_${d.manifestId}`;
            if (!existingDepotFiles.has(key) && !batchDepotManifests.has(key)) {
              missingDepots.push(`${key}.manifest`);
            }
          }
        }
        if (missingDepots.length > 0) {
          base.warnings.push(
            `Missing ${missingDepots.slice(0, 2).join(', ')}${missingDepots.length > 2 ? ` (+${missingDepots.length - 2} more)` : ''} in depotcache — Steam will queue and fail with "No internet connection" until imported.`
          );
        }
      } else if (base.valid && base.fileType === 'manifest' && canonicalDepot) {
        const appId = item.targetAppId?.trim() || base.detectedAppId;
        const hasLuaOnDisk =
          (appId && existingLuaAppIds.has(appId)) ||
          state.manifests.some(
            (m) => m.fileType === 'lua' && m.appId === appId
          );
        const hasLuaInBatch =
          (appId && batchLuaAppIds.has(appId)) ||
          batchLuaDepotIds.has(canonicalDepot);

        if (!hasLuaOnDisk && !hasLuaInBatch) {
          base.warnings.push(
            'No matching .lua script in stplug-in — Steam needs a .lua file with addappid() decryption key and setManifestid() to install.'
          );
        }
      }

      return {
        ...base,
        duplicateStatus,
        existingFilePath,
      };
    });
  }

  private createBackupForFile(
    existingPath: string,
    appId: string,
    fileType: ManifestFileType,
    reason: BackupRecord['reason']
  ): BackupRecord {
    const dirs = this.resolveDirectories();
    fs.mkdirSync(dirs.backup.path, { recursive: true });

    const buf = fs.readFileSync(existingPath);
    const sha256 = computeSha256(buf);
    const originalFileName = path.basename(existingPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeAppId = appId && /^\d+$/.test(appId) ? appId : 'unassigned';
    const backupFileName = `${stamp}_${safeAppId}_${originalFileName}.bak`;
    const backupPath = path.join(dirs.backup.path, backupFileName);

    fs.copyFileSync(existingPath, backupPath);

    const record: BackupRecord = {
      id: crypto.randomUUID(),
      originalFileName,
      originalPath: path.resolve(existingPath),
      backupFileName,
      backupPath,
      appId: safeAppId,
      fileType,
      sizeBytes: buf.byteLength,
      sha256,
      createdAt: new Date().toISOString(),
      reason,
    };

    this.backups.unshift(record);
    if (this.backups.length > 100) {
      const removed = this.backups.splice(100);
      for (const old of removed) {
        try {
          if (fs.existsSync(old.backupPath)) fs.unlinkSync(old.backupPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    this.writeJsonFile('backups-index.json', this.backups);
    return record;
  }

  /**
   * Imports .lua, .manifest (automatically unwrapping ZIP/GZIP/ZLIB DepotManifests and
   * mirroring to Steam/config/depotcache + Vault), and .zip bundles with full validation,
   * automatic backup, AppID association, and comment-safe setManifestid() sync in .lua scripts.
   */
  public importFiles(
    files: IncomingFilePayload[],
    options?: { allowReplaceDuplicates?: boolean; syncLuaDirectives?: boolean }
  ): { outcomes: ImportFileOutcome[]; state: SystemState } {
    const expandedFiles = this.unpackZipFiles(files);
    const validations = this.validateIncomingFiles(expandedFiles);
    const dirs = this.resolveDirectories();
    const outcomes: ImportFileOutcome[] = [];
    const importedManifestSyncTargets: {
      appId: string;
      depotId: string;
      manifestId: string;
    }[] = [];
    let wroteAnyFile = false;

    for (let idx = 0; idx < expandedFiles.length; idx++) {
      const incoming = expandedFiles[idx];
      const val = validations[idx];
      const origSafeName = path.basename(incoming.fileName.trim());

      if (!val.valid || val.fileType === 'unknown') {
        const reason = val.errors.join(' ') || 'Validation failed.';
        this.recordOperation({
          action: 'import',
          status: 'error',
          title: `Rejected Invalid File: ${origSafeName}`,
          details: reason,
          fileName: origSafeName,
          appId: incoming.targetAppId || val.detectedAppId,
        });
        outcomes.push({
          fileName: origSafeName,
          status: 'invalid_rejected',
          message: reason,
          validation: val,
        });
        continue;
      }

      const canonicalDepot = val.headerDepotId ?? val.detectedDepotId;
      const canonicalManifest = val.headerManifestId ?? val.detectedManifestId;

      const targetFileName =
        val.fileType === 'manifest' && canonicalDepot && canonicalManifest
          ? `${canonicalDepot}_${canonicalManifest}.manifest`
          : origSafeName;

      if (
        val.duplicateStatus === 'exact_duplicate' &&
        !options?.allowReplaceDuplicates
      ) {
        const msg = `Skipped duplicate "${targetFileName}" — identical SHA-256 content already exists.`;
        this.recordOperation({
          action: 'import',
          status: 'warning',
          title: `Duplicate Skipped: ${targetFileName}`,
          details: msg,
          fileName: targetFileName,
          appId: incoming.targetAppId || val.detectedAppId,
        });
        outcomes.push({
          fileName: targetFileName,
          status: 'duplicate_skipped',
          message: msg,
          appId: incoming.targetAppId || val.detectedAppId,
          validation: val,
        });
        continue;
      }

      const targetDir =
        val.fileType === 'lua' ? dirs.lua.path : dirs.manifest.path;

      try {
        fs.mkdirSync(targetDir, { recursive: true });
        const targetPath = path.resolve(path.join(targetDir, targetFileName));
        const existedBefore = fs.existsSync(targetPath);
        let backupRecord: BackupRecord | undefined;

        const chosenAppId =
          incoming.targetAppId?.trim() ||
          val.detectedAppId ||
          this.associations[targetPath] ||
          this.associations[targetFileName] ||
          '';

        if (existedBefore && this.settings.autoBackup) {
          backupRecord = this.createBackupForFile(
            targetPath,
            chosenAppId || 'unassigned',
            val.fileType,
            'replace'
          );
          this.recordOperation({
            action: 'backup',
            status: 'success',
            title: `Backed Up Existing ${targetFileName}`,
            details: `Saved backup to ${backupRecord.backupFileName} before replacing.`,
            fileName: targetFileName,
            appId: chosenAppId || undefined,
          });
        }

        let buffer: Buffer = Buffer.from(incoming.base64Content, 'base64');
        let unwrappedNote = '';
        if (val.fileType === 'manifest' && val.isZipWrapped) {
          const unwrapped = unwrapZipManifestBuffer(buffer);
          if (unwrapped) {
            buffer = Buffer.from(unwrapped.unwrapped);
            unwrappedNote = ` (unwrapped from ${unwrapped.format.toUpperCase()} to raw 0x71F617D0 DepotManifest)`;
          }
        }

        fs.writeFileSync(targetPath, buffer);
        wroteAnyFile = true;

        // Mirror raw .manifest to Steam/config/depotcache + Lunex Vault so Steam can't prune it away
        if (val.fileType === 'manifest' && isRawSteamDepotManifest(buffer)) {
          this.mirrorRawManifest(targetFileName, buffer, dirs);
        }

        if (chosenAppId && /^\d+$/.test(chosenAppId)) {
          this.associations[targetPath] = chosenAppId;
          this.associations[targetFileName] = chosenAppId;
          this.writeJsonFile('manifest-associations.json', this.associations);
        }

        if (val.fileType === 'manifest' && canonicalDepot && canonicalManifest) {
          importedManifestSyncTargets.push({
            appId: chosenAppId,
            depotId: canonicalDepot,
            manifestId: canonicalManifest,
          });
        }

        const outcomeStatus = existedBefore ? 'replaced' : 'imported';
        const msg = existedBefore
          ? backupRecord
            ? `Replaced "${targetFileName}"${unwrappedNote} (previous version backed up).`
            : `Replaced "${targetFileName}"${unwrappedNote}.`
          : `Imported "${targetFileName}" into ${path.basename(targetDir)}${unwrappedNote}.`;

        this.recordOperation({
          action: 'import',
          status: 'success',
          title: existedBefore
            ? `Replaced ${targetFileName}`
            : `Imported ${targetFileName}`,
          details: msg,
          fileName: targetFileName,
          appId: chosenAppId || undefined,
        });

        outcomes.push({
          fileName: targetFileName,
          status: outcomeStatus,
          message: msg,
          appId: chosenAppId || undefined,
          backedUpTo: backupRecord?.backupPath,
          validation: val,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unexpected file write error.';
        this.recordOperation({
          action: 'import',
          status: 'error',
          title: `Failed to Import ${targetFileName}`,
          details: message,
          fileName: targetFileName,
        });
        outcomes.push({
          fileName: targetFileName,
          status: 'error',
          message,
          validation: val,
        });
      }
    }

    // Auto-sync setManifestid() in matching .lua scripts when .manifest files are imported
    if (
      options?.syncLuaDirectives !== false &&
      importedManifestSyncTargets.length > 0
    ) {
      const postState = this.getState();
      const configVdfKeys = dirs.steam.exists
        ? this.readConfigVdfKeys(dirs.steam.path)
        : new Map<string, string>();

      const byAppId = new Map<
        string,
        { depotId: string; manifestId: string; decryptionKey?: string }[]
      >();

      for (const item of importedManifestSyncTargets) {
        let resolvedAppId = item.appId;
        if (!resolvedAppId || !/^\d+$/.test(resolvedAppId)) {
          const matchedMf = postState.manifests.find(
            (m) =>
              m.fileType === 'manifest' &&
              (m.headerDepotId ?? m.depotId) === item.depotId &&
              (m.headerManifestId ?? m.manifestId) === item.manifestId
          );
          if (matchedMf && matchedMf.appId !== 'unassigned') {
            resolvedAppId = matchedMf.appId;
          }
        }
        if (!resolvedAppId || !/^\d+$/.test(resolvedAppId)) continue;

        const list = byAppId.get(resolvedAppId) ?? [];
        list.push({
          depotId: item.depotId,
          manifestId: item.manifestId,
          decryptionKey: configVdfKeys.get(item.depotId),
        });
        byAppId.set(resolvedAppId, list);
      }

      for (const [appId, depotEntries] of byAppId.entries()) {
        const luaMf =
          postState.manifests.find(
            (m) =>
              m.fileType === 'lua' &&
              m.appId === appId &&
              m.fileName.toLowerCase() === `${appId}.lua`
          ) ??
          postState.manifests.find(
            (m) => m.fileType === 'lua' && m.appId === appId
          );

        if (luaMf && fs.existsSync(luaMf.filePath)) {
          try {
            const luaText = fs.readFileSync(luaMf.filePath, 'utf8');
            const synced = upsertLuaManifestDirectives(
              luaText,
              appId,
              depotEntries
            );
            if (synced.changed) {
              if (this.settings.autoBackup) {
                this.createBackupForFile(
                  luaMf.filePath,
                  appId,
                  'lua',
                  'repair'
                );
              }
              fs.writeFileSync(luaMf.filePath, synced.updatedContent, 'utf8');
              wroteAnyFile = true;
              this.recordOperation({
                action: 'repair',
                status: 'success',
                title: `Synced setManifestid in ${luaMf.fileName}`,
                details: `Automatically updated ${depotEntries.map((d) => `${d.depotId}->${d.manifestId}`).join(', ')} in ${luaMf.fileName} so Steam uses local depotcache manifests.`,
                fileName: luaMf.fileName,
                appId,
              });
            }
          } catch {
            // Non-fatal sync failure
          }
        }
      }
    }

    if (wroteAnyFile && !dirs.isSimulatedSteam && isSteamProcessRunning()) {
      this.modifiedWhileSteamRunning = true;
    }

    return {
      outcomes,
      state: this.getState(),
    };
  }

  /**
   * End-to-end install repair in the STRICT SAFE ORDER:
   *  Step 0: Optionally adopt the running Steam path if Lunex pointed at a stale Steam folder.
   *  Step 1: STOP STEAM FIRST (when restartSteam=true) and wait until steam.exe exits so
   *          Steam does not hold file locks or overwrite config.vdf / ACF / cache on exit.
   *  Step 2: WHILE STEAM IS STOPPED:
   *    - Restore any depotcache manifests Steam deleted (from config/depotcache or Vault)
   *    - Unwrap ZIP/GZIP/ZLIB manifests to raw 0x71F617D0 binary
   *    - Rename misnamed / header-mismatched manifests to authoritative <depotId>_<manifestId>.manifest
   *    - Mirror all raw manifests to BOTH Steam/depotcache AND Steam/config/depotcache + Vault
   *    - Back up & remove stale <appId>.st binary plugin conflicting with <appId>.lua
   *    - Repair/uncomment/sync setManifestid() and addappid() directives in <appId>.lua
   *    - Surgically inject valid 64-hex depot decryption keys into Steam/config/config.vdf
   *      (preserving ConnectCache and all other Steam sections byte-for-byte!)
   *    - Clear ForceOfflineMode in steam.cfg & WantsOfflineMode in config/loginusers.vdf
   *    - Clear stuck downloading/<appId>, downloading/state_<appId>_*, temp/<appId>,
   *      incomplete appmanifest_<appId>.acf, and Steam/appcache/httpcache
   *  Step 3: RELAUNCH STEAM CLEANLY (when restartSteam=true) without racing steam://install on cold boot.
   */
  public async repairGameInstall(
    appId: string,
    options?: RepairInstallOptions
  ): Promise<RepairInstallResult> {
    const cleanAppId = appId.trim();
    if (!/^\d+$/.test(cleanAppId)) {
      throw new Error('AppID must be numeric.');
    }

    const actionsTaken: string[] = [];
    const warnings: string[] = [];
    let steamStopped = false;
    let steamRestarted = false;
    let configVdfSyncedCount = 0;
    let mirroredManifestCount = 0;
    let downloadCacheCleared = false;

    // Step 0: Switch to active running Steam folder if mismatched and requested
    let dirs = this.resolveDirectories();
    if (options?.adoptRunningSteamPath && !dirs.isSimulatedSteam) {
      const runningPath = getRunningSteamPath();
      if (
        runningPath &&
        normalizePathKey(runningPath) !== normalizePathKey(dirs.steam.path)
      ) {
        this.settings = {
          ...this.settings,
          steamPath: runningPath,
        };
        this.writeJsonFile('settings.json', this.settings);
        dirs = this.resolveDirectories();
        actionsTaken.push(
          `Switched Lunex Steam path to the active Steam installation at ${runningPath}.`
        );
      }
    }

    // Step 1: STOP STEAM FIRST before touching config.vdf, ACF, downloading, or httpcache!
    const wasSteamRunningInitially =
      !dirs.isSimulatedSteam && isSteamProcessRunning();

    if (options?.restartSteam && this.isElectron && !dirs.isSimulatedSteam) {
      if (wasSteamRunningInitially) {
        const stopResult = await stopSteamClient(dirs.steam.path);
        steamStopped = stopResult.stopped;
        if (stopResult.stopped) {
          actionsTaken.push(
            'Stopped Steam completely before modifying config.vdf, manifests, and download cache.'
          );
        } else {
          warnings.push(
            'Could not fully terminate steam.exe — close Steam manually (Exit Steam from tray) and run Auto-Fix again so config.vdf and cache repairs stick.'
          );
        }
      } else {
        steamStopped = true;
      }
    }

    const steamStillRunning =
      !dirs.isSimulatedSteam && isSteamProcessRunning();
    const initialState = this.getState();
    const gameManifests = initialState.manifests.filter(
      (m) => m.appId === cleanAppId
    );
    const configVdfKeys = dirs.steam.exists
      ? this.readConfigVdfKeys(dirs.steam.path)
      : new Map<string, string>();
    const configDepotcacheDir = path.join(
      dirs.steam.path,
      'config',
      'depotcache'
    );
    const configDepotcacheIndex = this.indexAuxiliaryManifestDir(
      configDepotcacheDir
    );
    const vaultIndex = this.indexAuxiliaryManifestDir(
      this.getManifestVaultDir()
    );

    // Step 2a: Restore any .manifest files missing from Steam/depotcache (from config/depotcache or Vault)
    const luaDirectivesForApp: ParsedLuaDirective[] = [];
    for (const mf of gameManifests) {
      if (mf.fileType === 'lua' && fs.existsSync(mf.filePath)) {
        try {
          luaDirectivesForApp.push(
            ...parseLuaDirectives(fs.readFileSync(mf.filePath, 'utf8'))
              .directives
          );
        } catch {
          // Ignore unreadable Lua
        }
      }
    }

    fs.mkdirSync(dirs.manifest.path, { recursive: true });
    for (const dir of luaDirectivesForApp) {
      if (dir.id === cleanAppId && !dir.manifestId && !dir.commentedManifestId) {
        continue;
      }
      const targetGid = dir.manifestId ?? dir.commentedManifestId;
      let sourcePath: string | undefined;
      let targetFileName: string | undefined;

      if (targetGid && isValidManifestGid(targetGid)) {
        const key = `${dir.id}_${targetGid}`;
        const destPath = path.join(dirs.manifest.path, `${key}.manifest`);
        if (!fs.existsSync(destPath)) {
          sourcePath =
            configDepotcacheIndex.byKey.get(key) ?? vaultIndex.byKey.get(key);
          targetFileName = `${key}.manifest`;
        }
      } else {
        const aux =
          configDepotcacheIndex.byDepot.get(dir.id)?.[0] ??
          vaultIndex.byDepot.get(dir.id)?.[0];
        if (aux) {
          const destPath = path.join(dirs.manifest.path, aux.fileName);
          if (!fs.existsSync(destPath)) {
            sourcePath = aux.filePath;
            targetFileName = aux.fileName;
          }
        }
      }

      if (sourcePath && targetFileName && fs.existsSync(sourcePath)) {
        try {
          const destPath = path.resolve(
            path.join(dirs.manifest.path, targetFileName)
          );
          let rawBuf: Buffer = fs.readFileSync(sourcePath);
          const unwrapped = unwrapZipManifestBuffer(rawBuf);
          if (unwrapped) rawBuf = Buffer.from(unwrapped.unwrapped);
          fs.writeFileSync(destPath, rawBuf);
          this.associations[destPath] = cleanAppId;
          this.associations[targetFileName] = cleanAppId;
          this.writeJsonFile('manifest-associations.json', this.associations);
          actionsTaken.push(
            `Restored missing "${targetFileName}" back into Steam/depotcache.`
          );
        } catch {
          // Ignore restore error
        }
      }
    }

    // Step 2b: Unwrap compressed .manifest files, normalize filenames using 0x1F4812BE headers, & dual-mirror
    const preUnwrapManifests = this.getState().manifests.filter(
      (m) => m.appId === cleanAppId && m.fileType === 'manifest'
    );

    for (const mf of preUnwrapManifests) {
      if (!fs.existsSync(mf.filePath)) continue;

      let buf: Buffer = fs.readFileSync(mf.filePath);
      let modifiedContent = false;

      if (
        mf.isZipWrapped ||
        (buf.byteLength >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_MAGIC) ||
        (buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)
      ) {
        const unwrapped = unwrapZipManifestBuffer(buf);
        if (unwrapped) {
          if (this.settings.autoBackup) {
            this.createBackupForFile(
              mf.filePath,
              cleanAppId,
              'manifest',
              'repair'
            );
          }
          buf = Buffer.from(unwrapped.unwrapped);
          fs.writeFileSync(mf.filePath, buf);
          modifiedContent = true;
          actionsTaken.push(
            `Unwrapped ${unwrapped.format.toUpperCase()}-compressed ${mf.fileName} to raw 0x71F617D0 DepotManifest binary.`
          );
        }
      }

      const binMeta = parseDepotManifestMetadata(buf);
      const authDepotId = binMeta?.depotId ?? mf.headerDepotId ?? mf.depotId;
      const authManifestId =
        binMeta?.manifestId ?? mf.headerManifestId ?? mf.manifestId;

      let activePath = path.resolve(mf.filePath);
      let activeName = mf.fileName;

      if (authDepotId && authManifestId) {
        const canonicalName = `${authDepotId}_${authManifestId}.manifest`;
        const canonicalPath = path.resolve(
          path.join(dirs.manifest.path, canonicalName)
        );
        if (activePath !== canonicalPath) {
          if (!modifiedContent && this.settings.autoBackup) {
            this.createBackupForFile(
              activePath,
              cleanAppId,
              'manifest',
              'repair'
            );
          }
          if (!fs.existsSync(canonicalPath)) {
            fs.renameSync(activePath, canonicalPath);
            delete this.associations[activePath];
            delete this.associations[activeName];
            this.associations[canonicalPath] = cleanAppId;
            this.associations[canonicalName] = cleanAppId;
            this.writeJsonFile('manifest-associations.json', this.associations);
            actionsTaken.push(
              `Renamed ${activeName} to authoritative Steam depotcache name ${canonicalName}.`
            );
            activePath = canonicalPath;
            activeName = canonicalName;
          }
        }
      }

      if (isRawSteamDepotManifest(buf)) {
        const mirrorRes = this.mirrorRawManifest(activeName, buf, dirs);
        if (mirrorRes.mirroredToConfigDepotcache) {
          mirroredManifestCount++;
        }
      }
    }

    if (mirroredManifestCount > 0) {
      actionsTaken.push(
        `Mirrored ${mirroredManifestCount} raw .manifest file(s) to Steam/config/depotcache and Lunex Vault.`
      );
    }

    // Step 2c: Back up & remove stale <appId>.st binary plugin when <appId>.lua exists
    const midState = this.getState();
    const updatedManifests = midState.manifests.filter(
      (m) => m.appId === cleanAppId
    );
    const existingLua =
      updatedManifests.find(
        (m) =>
          m.fileType === 'lua' &&
          m.fileName.toLowerCase() === `${cleanAppId}.lua`
      ) ?? updatedManifests.find((m) => m.fileType === 'lua');

    if (existingLua) {
      const staleStPath = path.join(dirs.lua.path, `${cleanAppId}.st`);
      if (fs.existsSync(staleStPath)) {
        try {
          if (this.settings.autoBackup) {
            this.createBackupForFile(staleStPath, cleanAppId, 'lua', 'repair');
          }
          fs.unlinkSync(staleStPath);
          actionsTaken.push(
            `Backed up and removed conflicting ${cleanAppId}.st so SteamTools loads ${existingLua.fileName}.`
          );
        } catch {
          // Ignore locked .st file
        }
      }
    }

    // Step 2d: Repair/uncomment/sync setManifestid() in <appId>.lua (or scaffold if keys exist in config.vdf)
    const depotEntries = updatedManifests
      .filter(
        (m) =>
          m.fileType === 'manifest' &&
          m.isValid &&
          (m.headerDepotId ?? m.depotId) &&
          (m.headerManifestId ?? m.manifestId)
      )
      .map((m) => {
        const depotId = (m.headerDepotId ?? m.depotId)!;
        const manifestId = (m.headerManifestId ?? m.manifestId)!;
        return {
          depotId,
          manifestId,
          decryptionKey: configVdfKeys.get(depotId),
        };
      });

    if (
      existingLua &&
      fs.existsSync(existingLua.filePath) &&
      depotEntries.length > 0
    ) {
      const luaContent = fs.readFileSync(existingLua.filePath, 'utf8');
      const synced = upsertLuaManifestDirectives(
        luaContent,
        cleanAppId,
        depotEntries
      );
      if (synced.changed) {
        if (this.settings.autoBackup) {
          this.createBackupForFile(
            existingLua.filePath,
            cleanAppId,
            'lua',
            'repair'
          );
        }
        fs.writeFileSync(existingLua.filePath, synced.updatedContent, 'utf8');
        actionsTaken.push(
          `Synced & uncommented setManifestid() directives in ${existingLua.fileName} to match depotcache files.`
        );
      }
    } else if (
      !existingLua &&
      depotEntries.length > 0 &&
      depotEntries.some((d) => isValidDepotDecryptionKey(d.decryptionKey))
    ) {
      fs.mkdirSync(dirs.lua.path, { recursive: true });
      const newLuaPath = path.join(dirs.lua.path, `${cleanAppId}.lua`);
      const generated = upsertLuaManifestDirectives(
        '',
        cleanAppId,
        depotEntries
      );
      fs.writeFileSync(newLuaPath, generated.updatedContent, 'utf8');
      this.associations[path.resolve(newLuaPath)] = cleanAppId;
      this.associations[`${cleanAppId}.lua`] = cleanAppId;
      this.writeJsonFile('manifest-associations.json', this.associations);
      actionsTaken.push(
        `Created ${cleanAppId}.lua with recovered decryption keys and setManifestid() directives.`
      );
    }

    // Step 2e: Steam-stopped-only repairs: config.vdf key sync, offline config reset, stuck ACF/staging, httpcache
    if (!steamStillRunning) {
      // 1) Surgically sync valid 64-hex depot decryption keys into Steam/config/config.vdf
      const configVdfPath = path.join(dirs.steam.path, 'config', 'config.vdf');
      if (fs.existsSync(configVdfPath)) {
        const luaForKeys = this.getState().manifests.filter(
          (m) =>
            m.appId === cleanAppId &&
            m.fileType === 'lua' &&
            fs.existsSync(m.filePath)
        );
        const keysToSync: Record<string, string> = {};
        for (const mf of luaForKeys) {
          try {
            const { directives } = parseLuaDirectives(
              fs.readFileSync(mf.filePath, 'utf8')
            );
            for (const d of directives) {
              if (d.decryptionKey && isValidDepotDecryptionKey(d.decryptionKey)) {
                keysToSync[d.id] = d.decryptionKey;
              }
            }
          } catch {
            // Ignore unreadable Lua
          }
        }

        if (Object.keys(keysToSync).length > 0) {
          try {
            const currentConfig = fs.readFileSync(configVdfPath, 'utf8');
            const { updatedContent, addedCount } = upsertConfigVdfDepotKeys(
              currentConfig,
              keysToSync
            );
            if (addedCount > 0) {
              if (this.settings.autoBackup) {
                this.createBackupForFile(
                  configVdfPath,
                  cleanAppId,
                  'manifest',
                  'repair'
                );
              }
              // Atomic write via temp file to protect config.vdf integrity
              const tmpPath = `${configVdfPath}.lunex.tmp`;
              fs.writeFileSync(tmpPath, updatedContent, 'utf8');
              fs.renameSync(tmpPath, configVdfPath);
              configVdfSyncedCount = addedCount;
              actionsTaken.push(
                `Surgically synced ${addedCount} depot decryption key(s) into Steam/config/config.vdf.`
              );
            }
          } catch {
            warnings.push(
              'Could not update Steam/config/config.vdf — verify file permissions.'
            );
          }
        }
      }

      // 2) Clear ForceOfflineMode in steam.cfg / WantsOfflineMode in loginusers.vdf
      if (dirs.steam.exists && checkSteamOfflineConfig(dirs.steam.path)) {
        const cleared = clearSteamOfflineConfig(dirs.steam.path, (p) => {
          if (this.settings.autoBackup) {
            this.createBackupForFile(p, cleanAppId, 'manifest', 'repair');
          }
        });
        if (cleared.changedFiles.length > 0) {
          actionsTaken.push(
            `Disabled Steam Offline Mode in ${cleared.changedFiles.join(' & ')}.`
          );
        }
      }

      // 3) Clear stuck downloading/<appId>, downloading/state_<appId>_*, temp/<appId>, & incomplete ACF
      const libraryRoots = this.getLibraryRoots(
        dirs.steam.path,
        dirs.steam.exists
      );
      for (const libRoot of libraryRoots) {
        const steamapps = path.join(libRoot, 'steamapps');
        const downloadingDir = path.join(steamapps, 'downloading');

        const dlTarget = path.join(downloadingDir, cleanAppId);
        if (fs.existsSync(dlTarget)) {
          try {
            fs.rmSync(dlTarget, { recursive: true, force: true });
            actionsTaken.push(
              `Cleared stale Steam downloading/${cleanAppId} staging cache.`
            );
          } catch {
            // Ignore locked file
          }
        }

        // Remove state_<appId>_*.patch files inside steamapps/downloading
        if (fs.existsSync(downloadingDir)) {
          try {
            const statePrefix = `state_${cleanAppId}_`;
            for (const entry of fs.readdirSync(downloadingDir)) {
              if (entry.toLowerCase().startsWith(statePrefix)) {
                fs.rmSync(path.join(downloadingDir, entry), {
                  recursive: true,
                  force: true,
                });
                actionsTaken.push(
                  `Cleared stuck Steam patch state file downloading/${entry}.`
                );
              }
            }
          } catch {
            // Ignore unreadable downloading dir
          }
        }

        const tempTarget = path.join(steamapps, 'temp', cleanAppId);
        if (fs.existsSync(tempTarget)) {
          try {
            fs.rmSync(tempTarget, { recursive: true, force: true });
            actionsTaken.push(
              `Cleared stale Steam temp/${cleanAppId} staging cache.`
            );
          } catch {
            // Ignore locked file
          }
        }

        const acfPath = path.join(steamapps, `appmanifest_${cleanAppId}.acf`);
        if (fs.existsSync(acfPath)) {
          try {
            const parsed = parseAppManifestAcf(fs.readFileSync(acfPath, 'utf8'));
            const isFullyInstalled =
              parsed &&
              (parsed.stateFlags === 4 ||
                ((parsed.stateFlags & 4) === 4 &&
                  (parsed.stateFlags & 2) === 0));

            if (!isFullyInstalled) {
              const installCommonPath = parsed?.installDir
                ? path.join(steamapps, 'common', parsed.installDir)
                : '';
              const installMissingOrEmpty =
                !installCommonPath ||
                !fs.existsSync(installCommonPath) ||
                fs.readdirSync(installCommonPath).length === 0;
              const isStuck =
                !parsed ||
                parsed.sizeOnDisk === 0 ||
                (parsed.stateFlags & 1024) !== 0 ||
                (parsed.stateFlags & 512) !== 0 ||
                (parsed.bytesToDownload > 0 &&
                  parsed.bytesDownloaded < parsed.bytesToDownload) ||
                Object.keys(parsed.stagedDepots).length > 0 ||
                installMissingOrEmpty;

              if (isStuck) {
                if (this.settings.autoBackup) {
                  this.createBackupForFile(
                    acfPath,
                    cleanAppId,
                    'manifest',
                    'repair'
                  );
                }
                fs.unlinkSync(acfPath);
                actionsTaken.push(
                  `Backed up and removed stuck appmanifest_${cleanAppId}.acf (StateFlags=${parsed?.stateFlags ?? 'corrupt'}) so Steam starts a clean install.`
                );
              }
            }
          } catch {
            // Ignore ACF error
          }
        }
      }

      // 4) Clear Steam HTTP download cache (Steam/appcache/httpcache) — drops cached HTTP 401/error responses
      if (options?.clearDownloadCache !== false && dirs.steam.exists) {
        const httpCacheDir = path.join(dirs.steam.path, 'appcache', 'httpcache');
        if (fs.existsSync(httpCacheDir)) {
          try {
            fs.rmSync(httpCacheDir, { recursive: true, force: true });
            downloadCacheCleared = true;
            actionsTaken.push(
              'Cleared Steam Download HTTP Cache (appcache/httpcache) to drop cached failed manifest responses.'
            );
          } catch {
            warnings.push(
              'Could not fully clear Steam/appcache/httpcache (some files were locked).'
            );
          }
        }
      }
    } else {
      warnings.push(
        'Steam is still running — config.vdf key sync, stuck appmanifest cleanup, offline-mode reset, and Steam Download Cache (appcache/httpcache) clearing require stopping Steam first so Steam does not overwrite them. Click "Stop Steam, Fix All & Restart".'
      );
    }

    // Step 3: Relaunch Steam cleanly ONLY AFTER all writes are complete!
    if (options?.restartSteam && this.isElectron && !dirs.isSimulatedSteam) {
      if (!isSteamProcessRunning()) {
        steamRestarted = startSteamClient(dirs.steam.path);
        if (steamRestarted) {
          this.modifiedWhileSteamRunning = false;
          actionsTaken.push(
            'Relaunched Steam cleanly. Wait ~5–10 seconds for Steam & plugins to sign in before clicking Install.'
          );
        }
      }
    } else if (actionsTaken.length > 0 && steamStillRunning) {
      this.modifiedWhileSteamRunning = true;
    }

    if (actionsTaken.length > 0) {
      this.recordOperation({
        action: 'repair',
        status: warnings.length > 0 ? 'warning' : 'success',
        title: `Repaired Install Setup for AppID ${cleanAppId}`,
        details: actionsTaken.join(' '),
        appId: cleanAppId,
      });
    } else {
      this.recordOperation({
        action: 'repair',
        status: 'warning',
        title: `Checked AppID ${cleanAppId} Install Readiness`,
        details:
          warnings[0] ??
          'No automatic file repairs were needed; inspect Steam content_log.txt or Live Depot diagnostics below.',
        appId: cleanAppId,
      });
    }

    const finalState = this.getState();
    const gameAfter = finalState.games.find((g) => g.appId === cleanAppId);

    return {
      appId: cleanAppId,
      fixedCount: actionsTaken.length,
      actionsTaken,
      warnings,
      remainingIssues: gameAfter?.installDiagnostics?.issues ?? [],
      steamStopped,
      steamRestarted,
      configVdfSyncedCount,
      mirroredManifestCount,
      downloadCacheCleared,
      state: finalState,
    };
  }

  /**
   * Associates an existing manifest or Lua file with a specific Steam AppID.
   */
  public associateManifest(filePath: string, appId: string): SystemState {
    const cleanAppId = appId.trim();
    if (cleanAppId !== 'unassigned' && !/^\d+$/.test(cleanAppId)) {
      throw new Error('AppID must be numeric (e.g. 1091500).');
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Manifest file not found: ${resolved}`);
    }

    const fileName = path.basename(resolved);
    if (cleanAppId === 'unassigned') {
      delete this.associations[resolved];
      delete this.associations[fileName];
    } else {
      this.associations[resolved] = cleanAppId;
      this.associations[fileName] = cleanAppId;

      const state = this.getState();
      if (!state.games.some((g) => g.appId === cleanAppId)) {
        this.manualGames.push({
          appId: cleanAppId,
          name:
            this.liveAppInfoCache[cleanAppId]?.name ||
            KNOWN_STEAM_TITLES[cleanAppId] ||
            `Steam App ${cleanAppId}`,
          addedAt: new Date().toISOString(),
        });
        this.writeJsonFile('manual-games.json', this.manualGames);
      }
    }

    this.writeJsonFile('manifest-associations.json', this.associations);
    this.recordOperation({
      action: 'associate',
      status: 'success',
      title: 'Updated Manifest Association',
      details:
        cleanAppId === 'unassigned'
          ? `Unlinked ${fileName} from AppID.`
          : `Associated ${fileName} with AppID ${cleanAppId}.`,
      fileName,
      appId: cleanAppId === 'unassigned' ? undefined : cleanAppId,
    });

    return this.getState();
  }

  /**
   * Deletes an imported manifest file (creating a safety backup first if autoBackup is enabled).
   */
  public deleteManifest(filePath: string): SystemState {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      this.recordOperation({
        action: 'delete',
        status: 'error',
        title: 'Delete Failed',
        details: `File does not exist at ${resolved}`,
      });
      throw new Error('Manifest file no longer exists on disk.');
    }

    const fileName = path.basename(resolved);
    const ext = path.extname(fileName).toLowerCase();
    const fileType: ManifestFileType = ext === '.lua' ? 'lua' : 'manifest';
    const associatedAppId =
      this.associations[resolved] ?? this.associations[fileName] ?? 'unassigned';

    let backupNote = '';
    if (this.settings.autoBackup) {
      const backup = this.createBackupForFile(
        resolved,
        associatedAppId,
        fileType,
        'delete'
      );
      backupNote = ` (backed up as ${backup.backupFileName})`;
    }

    fs.unlinkSync(resolved);
    delete this.associations[resolved];
    delete this.associations[fileName];
    this.writeJsonFile('manifest-associations.json', this.associations);

    const dirs = this.resolveDirectories();
    if (!dirs.isSimulatedSteam && isSteamProcessRunning()) {
      this.modifiedWhileSteamRunning = true;
    }

    this.recordOperation({
      action: 'delete',
      status: 'success',
      title: `Deleted ${fileName}`,
      details: `Removed ${fileName} from disk${backupNote}.`,
      fileName,
      appId: associatedAppId !== 'unassigned' ? associatedAppId : undefined,
    });

    return this.getState();
  }

  /**
   * Restores a backed-up manifest back to its original or currently configured directory.
   */
  public restoreBackup(backupId: string): SystemState {
    const backup = this.backups.find((b) => b.id === backupId);
    if (!backup || !fs.existsSync(backup.backupPath)) {
      this.recordOperation({
        action: 'restore',
        status: 'error',
        title: 'Backup Restore Failed',
        details: 'Backup archive file could not be found on disk.',
      });
      throw new Error('Backup file not found.');
    }

    const dirs = this.resolveDirectories();
    const targetDir =
      backup.fileType === 'lua' ? dirs.lua.path : dirs.manifest.path;
    fs.mkdirSync(targetDir, { recursive: true });
    const restorePath = path.join(targetDir, backup.originalFileName);

    if (fs.existsSync(restorePath) && this.settings.autoBackup) {
      const currentHash = computeSha256(fs.readFileSync(restorePath));
      if (currentHash !== backup.sha256) {
        this.createBackupForFile(
          restorePath,
          backup.appId,
          backup.fileType,
          'replace'
        );
      }
    }

    fs.copyFileSync(backup.backupPath, restorePath);
    if (backup.fileType === 'manifest') {
      const rawBuf = fs.readFileSync(restorePath);
      if (isRawSteamDepotManifest(rawBuf)) {
        this.mirrorRawManifest(backup.originalFileName, rawBuf, dirs);
      }
    }

    if (backup.appId && backup.appId !== 'unassigned') {
      this.associations[restorePath] = backup.appId;
      this.associations[backup.originalFileName] = backup.appId;
      this.writeJsonFile('manifest-associations.json', this.associations);
    }

    this.recordOperation({
      action: 'restore',
      status: 'success',
      title: `Restored ${backup.originalFileName}`,
      details: `Restored backup (${backup.backupFileName}) to ${targetDir}.`,
      fileName: backup.originalFileName,
      appId: backup.appId !== 'unassigned' ? backup.appId : undefined,
    });

    return this.getState();
  }

  /**
   * Inspects the contents / parsed directives / binary header of a managed manifest.
   */
  public inspectManifest(filePath: string): ManifestInspection {
    const state = this.getState();
    const resolved = path.resolve(filePath);
    const manifest = state.manifests.find(
      (m) => path.resolve(m.filePath) === resolved
    );
    if (!manifest || !fs.existsSync(resolved)) {
      throw new Error('Manifest file not found.');
    }

    const buf = fs.readFileSync(resolved);
    if (manifest.fileType === 'lua') {
      const textContent = buf.toString('utf8');
      const { directives } = parseLuaDirectives(textContent);
      return {
        manifest,
        textContent,
        directives,
      };
    }

    const headerSlice = buf.subarray(0, Math.min(32, buf.byteLength));
    const hexHeader = Array.from(headerSlice)
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
    const magicValid =
      buf.byteLength >= 4 && buf.readUInt32LE(0) === STEAM_MANIFEST_MAGIC;

    return {
      manifest,
      hexHeader,
      magicValid,
    };
  }

  /**
   * Manually adds a Steam game entry by AppID (and optional display name).
   */
  public addManualGame(appId: string, customName?: string): SystemState {
    const cleanId = appId.trim();
    if (!/^\d+$/.test(cleanId)) {
      this.recordOperation({
        action: 'add_game',
        status: 'error',
        title: 'Invalid AppID',
        details: `Cannot add "${appId}" — Steam AppIDs must contain digits only.`,
      });
      throw new Error(
        'Steam AppID must be a valid positive number (e.g. 1086940).'
      );
    }

    const resolvedName =
      customName?.trim() ||
      this.liveAppInfoCache[cleanId]?.name ||
      KNOWN_STEAM_TITLES[cleanId] ||
      `Steam App ${cleanId}`;

    const existingIdx = this.manualGames.findIndex((g) => g.appId === cleanId);
    if (existingIdx >= 0) {
      this.manualGames[existingIdx].name = resolvedName;
    } else {
      this.manualGames.push({
        appId: cleanId,
        name: resolvedName,
        addedAt: new Date().toISOString(),
      });
    }

    this.writeJsonFile('manual-games.json', this.manualGames);
    this.recordOperation({
      action: 'add_game',
      status: 'success',
      title: `Added ${resolvedName}`,
      details: `Registered AppID ${cleanId} in Game Library.`,
      appId: cleanId,
    });

    return this.getState();
  }

  /**
   * Removes a manually added game entry from Lunex's manual registry.
   */
  public removeManualGame(appId: string): SystemState {
    const cleanId = appId.trim();
    const before = this.manualGames.length;
    const target = this.manualGames.find((g) => g.appId === cleanId);
    this.manualGames = this.manualGames.filter((g) => g.appId !== cleanId);

    if (this.manualGames.length !== before) {
      this.writeJsonFile('manual-games.json', this.manualGames);
      this.recordOperation({
        action: 'remove_game',
        status: 'success',
        title: `Removed Manual Entry (${cleanId})`,
        details: `Removed "${target?.name ?? cleanId}" from manual game entries.`,
        appId: cleanId,
      });
    }

    return this.getState();
  }

  /**
   * Updates Lunex settings (custom directories, auto-backup, launch with Windows)
   * and validates custom paths.
   */
  public updateSettings(partial: Partial<LunexSettings>): SystemState {
    const prevLaunch = this.settings.launchWithWindows;

    const updated: LunexSettings = {
      ...this.settings,
      ...partial,
      steamPath: (partial.steamPath ?? this.settings.steamPath).trim(),
      customLuaPath: (partial.customLuaPath ?? this.settings.customLuaPath).trim(),
      customManifestPath: (
        partial.customManifestPath ?? this.settings.customManifestPath
      ).trim(),
      customBackupPath: (
        partial.customBackupPath ?? this.settings.customBackupPath
      ).trim(),
    };

    for (const customDir of [
      updated.customLuaPath,
      updated.customManifestPath,
      updated.customBackupPath,
    ]) {
      if (customDir) {
        try {
          fs.mkdirSync(path.resolve(customDir), { recursive: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Invalid path';
          this.recordOperation({
            action: 'settings',
            status: 'error',
            title: 'Invalid Custom Directory',
            details: `Could not access or create "${customDir}": ${msg}`,
          });
          throw new Error(
            `Could not create or access directory "${customDir}": ${msg}`
          );
        }
      }
    }

    if (updated.steamPath) {
      const resolvedSteam = path.resolve(updated.steamPath);
      if (
        !fs.existsSync(resolvedSteam) ||
        !fs.statSync(resolvedSteam).isDirectory()
      ) {
        this.recordOperation({
          action: 'settings',
          status: 'error',
          title: 'Invalid Steam Path',
          details: `Configured Steam path "${resolvedSteam}" does not exist.`,
        });
        throw new Error(`Steam directory "${resolvedSteam}" does not exist.`);
      }
    }

    this.settings = updated;
    this.writeJsonFile('settings.json', this.settings);

    if (
      prevLaunch !== this.settings.launchWithWindows &&
      this.onLaunchWithWindowsChange
    ) {
      this.onLaunchWithWindowsChange(this.settings.launchWithWindows);
    }

    this.recordOperation({
      action: 'settings',
      status: 'success',
      title: 'Settings Updated',
      details: `Saved configuration (Auto Backup: ${this.settings.autoBackup ? 'Enabled' : 'Disabled'}, Launch with Windows: ${this.settings.launchWithWindows ? 'Enabled' : 'Disabled'}).`,
    });

    return this.getState();
  }

  public rescan(): SystemState {
    const state = this.getState();
    this.recordOperation({
      action: 'scan',
      status: 'success',
      title: 'Library & Manifest Scan Complete',
      details: `Detected ${state.games.length} games and ${state.manifests.length} manifest files.`,
    });
    return this.getState();
  }

  public clearOperations(): SystemState {
    this.operations = [];
    this.writeJsonFile('operations-log.json', this.operations);
    return this.getState();
  }
}
