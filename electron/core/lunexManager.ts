import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkSteamOfflineConfig,
  detectSteamPlugins,
  isSteamProcessRunning,
  KNOWN_STEAM_TITLES,
  locateSteamDirectory,
  restartSteamClient,
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
  LunexSettings,
  ManagedManifest,
  ManifestFileType,
  ManifestInspection,
  OperationRecord,
  ParsedLuaDirective,
  RepairInstallResult,
  SteamEnvironmentStatus,
  SteamGame,
  SystemState,
  ValidationResult,
} from './types.js';
import {
  computeSha256,
  extractManifestZipBundle,
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

export class LunexManager {
  private readonly dataDir: string;
  private readonly isElectron: boolean;
  private readonly onLaunchWithWindowsChange?: (enabled: boolean) => void;

  private settings: LunexSettings;
  private manualGames: ManualGameEntry[];
  private associations: Record<string, string>; // key: normalized filePath or fileName -> appId
  private backups: BackupRecord[];
  private operations: OperationRecord[];
  private modifiedWhileSteamRunning = false;

  constructor(options: LunexManagerOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.isElectron = Boolean(options.isElectron);
    this.onLaunchWithWindowsChange = options.onLaunchWithWindowsChange;

    fs.mkdirSync(this.dataDir, { recursive: true });

    this.settings = this.readJsonFile<LunexSettings>('settings.json', {
      ...DEFAULT_SETTINGS,
    });
    this.manualGames = this.readJsonFile<ManualGameEntry[]>('manual-games.json', []);
    this.associations = this.readJsonFile<Record<string, string>>(
      'manifest-associations.json',
      {}
    );
    this.backups = this.readJsonFile<BackupRecord[]>('backups-index.json', []);
    this.operations = this.readJsonFile<OperationRecord[]>('operations-log.json', []);

    // Ensure initial system scan log entry on first boot
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

  private tryReadLocalSteamIcon(steamRoot: string, appId: string): string | undefined {
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
   * Scans Steam libraries, managed .lua & .manifest directories, and manual entries
   * to return the complete, synchronized SystemState with per-game install diagnostics.
   */
  public getState(): SystemState {
    const dirs = this.resolveDirectories();
    const gamesMap = new Map<string, SteamGame>();
    const depotToAppId = new Map<string, string>();
    const stuckDownloadApps = new Set<string>();

    const steamRunning = !dirs.isSimulatedSteam && isSteamProcessRunning();
    if (!steamRunning) {
      this.modifiedWhileSteamRunning = false;
    }

    const pluginCheck = dirs.steam.exists
      ? detectSteamPlugins(dirs.steam.path)
      : { detected: false, files: [] };

    const steamEnvironment: SteamEnvironmentStatus = {
      steamRunning,
      pluginDetected: pluginCheck.detected,
      pluginFiles: pluginCheck.files,
      luaDirInSteam:
        normalizePathKey(dirs.lua.path) ===
        normalizePathKey(path.join(dirs.steam.path, 'config', 'stplug-in')),
      manifestDirInSteam:
        normalizePathKey(dirs.manifest.path) ===
        normalizePathKey(path.join(dirs.steam.path, 'depotcache')),
      offlineModeConfigured:
        dirs.steam.exists && checkSteamOfflineConfig(dirs.steam.path),
      needsSteamRestart: this.modifiedWhileSteamRunning && steamRunning,
    };

    // 1. Discover Steam library folders via libraryfolders.vdf + root steamapps
    const libraryRoots = this.getLibraryRoots(dirs.steam.path, dirs.steam.exists);

    // 2. Parse appmanifest_*.acf and check stuck download staging folders
    for (const libRoot of libraryRoots) {
      const steamapps = path.join(libRoot, 'steamapps');
      if (!fs.existsSync(steamapps)) continue;

      for (const stagingName of ['downloading', 'temp']) {
        const stagingDir = path.join(steamapps, stagingName);
        if (fs.existsSync(stagingDir)) {
          try {
            for (const item of fs.readdirSync(stagingDir)) {
              if (/^\d+$/.test(item)) {
                stuckDownloadApps.add(item);
              }
            }
          } catch {
            // Ignore unreadable staging folder
          }
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

          // StateFlags === 4 indicates fully installed; bit 2 indicates update required
          const isFullyInstalled =
            parsed.stateFlags === 4 ||
            ((parsed.stateFlags & 4) === 4 && (parsed.stateFlags & 2) === 0);
          const status: GameInstallStatus = isFullyInstalled
            ? 'installed'
            : 'update_required';

          // Stuck download detection: incomplete ACF with 0 bytes on disk or queued/downloading state
          if (
            !isFullyInstalled &&
            (parsed.sizeOnDisk === 0 ||
              (parsed.stateFlags & 1024) !== 0 ||
              (parsed.stateFlags & 512) !== 0)
          ) {
            if (parsed.sizeOnDisk === 0) {
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
            localIconDataUrl: this.tryReadLocalSteamIcon(dirs.steam.path, parsed.appId),
          });
        } catch {
          // Skip unreadable ACF file
        }
      }
    }

    // 3. Merge manual game entries
    for (const manual of this.manualGames) {
      const existing = gamesMap.get(manual.appId);
      if (existing) {
        if (manual.name && existing.name.startsWith('Steam App ')) {
          existing.name = manual.name;
        }
        existing.isManual = true;
      } else {
        gamesMap.set(manual.appId, {
          appId: manual.appId,
          name:
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
    const shaFirstSeen = new Map<string, string>(); // sha256 -> fileName
    const luaDirectivesByAppId = new Map<string, ParsedLuaDirective[]>();
    const manifestsByAppId = new Map<string, ManagedManifest[]>();
    const depotManifestsByKey = new Map<string, ManagedManifest>(); // `${depotId}_${manifestId}`
    const depotManifestsByDepot = new Map<string, ManagedManifest[]>();

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
          // Map all depots inside this .lua file to its primary AppID
          if (resolvedAppId && val.directives) {
            for (const directive of val.directives) {
              depotToAppId.set(directive.id, resolvedAppId);
            }
            const existingDirs = luaDirectivesByAppId.get(resolvedAppId) ?? [];
            existingDirs.push(...val.directives);
            luaDirectivesByAppId.set(resolvedAppId, existingDirs);
          }
        } else {
          // .manifest: map via explicit override, or depotToAppId from Lua directives, or direct AppID match
          if (!resolvedAppId && val.detectedDepotId) {
            if (depotToAppId.has(val.detectedDepotId)) {
              resolvedAppId = depotToAppId.get(val.detectedDepotId)!;
            } else if (gamesMap.has(val.detectedDepotId)) {
              resolvedAppId = val.detectedDepotId;
            } else {
              // Heuristic: Steam primary depot IDs are very often AppID + 1 (e.g. 1091501 -> 1091500)
              const numericDepot = Number.parseInt(val.detectedDepotId, 10);
              if (!Number.isNaN(numericDepot) && numericDepot > 1) {
                const candidateAppId = String(numericDepot - 1);
                if (gamesMap.has(candidateAppId) || KNOWN_STEAM_TITLES[candidateAppId]) {
                  resolvedAppId = candidateAppId;
                }
              }
            }
          }
        }

        if (!resolvedAppId) {
          resolvedAppId = 'unassigned';
        }

        // Duplicate detection by SHA-256 content hash
        const prevFileWithHash = shaFirstSeen.get(val.sha256);
        const isDuplicate = Boolean(prevFileWithHash && prevFileWithHash !== fileName);
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

        if (mfRecord.fileType === 'manifest' && mfRecord.depotId) {
          if (mfRecord.manifestId) {
            depotManifestsByKey.set(
              `${mfRecord.depotId}_${mfRecord.manifestId}`,
              mfRecord
            );
          }
          const byDepot = depotManifestsByDepot.get(mfRecord.depotId) ?? [];
          byDepot.push(mfRecord);
          depotManifestsByDepot.set(mfRecord.depotId, byDepot);
        }
      }
    };

    scanDirectory(dirs.lua.path, '.lua');
    scanDirectory(dirs.manifest.path, '.manifest');

    // 5. Link manifests to games & ensure Lua-discovered games appear in Library
    for (const mf of rawManifests) {
      if (mf.appId !== 'unassigned' && /^\d+$/.test(mf.appId)) {
        let game = gamesMap.get(mf.appId);
        if (!game) {
          game = {
            appId: mf.appId,
            name: KNOWN_STEAM_TITLES[mf.appId] || `Steam App ${mf.appId}`,
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
        } else if (game.status === 'not_installed' && mf.isValid) {
          game.status = 'manifest_only';
        }

        if (mf.fileType === 'lua') {
          game.luaCount += 1;
        } else {
          game.manifestCount += 1;
          if (mf.depotId && !game.linkedDepots.includes(mf.depotId)) {
            game.linkedDepots.push(mf.depotId);
          }
        }
        mf.gameName = game.name;

        const list = manifestsByAppId.get(mf.appId) ?? [];
        list.push(mf);
        manifestsByAppId.set(mf.appId, list);
      }
    }

    // 6. Compute install-readiness diagnostics for games with manifests or stuck queue state
    const configVdfKeys = dirs.steam.exists
      ? this.readConfigVdfKeys(dirs.steam.path)
      : new Map<string, string>();

    for (const game of gamesMap.values()) {
      const gameManifests = manifestsByAppId.get(game.appId) ?? [];
      const hasStuck = stuckDownloadApps.has(game.appId);
      if (gameManifests.length === 0 && !hasStuck) {
        continue;
      }

      game.installDiagnostics = this.computeGameDiagnostics({
        game,
        gameManifests,
        luaDirectives: luaDirectivesByAppId.get(game.appId) ?? [],
        depotManifestsByKey,
        depotManifestsByDepot,
        configVdfKeys,
        hasStuckDownloadState: hasStuck,
        isSimulatedSteam: dirs.isSimulatedSteam,
        steamPath: dirs.steam.path,
        steamEnvironment,
      });
    }

    const games = Array.from(gamesMap.values()).sort((a, b) => {
      // Installed first, then manifest_only, then manual not_installed, alphabetical within group
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

    // Keep only backup records whose backup file still exists on disk
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
    configVdfKeys: Map<string, string>;
    hasStuckDownloadState: boolean;
    isSimulatedSteam: boolean;
    steamPath: string;
    steamEnvironment: SteamEnvironmentStatus;
  }): GameInstallDiagnostics {
    const {
      game,
      gameManifests,
      luaDirectives,
      depotManifestsByKey,
      depotManifestsByDepot,
      configVdfKeys,
      hasStuckDownloadState,
      isSimulatedSteam,
      steamPath,
      steamEnvironment,
    } = params;

    const issues: InstallIssue[] = [];
    const expectedDepots: ExpectedDepotStatus[] = [];

    const luaFiles = gameManifests.filter((m) => m.fileType === 'lua');
    const depotFiles = gameManifests.filter((m) => m.fileType === 'manifest');

    // 1. Simulated Steam or mismatched custom directories
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

    // 2. Invalid or ZIP-wrapped or misnamed manifest files
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
          title: `ZIP-Wrapped Depot Manifest: ${mf.fileName}`,
          description:
            'This .manifest file is still ZIP-compressed instead of raw 0x71F617D0 binary. Steam fails to read it locally, tries to download from Valve servers, and fails with an internet error.',
          autoFixable: true,
          depotId: mf.depotId,
          manifestId: mf.manifestId,
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

    // 3. Missing .lua script when .manifest files exist
    if (depotFiles.length > 0 && luaFiles.length === 0) {
      const anyKeyInVdf = depotFiles.some(
        (d) => d.depotId && configVdfKeys.has(d.depotId)
      );
      issues.push({
        code: 'missing_lua',
        severity: 'error',
        title: 'Missing .lua Script in stplug-in',
        description:
          'You imported .manifest file(s), but there is no .lua script in Steam/config/stplug-in. Without addappid() decryption keys and setManifestid(), Steam queues the download and fails with a connection error.',
        autoFixable: anyKeyInVdf,
      });
    }

    // 4. Inspect depots declared in .lua directives
    const seenDepotIds = new Set<string>();
    const depotDirectives = luaDirectives.filter(
      (d) => d.id !== game.appId || Boolean(d.manifestId || d.decryptionKey)
    );

    for (const dir of depotDirectives) {
      if (seenDepotIds.has(dir.id)) continue;
      seenDepotIds.add(dir.id);

      const hasKey = Boolean(dir.decryptionKey) || configVdfKeys.has(dir.id);
      const exactDiskMatch = dir.manifestId
        ? depotManifestsByKey.get(`${dir.id}_${dir.manifestId}`)
        : undefined;
      const anyDiskForDepot = depotManifestsByDepot.get(dir.id)?.[0];
      const diskMatch = exactDiskMatch ?? anyDiskForDepot;

      expectedDepots.push({
        depotId: dir.id,
        hasDecryptionKey: hasKey,
        luaManifestId: dir.manifestId,
        diskManifestFile: diskMatch?.fileName,
        diskManifestId: diskMatch?.manifestId,
        isZipWrapped: diskMatch?.isZipWrapped,
      });

      if (!hasKey) {
        issues.push({
          code: 'missing_decryption_key',
          severity: 'error',
          title: `Missing Decryption Key for Depot ${dir.id}`,
          description: `Depot ${dir.id} has no 64-character hex decryption key in the .lua script or config.vdf. Steam cannot decrypt or install this depot without its key.`,
          autoFixable: false,
          depotId: dir.id,
        });
      }

      if (dir.manifestId && !exactDiskMatch) {
        if (anyDiskForDepot && anyDiskForDepot.manifestId) {
          issues.push({
            code: 'manifest_id_mismatch',
            severity: 'error',
            title: `Manifest ID Mismatch for Depot ${dir.id}`,
            description: `.lua pins setManifestid(${dir.id}, "${dir.manifestId}"), but depotcache has "${anyDiskForDepot.fileName}" (${anyDiskForDepot.manifestId}). Steam fails trying to download the missing manifest online.`,
            autoFixable: true,
            depotId: dir.id,
            manifestId: anyDiskForDepot.manifestId,
            fileName: anyDiskForDepot.fileName,
          });
        } else {
          issues.push({
            code: 'missing_depot_manifest',
            severity: 'error',
            title: `Missing Depot Manifest: ${dir.id}_${dir.manifestId}.manifest`,
            description: `The .lua script requires "${dir.id}_${dir.manifestId}.manifest" in Steam/depotcache, but it is missing. This causes Steam to show "Download queued" and then fail with an internet error.`,
            autoFixable: false,
            depotId: dir.id,
            manifestId: dir.manifestId,
          });
        }
      } else if (!dir.manifestId) {
        if (anyDiskForDepot && anyDiskForDepot.manifestId) {
          issues.push({
            code: 'missing_set_manifest_id',
            severity: 'error',
            title: `Missing setManifestid() in .lua for Depot ${dir.id}`,
            description: `"${anyDiskForDepot.fileName}" is in depotcache, but the .lua script lacks setManifestid(${dir.id}, "${anyDiskForDepot.manifestId}", 0). Without it, Steam ignores the local file and fails contacting Valve servers.`,
            autoFixable: true,
            depotId: dir.id,
            manifestId: anyDiskForDepot.manifestId,
            fileName: anyDiskForDepot.fileName,
          });
        } else {
          issues.push({
            code: 'missing_depot_manifest',
            severity: 'warning',
            title: `No Pinned .manifest File for Depot ${dir.id}`,
            description: `Depot ${dir.id} in .lua has no setManifestid() and no matching .manifest in depotcache. Steam will attempt to fetch the manifest from Valve servers, which usually fails for unowned depots.`,
            autoFixable: false,
            depotId: dir.id,
          });
        }
      }
    }

    // 5. Check depot .manifest files linked to this game that aren't in .lua yet
    for (const mf of depotFiles) {
      if (!mf.depotId || seenDepotIds.has(mf.depotId)) continue;
      seenDepotIds.add(mf.depotId);

      const hasKey = configVdfKeys.has(mf.depotId);
      expectedDepots.push({
        depotId: mf.depotId,
        hasDecryptionKey: hasKey,
        diskManifestFile: mf.fileName,
        diskManifestId: mf.manifestId,
        isZipWrapped: mf.isZipWrapped,
      });

      if (luaFiles.length > 0 && mf.manifestId) {
        issues.push({
          code: 'missing_set_manifest_id',
          severity: 'error',
          title: `Unlinked Depot ${mf.depotId} in .lua`,
          description: `"${mf.fileName}" is in depotcache, but ${luaFiles[0].fileName} does not include setManifestid(${mf.depotId}, "${mf.manifestId}", 0).`,
          autoFixable: true,
          depotId: mf.depotId,
          manifestId: mf.manifestId,
          fileName: mf.fileName,
        });
      }
    }

    // 6. Stuck Steam download state (0-byte ACF or leftover downloading/temp files)
    if (hasStuckDownloadState) {
      issues.push({
        code: 'stuck_download_queue',
        severity: 'error',
        title: 'Stuck Steam Download Queue / Staging Cache',
        description: `Steam left behind an incomplete appmanifest_${game.appId}.acf or downloading/${game.appId} cache from a failed attempt. Clearing it lets Steam perform a clean install.`,
        autoFixable: true,
      });
    }

    // 7. Steam Offline mode / missing SteamTools plugin / Steam restart needed
    if (steamEnvironment.offlineModeConfigured) {
      issues.push({
        code: 'steam_offline_mode',
        severity: 'warning',
        title: 'Steam Configured for Offline Mode',
        description:
          'Steam configuration (steam.cfg or loginusers.vdf) requests Offline Mode, which prevents downloading game chunks.',
        autoFixable: false,
      });
    }

    if (
      !isSimulatedSteam &&
      process.platform === 'win32' &&
      !steamEnvironment.pluginDetected &&
      luaFiles.length > 0
    ) {
      issues.push({
        code: 'steam_plugin_missing',
        severity: 'warning',
        title: 'SteamTools Plugin DLL Not Detected',
        description: `No Steam plugin DLL (e.g. xinput1_4.dll, hid.dll) was found in ${steamPath}. Unmodified Steam ignores config/stplug-in/*.lua files.`,
        autoFixable: false,
      });
    }

    if (steamEnvironment.needsSteamRestart) {
      issues.push({
        code: 'steam_restart_required',
        severity: 'warning',
        title: 'Restart Steam to Load Imported Manifests',
        description:
          'Manifests were imported or modified while Steam is running. Steam must be restarted so it reloads stplug-in scripts and depotcache files.',
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
      hasStuckDownloadState,
      steamRunning: steamEnvironment.steamRunning,
      pluginDetected: steamEnvironment.pluginDetected,
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
      if (mf.fileType === 'manifest' && mf.depotId && mf.manifestId) {
        existingDepotFiles.add(`${mf.depotId}_${mf.manifestId}`);
      }
      if (mf.fileType === 'lua' && mf.appId !== 'unassigned') {
        existingLuaAppIds.add(mf.appId);
      }
    }

    // First pass: validate individual buffers and collect batch contents
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
      if (base.fileType === 'manifest' && base.detectedDepotId && base.detectedManifestId) {
        batchDepotManifests.add(`${base.detectedDepotId}_${base.detectedManifestId}`);
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

      if (base.fileType !== 'unknown') {
        const effectiveName =
          base.fileType === 'manifest' &&
          base.detectedDepotId &&
          base.detectedManifestId &&
          (base.isZipWrapped || !/^\d+_\d+\.manifest$/i.test(safeName))
            ? `${base.detectedDepotId}_${base.detectedManifestId}.manifest`
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

      // Cross-file install readiness checks
      if (base.valid && base.fileType === 'lua') {
        const missingDepots: string[] = [];
        for (const d of base.directives ?? []) {
          if (d.manifestId) {
            const key = `${d.id}_${d.manifestId}`;
            if (!existingDepotFiles.has(key) && !batchDepotManifests.has(key)) {
              missingDepots.push(`${key}.manifest`);
            }
          }
        }
        if (missingDepots.length > 0) {
          base.warnings.push(
            `Missing ${missingDepots.slice(0, 2).join(', ')}${missingDepots.length > 2 ? ` (+${missingDepots.length - 2} more)` : ''} in depotcache — Steam will queue and fail with an internet error until imported.`
          );
        }
      } else if (base.valid && base.fileType === 'manifest' && base.detectedDepotId) {
        const appId = item.targetAppId?.trim() || base.detectedAppId;
        const hasLuaOnDisk =
          (appId && existingLuaAppIds.has(appId)) ||
          state.manifests.some(
            (m) => m.fileType === 'lua' && m.appId === appId
          );
        const hasLuaInBatch =
          (appId && batchLuaAppIds.has(appId)) ||
          batchLuaDepotIds.has(base.detectedDepotId);

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
   * Imports .lua, .manifest (automatically unwrapping ZIP-wrapped DepotManifests),
   * and .zip bundles with full validation, duplicate handling, automatic backup,
   * AppID association, and automatic setManifestid() sync in .lua scripts.
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

      // Normalize .manifest filename to <depotId>_<manifestId>.manifest if IDs are known
      const targetFileName =
        val.fileType === 'manifest' &&
        val.detectedDepotId &&
        val.detectedManifestId &&
        (val.isZipWrapped || !/^\d+_\d+\.manifest$/i.test(origSafeName))
          ? `${val.detectedDepotId}_${val.detectedManifestId}.manifest`
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
            unwrappedNote = ' (unwrapped from ZIP to raw 0x71F617D0 DepotManifest)';
          }
        }

        fs.writeFileSync(targetPath, buffer);
        wroteAnyFile = true;

        if (chosenAppId && /^\d+$/.test(chosenAppId)) {
          this.associations[targetPath] = chosenAppId;
          this.associations[targetFileName] = chosenAppId;
          this.writeJsonFile('manifest-associations.json', this.associations);
        }

        if (
          val.fileType === 'manifest' &&
          val.detectedDepotId &&
          val.detectedManifestId
        ) {
          importedManifestSyncTargets.push({
            appId: chosenAppId,
            depotId: val.detectedDepotId,
            manifestId: val.detectedManifestId,
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

    // Optional auto-sync of setManifestid() in matching .lua scripts when .manifest files are imported
    if (options?.syncLuaDirectives && importedManifestSyncTargets.length > 0) {
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
              m.depotId === item.depotId &&
              m.manifestId === item.manifestId
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
                this.createBackupForFile(luaMf.filePath, appId, 'lua', 'repair');
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
   * Automatically repairs common install blockers for an AppID that cause Steam to
   * say "Download queued" and then fail with a network/internet error:
   *  1. Unwraps ZIP-wrapped .manifest files in depotcache to raw 0x71F617D0 binary
   *  2. Normalizes misnamed .manifest files to <depotId>_<manifestId>.manifest
   *  3. Syncs setManifestid() & config.vdf keys into <appId>.lua (or creates scaffold)
   *  4. Clears stuck 0-byte appmanifest_<appId>.acf and steamapps/downloading|temp/<appId>
   *  5. Syncs depot decryption keys to Steam/config/config.vdf when Steam is closed
   *  6. Optionally restarts Steam & triggers steam://install/<appId> in Electron
   */
  public async repairGameInstall(
    appId: string,
    options?: { restartSteam?: boolean }
  ): Promise<RepairInstallResult> {
    const cleanAppId = appId.trim();
    if (!/^\d+$/.test(cleanAppId)) {
      throw new Error('AppID must be numeric.');
    }

    const initialState = this.getState();
    const dirs = this.resolveDirectories();
    const actionsTaken: string[] = [];
    const gameManifests = initialState.manifests.filter(
      (m) => m.appId === cleanAppId
    );
    const configVdfKeys = dirs.steam.exists
      ? this.readConfigVdfKeys(dirs.steam.path)
      : new Map<string, string>();

    // 1 & 2. Unwrap ZIP-wrapped .manifest files & normalize filenames in depotcache
    for (const mf of gameManifests) {
      if (mf.fileType !== 'manifest' || !fs.existsSync(mf.filePath)) continue;

      let buf: Buffer = fs.readFileSync(mf.filePath);
      let modifiedContent = false;

      if (buf.byteLength >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_MAGIC) {
        const unwrapped = unwrapZipManifestBuffer(buf);
        if (unwrapped) {
          if (this.settings.autoBackup) {
            this.createBackupForFile(mf.filePath, cleanAppId, 'manifest', 'repair');
          }
          buf = Buffer.from(unwrapped.unwrapped);
          fs.writeFileSync(mf.filePath, buf);
          modifiedContent = true;
          actionsTaken.push(
            `Unwrapped ZIP-compressed ${mf.fileName} to raw 0x71F617D0 DepotManifest binary.`
          );
        }
      }

      if (mf.depotId && mf.manifestId) {
        const canonicalName = `${mf.depotId}_${mf.manifestId}.manifest`;
        const canonicalPath = path.resolve(
          path.join(dirs.manifest.path, canonicalName)
        );
        if (path.resolve(mf.filePath) !== canonicalPath) {
          if (!modifiedContent && this.settings.autoBackup) {
            this.createBackupForFile(mf.filePath, cleanAppId, 'manifest', 'repair');
          }
          if (!fs.existsSync(canonicalPath)) {
            fs.renameSync(mf.filePath, canonicalPath);
            delete this.associations[path.resolve(mf.filePath)];
            delete this.associations[mf.fileName];
            this.associations[canonicalPath] = cleanAppId;
            this.associations[canonicalName] = cleanAppId;
            this.writeJsonFile('manifest-associations.json', this.associations);
            actionsTaken.push(
              `Renamed ${mf.fileName} to canonical Steam depotcache name ${canonicalName}.`
            );
          }
        }
      }
    }

    // Re-read manifests after any unwrapping/renaming
    const midState = this.getState();
    const updatedManifests = midState.manifests.filter(
      (m) => m.appId === cleanAppId
    );
    const depotEntries = updatedManifests
      .filter((m) => m.fileType === 'manifest' && m.isValid && m.depotId && m.manifestId)
      .map((m) => ({
        depotId: m.depotId!,
        manifestId: m.manifestId!,
        decryptionKey: configVdfKeys.get(m.depotId!),
      }));

    // 3. Sync setManifestid() in existing .lua or scaffold <appId>.lua if keys exist
    const existingLua =
      updatedManifests.find(
        (m) =>
          m.fileType === 'lua' &&
          m.fileName.toLowerCase() === `${cleanAppId}.lua`
      ) ?? updatedManifests.find((m) => m.fileType === 'lua');

    if (existingLua && fs.existsSync(existingLua.filePath) && depotEntries.length > 0) {
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
          `Synced setManifestid() directives in ${existingLua.fileName} to match depotcache files.`
        );
      }
    } else if (
      !existingLua &&
      depotEntries.length > 0 &&
      depotEntries.some((d) => Boolean(d.decryptionKey))
    ) {
      fs.mkdirSync(dirs.lua.path, { recursive: true });
      const newLuaPath = path.join(dirs.lua.path, `${cleanAppId}.lua`);
      const generated = upsertLuaManifestDirectives('', cleanAppId, depotEntries);
      fs.writeFileSync(newLuaPath, generated.updatedContent, 'utf8');
      this.associations[path.resolve(newLuaPath)] = cleanAppId;
      this.associations[`${cleanAppId}.lua`] = cleanAppId;
      this.writeJsonFile('manifest-associations.json', this.associations);
      actionsTaken.push(
        `Created ${cleanAppId}.lua with recovered decryption keys and setManifestid() directives.`
      );
    }

    // 4. Clear stuck Steam download staging folders and 0-byte queued ACF files
    const libraryRoots = this.getLibraryRoots(dirs.steam.path, dirs.steam.exists);
    for (const libRoot of libraryRoots) {
      const steamapps = path.join(libRoot, 'steamapps');
      for (const stagingName of ['downloading', 'temp']) {
        const target = path.join(steamapps, stagingName, cleanAppId);
        if (fs.existsSync(target)) {
          try {
            fs.rmSync(target, { recursive: true, force: true });
            actionsTaken.push(
              `Cleared stale Steam ${stagingName}/${cleanAppId} staging cache.`
            );
          } catch {
            // Ignore locked staging file
          }
        }
      }

      const acfPath = path.join(steamapps, `appmanifest_${cleanAppId}.acf`);
      if (fs.existsSync(acfPath)) {
        try {
          const parsed = parseAppManifestAcf(fs.readFileSync(acfPath, 'utf8'));
          const isStuck =
            !parsed ||
            (parsed.stateFlags !== 4 &&
              (parsed.sizeOnDisk === 0 ||
                (parsed.stateFlags & 1024) !== 0 ||
                (parsed.stateFlags & 512) !== 0));
          if (isStuck && (!parsed || parsed.sizeOnDisk === 0)) {
            if (this.settings.autoBackup) {
              this.createBackupForFile(acfPath, cleanAppId, 'manifest', 'repair');
            }
            fs.unlinkSync(acfPath);
            actionsTaken.push(
              `Removed stuck 0-byte appmanifest_${cleanAppId}.acf so Steam starts a clean install.`
            );
          }
        } catch {
          // Ignore ACF read error
        }
      }
    }

    // 5. Optionally restart Steam first if requested, and sync depot keys to config.vdf while Steam is stopped
    let steamRestarted = false;
    if (options?.restartSteam && this.isElectron && !dirs.isSimulatedSteam) {
      steamRestarted = await restartSteamClient(dirs.steam.path, cleanAppId);
      if (steamRestarted) {
        this.modifiedWhileSteamRunning = false;
        actionsTaken.push(
          `Restarted Steam to reload config/stplug-in & depotcache and queued AppID ${cleanAppId}.`
        );
      }
    }

    const steamStillRunning = !dirs.isSimulatedSteam && isSteamProcessRunning();
    const configVdfPath = path.join(dirs.steam.path, 'config', 'config.vdf');
    if (!steamStillRunning && fs.existsSync(configVdfPath)) {
      const luaForKeys = this.getState().manifests.filter(
        (m) => m.appId === cleanAppId && m.fileType === 'lua' && fs.existsSync(m.filePath)
      );
      const keysToSync: Record<string, string> = {};
      for (const mf of luaForKeys) {
        try {
          const { directives } = parseLuaDirectives(fs.readFileSync(mf.filePath, 'utf8'));
          for (const d of directives) {
            if (d.decryptionKey) {
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
            fs.writeFileSync(configVdfPath, updatedContent, 'utf8');
            actionsTaken.push(
              `Synced ${addedCount} depot decryption key(s) into Steam config/config.vdf.`
            );
          }
        } catch {
          // Ignore config.vdf write errors
        }
      }
    }

    if (actionsTaken.length > 0) {
      this.recordOperation({
        action: 'repair',
        status: 'success',
        title: `Repaired Install Setup for AppID ${cleanAppId}`,
        details: actionsTaken.join(' '),
        appId: cleanAppId,
      });
    } else {
      this.recordOperation({
        action: 'repair',
        status: 'warning',
        title: `Checked AppID ${cleanAppId} Install Readiness`,
        details: 'No automatic file repairs were needed; check diagnostics for manual steps.',
        appId: cleanAppId,
      });
    }

    const finalState = this.getState();
    const gameAfter = finalState.games.find((g) => g.appId === cleanAppId);

    return {
      appId: cleanAppId,
      fixedCount: actionsTaken.length,
      actionsTaken,
      remainingIssues: gameAfter?.installDiagnostics?.issues ?? [],
      steamRestarted,
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

      // Ensure game exists in library if not already discovered
      const state = this.getState();
      if (!state.games.some((g) => g.appId === cleanAppId)) {
        this.manualGames.push({
          appId: cleanAppId,
          name: KNOWN_STEAM_TITLES[cleanAppId] || `Steam App ${cleanAppId}`,
          addedAt: new Date().toISOString(),
        });
        this.writeJsonFile('manual-games.json', this.manualGames);
      }
    }

    this.writeJsonFile('manifest-associations.json', this.associations);
    this.recordOperation({
      action: 'associate',
      status: 'success',
      title: `Updated Manifest Association`,
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
      throw new Error('Steam AppID must be a valid positive number (e.g. 1086940).');
    }

    const resolvedName =
      customName?.trim() ||
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

    // Ensure custom directories are created if valid local paths are supplied
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
          throw new Error(`Could not create or access directory "${customDir}": ${msg}`);
        }
      }
    }

    if (updated.steamPath) {
      const resolvedSteam = path.resolve(updated.steamPath);
      if (!fs.existsSync(resolvedSteam) || !fs.statSync(resolvedSteam).isDirectory()) {
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
