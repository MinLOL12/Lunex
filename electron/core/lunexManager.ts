import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_STEAM_TITLES, locateSteamDirectory } from './steamLocator.js';
import type {
  BackupRecord,
  DirectoryStatus,
  GameInstallStatus,
  ImportFileOutcome,
  IncomingFilePayload,
  LunexSettings,
  ManagedManifest,
  ManifestFileType,
  ManifestInspection,
  OperationRecord,
  SteamGame,
  SystemState,
  ValidationResult,
} from './types.js';
import {
  computeSha256,
  parseLuaDirectives,
  STEAM_MANIFEST_MAGIC,
  validateManifestBuffer,
} from './validator.js';
import { parseAppManifestAcf, parseLibraryFoldersVdf } from './vdfParser.js';

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

export class LunexManager {
  private readonly dataDir: string;
  private readonly isElectron: boolean;
  private readonly onLaunchWithWindowsChange?: (enabled: boolean) => void;

  private settings: LunexSettings;
  private manualGames: ManualGameEntry[];
  private associations: Record<string, string>; // key: normalized filePath or fileName -> appId
  private backups: BackupRecord[];
  private operations: OperationRecord[];

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
   * to return the complete, synchronized SystemState.
   */
  public getState(): SystemState {
    const dirs = this.resolveDirectories();
    const gamesMap = new Map<string, SteamGame>();
    const depotToAppId = new Map<string, string>();

    // 1. Discover Steam library folders via libraryfolders.vdf + root steamapps
    const libraryRoots = new Set<string>();
    if (dirs.steam.exists) {
      libraryRoots.add(dirs.steam.path);
      const vdfPath = path.join(dirs.steam.path, 'steamapps', 'libraryfolders.vdf');
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
    }

    // 2. Parse appmanifest_*.acf in each Steam library folder
    for (const libRoot of libraryRoots) {
      const steamapps = path.join(libRoot, 'steamapps');
      if (!fs.existsSync(steamapps)) continue;
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
          const isFullyInstalled = parsed.stateFlags === 4 || (parsed.stateFlags & 4) === 4 && (parsed.stateFlags & 2) === 0;
          const status: GameInstallStatus = isFullyInstalled
            ? 'installed'
            : 'update_required';

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

        rawManifests.push({
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
        });
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
      }
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
      games,
      manifests: rawManifests,
      backups: [...this.backups],
      operations: [...this.operations],
    };
  }

  /**
   * Pre-validates incoming files without writing them, reporting errors, warnings,
   * detected AppIDs/depots, and duplicate/replacement status.
   */
  public validateIncomingFiles(files: IncomingFilePayload[]): ValidationResult[] {
    const state = this.getState();
    const existingByHash = new Map<string, ManagedManifest>();
    const existingByTarget = new Map<string, ManagedManifest>();

    for (const mf of state.manifests) {
      existingByHash.set(mf.sha256, mf);
      existingByTarget.set(path.resolve(mf.filePath), mf);
    }

    return files.map((item) => {
      const safeName = path.basename(item.fileName.trim());
      const buffer = Buffer.from(item.base64Content, 'base64');
      const baseResult = validateManifestBuffer(safeName, buffer);

      let duplicateStatus: ValidationResult['duplicateStatus'] = 'none';
      let existingFilePath: string | undefined;

      if (baseResult.fileType !== 'unknown') {
        const targetDir =
          baseResult.fileType === 'lua'
            ? state.directories.lua.path
            : state.directories.manifest.path;
        const targetPath = path.resolve(path.join(targetDir, safeName));

        const hashMatch = existingByHash.get(baseResult.sha256);
        const pathMatch = existingByTarget.get(targetPath);

        if (hashMatch) {
          duplicateStatus = 'exact_duplicate';
          existingFilePath = hashMatch.filePath;
          baseResult.warnings.push(
            `Identical file content already exists as "${hashMatch.fileName}".`
          );
        } else if (pathMatch) {
          duplicateStatus = 'will_replace';
          existingFilePath = pathMatch.filePath;
          baseResult.warnings.push(
            `An existing "${safeName}" will be replaced${this.settings.autoBackup ? ' (automatic backup enabled)' : ''}.`
          );
        }
      }

      if (item.targetAppId && /^\d+$/.test(item.targetAppId.trim())) {
        baseResult.detectedAppId = item.targetAppId.trim();
      }

      return {
        ...baseResult,
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
   * Imports .lua and .manifest files with full validation, duplicate handling,
   * automatic backup before replacement, and AppID association.
   */
  public importFiles(
    files: IncomingFilePayload[],
    options?: { allowReplaceDuplicates?: boolean }
  ): { outcomes: ImportFileOutcome[]; state: SystemState } {
    const validations = this.validateIncomingFiles(files);
    const dirs = this.resolveDirectories();
    const outcomes: ImportFileOutcome[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      const incoming = files[idx];
      const val = validations[idx];
      const safeName = path.basename(incoming.fileName.trim());

      if (!val.valid || val.fileType === 'unknown') {
        const reason = val.errors.join(' ') || 'Validation failed.';
        this.recordOperation({
          action: 'import',
          status: 'error',
          title: `Rejected Invalid File: ${safeName}`,
          details: reason,
          fileName: safeName,
          appId: incoming.targetAppId || val.detectedAppId,
        });
        outcomes.push({
          fileName: safeName,
          status: 'invalid_rejected',
          message: reason,
          validation: val,
        });
        continue;
      }

      if (
        val.duplicateStatus === 'exact_duplicate' &&
        !options?.allowReplaceDuplicates
      ) {
        const msg = `Skipped duplicate "${safeName}" — identical SHA-256 content already exists.`;
        this.recordOperation({
          action: 'import',
          status: 'warning',
          title: `Duplicate Skipped: ${safeName}`,
          details: msg,
          fileName: safeName,
          appId: incoming.targetAppId || val.detectedAppId,
        });
        outcomes.push({
          fileName: safeName,
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
        const targetPath = path.resolve(path.join(targetDir, safeName));
        const existedBefore = fs.existsSync(targetPath);
        let backupRecord: BackupRecord | undefined;

        const chosenAppId =
          incoming.targetAppId?.trim() ||
          val.detectedAppId ||
          this.associations[targetPath] ||
          this.associations[safeName] ||
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
            title: `Backed Up Existing ${safeName}`,
            details: `Saved backup to ${backupRecord.backupFileName} before replacing.`,
            fileName: safeName,
            appId: chosenAppId || undefined,
          });
        }

        const buffer = Buffer.from(incoming.base64Content, 'base64');
        fs.writeFileSync(targetPath, buffer);

        if (chosenAppId && /^\d+$/.test(chosenAppId)) {
          this.associations[targetPath] = chosenAppId;
          this.associations[safeName] = chosenAppId;
          this.writeJsonFile('manifest-associations.json', this.associations);
        }

        const outcomeStatus = existedBefore ? 'replaced' : 'imported';
        const msg = existedBefore
          ? backupRecord
            ? `Replaced "${safeName}" (previous version backed up).`
            : `Replaced "${safeName}".`
          : `Imported "${safeName}" into ${path.basename(targetDir)}.`;

        this.recordOperation({
          action: 'import',
          status: 'success',
          title: existedBefore ? `Replaced ${safeName}` : `Imported ${safeName}`,
          details: msg,
          fileName: safeName,
          appId: chosenAppId || undefined,
        });

        outcomes.push({
          fileName: safeName,
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
          title: `Failed to Import ${safeName}`,
          details: message,
          fileName: safeName,
        });
        outcomes.push({
          fileName: safeName,
          status: 'error',
          message,
          validation: val,
        });
      }
    }

    return {
      outcomes,
      state: this.getState(),
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
