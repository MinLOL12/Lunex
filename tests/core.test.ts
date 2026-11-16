import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { LunexManager } from '../electron/core/lunexManager.js';
import {
  buildValidDepotManifestBuffer,
  extractManifestZipBundle,
  STEAM_MANIFEST_MAGIC,
  validateManifestBuffer,
} from '../electron/core/validator.js';
import {
  parseAppManifestAcf,
  parseLibraryFoldersVdf,
  readConfigVdfDepots,
} from '../electron/core/vdfParser.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Valve VDF & ACF Parser', () => {
  it('parses Windows libraryfolders.vdf paths accurately', () => {
    const sample = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"apps"
\t\t{
\t\t\t"1091500"\t\t"76482910208"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t}
}`;
    const folders = parseLibraryFoldersVdf(sample);
    expect(folders).toEqual([
      'C:\\Program Files (x86)\\Steam',
      'D:\\SteamLibrary',
    ]);
  });

  it('parses appmanifest_*.acf metadata', () => {
    const acf = `"AppState"
{
\t"appid"\t\t"1091500"
\t"name"\t\t"Cyberpunk 2077"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"Cyberpunk 2077"
\t"SizeOnDisk"\t\t"76482910208"
\t"LastUpdated"\t\t"1762400100"
}`;
    const parsed = parseAppManifestAcf(acf);
    expect(parsed).toEqual({
      appId: '1091500',
      name: 'Cyberpunk 2077',
      installDir: 'Cyberpunk 2077',
      stateFlags: 4,
      sizeOnDisk: 76482910208,
      lastUpdated: 1762400100,
    });
  });
});

describe('Manifest & Lua Validator', () => {
  it('validates authentic .lua script and extracts addappid & setManifestid directives', () => {
    const lua = Buffer.from(
      `addappid(1086940)\naddappid(1086941, 1, "abcdef0123456789")\nsetManifestid(1086941, "5512901928374651092", 0)\n`,
      'utf8'
    );
    const res = validateManifestBuffer('1086940.lua', lua);
    expect(res.valid).toBe(true);
    expect(res.detectedAppId).toBe('1086940');
    expect(res.directives).toHaveLength(2);
    expect(res.directives?.[1]).toEqual({
      id: '1086941',
      decryptionKey: 'abcdef0123456789',
      manifestId: '5512901928374651092',
    });
  });

  it('rejects malformed or HTML .lua files', () => {
    const badSyntax = Buffer.from('addappid(1086940\n', 'utf8');
    expect(validateManifestBuffer('1086940.lua', badSyntax).valid).toBe(false);

    const htmlFake = Buffer.from('<!DOCTYPE html><html>Error</html>', 'utf8');
    expect(validateManifestBuffer('1086940.lua', htmlFake).valid).toBe(false);
  });

  it('validates binary Steam DepotManifest header and rejects corrupted binary', () => {
    const validBuf = buildValidDepotManifestBuffer('1086941', '5512901928374651092');
    const okRes = validateManifestBuffer(
      '1086941_5512901928374651092.manifest',
      validBuf
    );
    expect(okRes.valid).toBe(true);
    expect(okRes.detectedDepotId).toBe('1086941');
    expect(okRes.detectedManifestId).toBe('5512901928374651092');

    const corrupted = Buffer.alloc(32, 0xff);
    const badRes = validateManifestBuffer(
      '1086941_5512901928374651092.manifest',
      corrupted
    );
    expect(badRes.valid).toBe(false);
    expect(badRes.errors[0]).toContain('Invalid binary header');
  });
});

describe('LunexManager End-to-End Workflows', () => {
  it('manages manual games, imports, duplicate detection, backups, restore, and custom paths', () => {
    const dataDir = makeTempDir();
    // Create a clean custom Steam structure inside temp dir so tests never depend on host Steam
    const customSteam = path.join(dataDir, 'CustomSteam');
    fs.mkdirSync(path.join(customSteam, 'steamapps'), { recursive: true });
    fs.writeFileSync(
      path.join(customSteam, 'steamapps', 'appmanifest_620.acf'),
      `"AppState"\n{\n\t"appid" "620"\n\t"name" "Portal 2"\n\t"StateFlags" "4"\n\t"installdir" "Portal 2"\n}`,
      'utf8'
    );

    let startupToggledTo: boolean | null = null;
    const manager = new LunexManager({
      dataDir,
      onLaunchWithWindowsChange: (enabled) => {
        startupToggledTo = enabled;
      },
    });

    // Configure custom Steam path + Launch with Windows
    let state = manager.updateSettings({
      steamPath: customSteam,
      launchWithWindows: true,
    });
    expect(startupToggledTo).toBe(true);
    expect(state.games.some((g) => g.appId === '620' && g.name === 'Portal 2')).toBe(
      true
    );

    // Manually add game by AppID
    state = manager.addManualGame('1086940');
    expect(
      state.games.some(
        (g) => g.appId === '1086940' && g.name === "Baldur's Gate 3" && g.isManual
      )
    ).toBe(true);

    // Import valid .lua + .manifest
    const v1Lua = Buffer.from('addappid(1086940)\naddappid(1086941, 1, "aa11")\n', 'utf8');
    const depotBuf = buildValidDepotManifestBuffer('1086941', '999888777');

    const import1 = manager.importFiles([
      {
        fileName: '1086940.lua',
        base64Content: v1Lua.toString('base64'),
        targetAppId: '1086940',
      },
      {
        fileName: '1086941_999888777.manifest',
        base64Content: depotBuf.toString('base64'),
        targetAppId: '1086940',
      },
    ]);

    expect(import1.outcomes.map((o) => o.status)).toEqual([
      'imported',
      'imported',
    ]);
    expect(import1.state.manifests).toHaveLength(2);

    // Importing identical content again skips duplicate
    const dupImport = manager.importFiles([
      {
        fileName: '1086940.lua',
        base64Content: v1Lua.toString('base64'),
      },
    ]);
    expect(dupImport.outcomes[0].status).toBe('duplicate_skipped');

    // Importing updated 1086940.lua backs up previous file before replacing
    const v2Lua = Buffer.from(
      'addappid(1086940)\naddappid(1086941, 1, "bb22_updated")\n',
      'utf8'
    );
    const replaceImport = manager.importFiles([
      {
        fileName: '1086940.lua',
        base64Content: v2Lua.toString('base64'),
      },
    ]);
    expect(replaceImport.outcomes[0].status).toBe('replaced');
    expect(replaceImport.outcomes[0].backedUpTo).toBeTruthy();
    expect(replaceImport.state.backups).toHaveLength(1);

    // Restore backup reverts 1086940.lua back to v1 content
    const backupId = replaceImport.state.backups[0].id;
    const restoredState = manager.restoreBackup(backupId);
    const inspected = manager.inspectManifest(
      restoredState.manifests.find((m) => m.fileName === '1086940.lua')!.filePath
    );
    expect(inspected.textContent).toContain('aa11');

    // Reject invalid file and log error operation
    const badImport = manager.importFiles([
      {
        fileName: 'broken.manifest',
        base64Content: Buffer.from('not-a-manifest', 'utf8').toString('base64'),
      },
    ]);
    expect(badImport.outcomes[0].status).toBe('invalid_rejected');
    expect(badImport.state.operations[0].status).toBe('error');
  });
});

function buildTestZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const compressed = entry.deflate
      ? zlib.deflateRawSync(entry.data)
      : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(nameBuf.byteLength, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(nameBuf.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.byteLength + nameBuf.byteLength + compressed.byteLength;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe('Steam Install Diagnostics, ZIP Unwrapping, and Auto-Repair', () => {
  it('unwraps ZIP-wrapped .manifest files on import and rejects bogus ZIPs', () => {
    const dataDir = makeTempDir();
    const customSteam = path.join(dataDir, 'Steam');
    fs.mkdirSync(path.join(customSteam, 'steamapps'), { recursive: true });

    const manager = new LunexManager({ dataDir });
    manager.updateSettings({ steamPath: customSteam });

    const rawManifest = buildValidDepotManifestBuffer('1086941', '5512901928374651092');
    const zipWrappedManifest = buildTestZip([
      { name: 'z', data: rawManifest, deflate: true },
    ]);

    const val = validateManifestBuffer(
      '1086941_5512901928374651092.manifest',
      zipWrappedManifest
    );
    expect(val.valid).toBe(true);
    expect(val.isZipWrapped).toBe(true);

    // Reject a ZIP that does not contain a valid 0x71F617D0 DepotManifest
    const bogusZip = buildTestZip([
      { name: 'z', data: Buffer.from('not-a-manifest', 'utf8'), deflate: true },
    ]);
    expect(
      validateManifestBuffer('1086941_5512901928374651092.manifest', bogusZip).valid
    ).toBe(false);

    // Import ZIP-wrapped manifest -> written bytes on disk must be raw 0x71F617D0
    const res = manager.importFiles([
      {
        fileName: '1086941_5512901928374651092.manifest',
        base64Content: zipWrappedManifest.toString('base64'),
        targetAppId: '1086940',
      },
    ]);
    expect(res.outcomes[0].status).toBe('imported');
    const diskPath = path.join(
      customSteam,
      'depotcache',
      '1086941_5512901928374651092.manifest'
    );
    const written = fs.readFileSync(diskPath);
    expect(written.readUInt32LE(0)).toBe(STEAM_MANIFEST_MAGIC);
  });

  it('auto-syncs setManifestid in .lua when importing an updated .manifest', () => {
    const dataDir = makeTempDir();
    const customSteam = path.join(dataDir, 'Steam');
    fs.mkdirSync(path.join(customSteam, 'steamapps'), { recursive: true });

    const manager = new LunexManager({ dataDir });
    manager.updateSettings({ steamPath: customSteam });

    const luaWithoutPin = Buffer.from(
      `addappid(1086940)\naddappid(1086941, 1, "7b19c4d2e8f0a312948576abcd12ef34567890abcdef1234567890abcdef1234")\n`,
      'utf8'
    );
    manager.importFiles([
      {
        fileName: '1086940.lua',
        base64Content: luaWithoutPin.toString('base64'),
      },
    ]);

    const manifestBuf = buildValidDepotManifestBuffer('1086941', '5512901928374651092');
    const afterManifest = manager.importFiles(
      [
        {
          fileName: '1086941_5512901928374651092.manifest',
          base64Content: manifestBuf.toString('base64'),
        },
      ],
      { syncLuaDirectives: true }
    );

    const luaText = fs.readFileSync(
      path.join(customSteam, 'config', 'stplug-in', '1086940.lua'),
      'utf8'
    );
    expect(luaText).toContain('setManifestid(1086941, "5512901928374651092", 0)');
    const bg3 = afterManifest.state.games.find((g) => g.appId === '1086940');
    expect(bg3?.installDiagnostics?.status).toBe('ready');
  });

  it('diagnoses and repairs pre-existing broken manifests, stuck download queue, and config.vdf keys', async () => {
    const dataDir = makeTempDir();
    const customSteam = path.join(dataDir, 'Steam');
    const steamapps = path.join(customSteam, 'steamapps');
    const luaDir = path.join(customSteam, 'config', 'stplug-in');
    const depotDir = path.join(customSteam, 'depotcache');
    fs.mkdirSync(path.join(steamapps, 'downloading', '1086940'), {
      recursive: true,
    });
    fs.mkdirSync(luaDir, { recursive: true });
    fs.mkdirSync(depotDir, { recursive: true });

    // Create minimal config.vdf
    fs.writeFileSync(
      path.join(customSteam, 'config', 'config.vdf'),
      `"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t}\n\t\t}\n\t}\n}\n`,
      'utf8'
    );

    // Stuck 0-byte ACF in queued state (StateFlags 1026)
    fs.writeFileSync(
      path.join(steamapps, 'appmanifest_1086940.acf'),
      `"AppState"\n{\n\t"appid"\t\t"1086940"\n\t"name"\t\t"Baldur's Gate 3"\n\t"StateFlags"\t\t"1026"\n\t"SizeOnDisk"\t\t"0"\n}\n`,
      'utf8'
    );

    // .lua missing setManifestid() or pinning stale manifest ID
    fs.writeFileSync(
      path.join(luaDir, '1086940.lua'),
      `addappid(1086940)\naddappid(1086941, 1, "7b19c4d2e8f0a312948576abcd12ef34567890abcdef1234567890abcdef1234")\nsetManifestid(1086941, "1111111111111111111", 0)\n`,
      'utf8'
    );

    // ZIP-wrapped .manifest already sitting in depotcache
    const rawManifest = buildValidDepotManifestBuffer('1086941', '5512901928374651092');
    const zipWrapped = buildTestZip([{ name: 'z', data: rawManifest, deflate: true }]);
    fs.writeFileSync(
      path.join(depotDir, '1086941_5512901928374651092.manifest'),
      zipWrapped
    );

    const manager = new LunexManager({ dataDir });
    const initialState = manager.updateSettings({ steamPath: customSteam });
    const blockedGame = initialState.games.find((g) => g.appId === '1086940');

    expect(blockedGame?.installDiagnostics?.status).toBe('blocked');
    const codes = blockedGame?.installDiagnostics?.issues.map((i) => i.code);
    expect(codes).toContain('zip_wrapped_manifest');
    expect(codes).toContain('manifest_id_mismatch');
    expect(codes).toContain('stuck_download_queue');

    // Run one-click repair
    const repair = await manager.repairGameInstall('1086940');
    expect(repair.fixedCount).toBeGreaterThanOrEqual(4);
    expect(repair.remainingIssues).toEqual([]);

    const repairedGame = repair.state.games.find((g) => g.appId === '1086940');
    expect(repairedGame?.installDiagnostics?.status).toBe('ready');

    // Verify disk repairs
    const diskManifest = fs.readFileSync(
      path.join(depotDir, '1086941_5512901928374651092.manifest')
    );
    expect(diskManifest.readUInt32LE(0)).toBe(STEAM_MANIFEST_MAGIC);
    expect(fs.existsSync(path.join(steamapps, 'downloading', '1086940'))).toBe(false);
    expect(fs.existsSync(path.join(steamapps, 'appmanifest_1086940.acf'))).toBe(false);

    const configDepots = readConfigVdfDepots(
      fs.readFileSync(path.join(customSteam, 'config', 'config.vdf'), 'utf8')
    );
    expect(configDepots.get('1086941')).toBe(
      '7b19c4d2e8f0a312948576abcd12ef34567890abcdef1234567890abcdef1234'
    );
  });

  it('extracts .lua and .manifest files from a .zip bundle', () => {
    const rawManifest = buildValidDepotManifestBuffer('1086941', '5512901928374651092');
    const bundle = buildTestZip([
      {
        name: 'bundle/1086940.lua',
        data: Buffer.from('addappid(1086940)\n', 'utf8'),
        deflate: true,
      },
      {
        name: 'bundle/1086941_5512901928374651092.manifest',
        data: rawManifest,
        deflate: true,
      },
      { name: '__MACOSX/._1086940.lua', data: Buffer.from('ignore', 'utf8') },
    ]);

    const extracted = extractManifestZipBundle(bundle);
    expect(extracted.map((e) => e.fileName)).toEqual([
      '1086940.lua',
      '1086941_5512901928374651092.manifest',
    ]);
  });
});
