import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { LunexManager } from '../electron/core/lunexManager.js';
import {
  parseSteamCmdAppInfoJson,
  parseSteamContentLogText,
} from '../electron/core/steamDiagnostics.js';
import {
  buildValidDepotManifestBuffer,
  extractManifestZipBundle,
  parseDepotManifestMetadata,
  unwrapZipManifestBuffer,
  upsertLuaManifestDirectives,
  validateManifestBuffer,
} from '../electron/core/validator.js';
import {
  clearLoginUsersOfflineMode,
  parseAppManifestAcf,
  parseLibraryFoldersVdf,
  readConfigVdfDepots,
  upsertConfigVdfDepotKeys,
} from '../electron/core/vdfParser.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-test-'));
  tempDirs.push(dir);
  return dir;
}

const VALID_HEX_KEY_1 =
  '7b19c4d2e8f0a312948576abcd12ef34567890abcdef1234567890abcdef1234';
const VALID_HEX_KEY_2 =
  '8f3c4a1290e7b451c209de78a12b49087712fa980c41e2b39d08112ac76e4501';

/** Builds a minimal valid uncompressed (method 0) ZIP archive for tests */
function buildStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
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

  it('parses appmanifest_*.acf metadata including MountedDepots and StagingSize', () => {
    const acf = `"AppState"
{
\t"appid"\t\t"1091500"
\t"name"\t\t"Cyberpunk 2077"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"Cyberpunk 2077"
\t"SizeOnDisk"\t\t"76482910208"
\t"StagingSize"\t\t"0"
\t"BytesToDownload"\t\t"0"
\t"BytesDownloaded"\t\t"0"
\t"LastUpdated"\t\t"1762400100"
\t"MountedDepots"
\t{
\t\t"1091501"\t\t"5512901928374651092"
\t}
}`;
    const parsed = parseAppManifestAcf(acf);
    expect(parsed).toMatchObject({
      appId: '1091500',
      name: 'Cyberpunk 2077',
      installDir: 'Cyberpunk 2077',
      stateFlags: 4,
      sizeOnDisk: 76482910208,
      bytesToDownload: 0,
      bytesDownloaded: 0,
      lastUpdated: 1762400100,
      mountedDepots: { '1091501': '5512901928374651092' },
    });
  });

  it('surgically patches config.vdf depot keys without mangling unrelated Steam sections', () => {
    const rawConfig = `"InstallConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"AutoUpdateWindowEnabled"\t\t"0"
\t\t\t\t"Accounts"
\t\t\t\t{
\t\t\t\t\t"myuser"
\t\t\t\t\t{
\t\t\t\t\t\t"SteamID"\t\t"76561198000000001"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\t"depots"
\t\t\t\t{
\t\t\t\t\t"999001"
\t\t\t\t\t{
\t\t\t\t\t\t"DecryptionKey"\t\t"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
    const patched = upsertConfigVdfDepotKeys(rawConfig, {
      '1086941': VALID_HEX_KEY_1,
      '999001': VALID_HEX_KEY_2,
    });
    expect(patched.addedCount).toBe(2);
    // Unrelated sections stay verbatim
    expect(patched.updatedContent).toContain('"SteamID"\t\t"76561198000000001"');
    expect(patched.updatedContent).toContain('"AutoUpdateWindowEnabled"\t\t"0"');

    const extracted = readConfigVdfDepots(patched.updatedContent);
    expect(extracted.get('1086941')).toBe(VALID_HEX_KEY_1);
    expect(extracted.get('999001')).toBe(VALID_HEX_KEY_2);
  });

  it('surgically clears offline mode flags in loginusers.vdf', () => {
    const loginUsers = `"users"
{
\t"76561198000000001"
\t{
\t\t"AccountName"\t\t"player1"
\t\t"WantsOfflineMode"\t\t"1"
\t\t"SkipOfflineModeWarning"\t\t"1"
\t\t"RememberPassword"\t\t"1"
\t}
}`;
    const res = clearLoginUsersOfflineMode(loginUsers);
    expect(res.changed).toBe(true);
    expect(res.updatedContent).toContain('"WantsOfflineMode"\t\t"0"');
    expect(res.updatedContent).toContain('"SkipOfflineModeWarning"\t\t"0"');
    expect(res.updatedContent).toContain('"RememberPassword"\t\t"1"');
  });
});

describe('Manifest & Lua Validator', () => {
  it('validates authentic .lua script, flags commented setManifestid, and validates 64-hex keys', () => {
    const lua = Buffer.from(
      `addappid(1086940)\naddappid(1086941, 1, "${VALID_HEX_KEY_1}")\nsetManifestid(1086941, "5512901928374651092", 0)\naddappid(1086942, 1, "${VALID_HEX_KEY_2}")\n--setManifestid(1086942, "1122334455667788990", 0)\n`,
      'utf8'
    );
    const res = validateManifestBuffer('1086940.lua', lua);
    expect(res.valid).toBe(true);
    expect(res.detectedAppId).toBe('1086940');
    expect(res.directives).toHaveLength(3);
    expect(res.directives?.[1]).toEqual({
      id: '1086941',
      decryptionKey: VALID_HEX_KEY_1,
      keyValid: true,
      manifestId: '5512901928374651092',
      manifestIdValid: true,
    });
    expect(res.directives?.[2]).toEqual({
      id: '1086942',
      decryptionKey: VALID_HEX_KEY_2,
      keyValid: true,
      commentedManifestId: '1122334455667788990',
    });
  });

  it('uncomments commented-out -- setManifestid() lines cleanly in upsertLuaManifestDirectives', () => {
    const lua = `addappid(1086940)
addappid(1086941, 1, "${VALID_HEX_KEY_1}")
-- setManifestid(1086941, "1111111111111111111", 0)
`;
    const res = upsertLuaManifestDirectives(lua, '1086940', [
      { depotId: '1086941', manifestId: '5512901928374651092' },
    ]);
    expect(res.changed).toBe(true);
    expect(res.updatedContent).not.toContain('-- setManifestid');
    expect(res.updatedContent).toContain(
      'setManifestid(1086941, "5512901928374651092", 0)'
    );
  });

  it('rejects malformed or HTML .lua files', () => {
    const badSyntax = Buffer.from('addappid(1086940\n', 'utf8');
    expect(validateManifestBuffer('1086940.lua', badSyntax).valid).toBe(false);

    const htmlFake = Buffer.from('<!DOCTYPE html><html>Error</html>', 'utf8');
    expect(validateManifestBuffer('1086940.lua', htmlFake).valid).toBe(false);
  });

  it('parses authentic 0x1F4812BE metadata, supports empty-payload manifests, and unwraps ZIP/GZIP manifests', () => {
    const validBuf = buildValidDepotManifestBuffer(
      '1086941',
      '5512901928374651092'
    );
    const meta = parseDepotManifestMetadata(validBuf);
    expect(meta?.depotId).toBe('1086941');
    expect(meta?.manifestId).toBe('5512901928374651092');

    const okRes = validateManifestBuffer(
      '1086941_5512901928374651092.manifest',
      validBuf
    );
    expect(okRes.valid).toBe(true);
    expect(okRes.headerDepotId).toBe('1086941');
    expect(okRes.headerManifestId).toBe('5512901928374651092');

    // Filename vs internal metadata mismatch produces warning
    const mismatchRes = validateManifestBuffer(
      '1086941_9999999999999999999.manifest',
      validBuf
    );
    expect(mismatchRes.valid).toBe(true);
    expect(mismatchRes.warnings.join(' ')).toContain('binary DepotManifest header');

    // GZIP-wrapped manifest unwraps cleanly
    const gzBuf = zlib.gzipSync(validBuf);
    const unwrappedGz = unwrapZipManifestBuffer(gzBuf);
    expect(unwrappedGz).not.toBeNull();
    expect(unwrappedGz?.format).toBe('gzip');
    expect(unwrappedGz?.unwrapped.equals(validBuf)).toBe(true);

    // ZIP-wrapped manifest unwraps cleanly
    const zipBuf = buildStoredZip([
      { name: '1086941_5512901928374651092.manifest', data: validBuf },
    ]);
    const unwrappedZip = unwrapZipManifestBuffer(zipBuf);
    expect(unwrappedZip).not.toBeNull();
    expect(unwrappedZip?.format).toBe('zip');
    expect(unwrappedZip?.unwrapped.equals(validBuf)).toBe(true);

    const extracted = extractManifestZipBundle(zipBuf);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].fileName).toBe('1086941_5512901928374651092.manifest');

    const corrupted = Buffer.alloc(32, 0xff);
    const badRes = validateManifestBuffer(
      '1086941_5512901928374651092.manifest',
      corrupted
    );
    expect(badRes.valid).toBe(false);
    expect(badRes.errors[0]).toContain('Invalid binary header');
  });
});

describe('Steam Log & Live SteamCMD Parsers', () => {
  it('parses real Steam logs/content_log.txt "No connection" & Access Denied entries', () => {
    const sampleLog = `[2026-11-15 18:10:02] AppID 1091500 update started : download 0/0, staging 0/0
[2026-11-15 18:10:03] CDepotDownloadMgr::BYldRequestDepotManifest(App: 1091500, Depot: 1091501, Manifest: 7777777777777777777, Branch: ): Failed to get manifest request code, 'Access Denied'
[2026-11-15 18:10:03] AppID 1091500 update canceled : Failed downloading 1 manifests (No connection) (Failed to get manifest request code)
[2026-11-15 18:10:04] Failed to request decryption key for depot 1091502: Access Denied
`;
    const diag = parseSteamContentLogText(sampleLog, '1091500');
    expect(diag.failedManifests).toHaveLength(1);
    expect(diag.failedManifests[0]).toMatchObject({
      depotId: '1091501',
      manifestId: '7777777777777777777',
    });
    expect(diag.missingKeyDepots).toContain('1091502');
    expect(diag.recentLines.join('\n')).toContain('No connection');
  });

  it('parses live SteamCMD api.steamcmd.net JSON including DLCs and public depot manifests', () => {
    const rawApiJson = {
      status: 'success',
      data: {
        '1091500': {
          common: { name: 'Cyberpunk 2077' },
          extended: { listofdlc: '2138330,1495710' },
          depots: {
            '1091501': {
              config: { oslist: 'windows' },
              manifests: {
                public: {
                  gid: '7777777777777777777',
                  size: '68000000000',
                  download: '60000000000',
                },
              },
            },
            '228988': {
              depotfromapp: '228980',
              sharedinstall: '1',
            },
            branches: {
              public: { buildid: '21417488' },
            },
          },
        },
      },
    };
    const info = parseSteamCmdAppInfoJson('1091500', rawApiJson);
    expect(info.name).toBe('Cyberpunk 2077');
    expect(info.buildId).toBe('21417488');
    expect(info.dlcAppIds).toEqual(['2138330', '1495710']);
    expect(info.depots).toHaveLength(2);
    expect(info.depots.find((d) => d.depotId === '1091501')?.publicManifestId).toBe(
      '7777777777777777777'
    );
    expect(info.depots.find((d) => d.depotId === '228988')?.isShared).toBe(
      true
    );
  });
});

describe('LunexManager End-to-End & Steam "No Internet Connection" Diagnostics/Repairs', () => {
  it('manages manual games, imports, duplicate detection, backups, restore, and custom paths', () => {
    const dataDir = makeTempDir();
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

    let state = manager.updateSettings({
      steamPath: customSteam,
      launchWithWindows: true,
    });
    expect(startupToggledTo).toBe(true);
    expect(state.games.some((g) => g.appId === '620' && g.name === 'Portal 2')).toBe(
      true
    );

    state = manager.addManualGame('1086940');
    expect(
      state.games.some(
        (g) => g.appId === '1086940' && g.name === "Baldur's Gate 3" && g.isManual
      )
    ).toBe(true);

    const v1Lua = Buffer.from(
      `addappid(1086940)\naddappid(1086941, 1, "${VALID_HEX_KEY_1}")\n`,
      'utf8'
    );
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
    // Importing a .manifest automatically mirrors it to Steam/config/depotcache
    expect(
      fs.existsSync(
        path.join(customSteam, 'config', 'depotcache', '1086941_999888777.manifest')
      )
    ).toBe(true);
    // And auto-pins setManifestid in 1086940.lua!
    const luaAfterImport = fs.readFileSync(
      path.join(customSteam, 'config', 'stplug-in', '1086940.lua'),
      'utf8'
    );
    expect(luaAfterImport).toContain('setManifestid(1086941, "999888777", 0)');

    // Importing identical content again skips duplicate
    const dupImport = manager.importFiles([
      {
        fileName: '1086940.lua',
        base64Content: Buffer.from(luaAfterImport, 'utf8').toString('base64'),
      },
    ]);
    expect(dupImport.outcomes[0].status).toBe('duplicate_skipped');

    // Importing updated 1086940.lua backs up previous file before replacing
    const v2Lua = Buffer.from(
      `addappid(1086940)\naddappid(1086941, 1, "${VALID_HEX_KEY_2}")\nsetManifestid(1086941, "999888777", 0)\n`,
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
    expect(replaceImport.state.backups.length).toBeGreaterThanOrEqual(1);

    const replaceBackup = replaceImport.state.backups.find(
      (b) => b.reason === 'replace'
    )!;
    expect(replaceBackup).toBeTruthy();
    const restoredState = manager.restoreBackup(replaceBackup.id);
    const inspected = manager.inspectManifest(
      restoredState.manifests.find((m) => m.fileName === '1086940.lua')!.filePath
    );
    expect(inspected.textContent).toContain(VALID_HEX_KEY_1);

    const badImport = manager.importFiles([
      {
        fileName: 'broken.manifest',
        base64Content: Buffer.from('not-a-manifest', 'utf8').toString('base64'),
      },
    ]);
    expect(badImport.outcomes[0].status).toBe('invalid_rejected');
    expect(badImport.state.operations[0].status).toBe('error');
  });

  it('diagnoses and fully repairs broken Steam installs (compressed manifest, commented pin, missing config.vdf key, missing config/depotcache mirror, offline mode, stuck ACF, .st conflict)', async () => {
    const dataDir = makeTempDir();
    const customSteam = path.join(dataDir, 'FakeSteam');
    fs.mkdirSync(path.join(customSteam, 'config', 'stplug-in'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(customSteam, 'depotcache'), { recursive: true });
    fs.mkdirSync(path.join(customSteam, 'steamapps', 'downloading', '1091500'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(customSteam, 'appcache', 'httpcache', 'a0'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(customSteam, 'logs'), { recursive: true });

    // Create a plugin indicator so no missing_steam_plugin warning blocks ready state
    fs.writeFileSync(path.join(customSteam, 'HID.dll'), Buffer.from('MZ'));

    // Write valid config.vdf without 1091501 key
    fs.writeFileSync(
      path.join(customSteam, 'config', 'config.vdf'),
      `"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"depots"\n\t\t\t\t{\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`,
      'utf8'
    );
    // Write offline-mode loginusers.vdf + steam.cfg
    fs.writeFileSync(
      path.join(customSteam, 'config', 'loginusers.vdf'),
      `"users"\n{\n\t"76561198000000001"\n\t{\n\t\t"WantsOfflineMode"\t\t"1"\n\t}\n}`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(customSteam, 'steam.cfg'),
      'BootStrapperInhibitAll=enable\nForceOfflineMode=enable\n',
      'utf8'
    );

    // Stuck non-zero-byte appmanifest_1091500.acf (StateFlags 1026 = update required / interrupted)
    fs.writeFileSync(
      path.join(customSteam, 'steamapps', 'appmanifest_1091500.acf'),
      `"AppState"\n{\n\t"appid"\t\t"1091500"\n\t"name"\t\t"Cyberpunk 2077"\n\t"StateFlags"\t\t"1026"\n\t"SizeOnDisk"\t\t"0"\n\t"StagingSize"\t\t"12345"\n}`,
      'utf8'
    );
    // Stuck state patch & httpcache files
    fs.writeFileSync(
      path.join(
        customSteam,
        'steamapps',
        'downloading',
        'state_1091500_1091501.patch'
      ),
      Buffer.from('stale')
    );
    fs.writeFileSync(
      path.join(customSteam, 'appcache', 'httpcache', 'a0', 'cache.bin'),
      Buffer.from('stale-http')
    );

    // Conflicting 1091500.st file in stplug-in
    fs.writeFileSync(
      path.join(customSteam, 'config', 'stplug-in', '1091500.st'),
      Buffer.from('old-st')
    );

    // .lua with commented-out setManifestid + a DLC addappid(2138330) without key (should NOT be flagged as missing key!)
    fs.writeFileSync(
      path.join(customSteam, 'config', 'stplug-in', '1091500.lua'),
      `addappid(1091500)\naddappid(1091501, 1, "${VALID_HEX_KEY_1}")\n-- setManifestid(1091501, "5512901928374651092", 0)\naddappid(2138330)\n`,
      'utf8'
    );

    // Write a ZIP-wrapped .manifest with WRONG filename GID vs internal metadata
    const rawManifest = buildValidDepotManifestBuffer(
      '1091501',
      '5512901928374651092'
    );
    const wrappedManifest = buildStoredZip([
      { name: '1091501_5512901928374651092.manifest', data: rawManifest },
    ]);
    fs.writeFileSync(
      path.join(customSteam, 'depotcache', '1091501_1111111111111111111.manifest'),
      wrappedManifest
    );

    const manager = new LunexManager({ dataDir });
    const beforeState = manager.updateSettings({ steamPath: customSteam });
    const gameBefore = beforeState.games.find((g) => g.appId === '1091500')!;
    const codesBefore = gameBefore.installDiagnostics!.issues.map((i) => i.code);

    expect(gameBefore.installDiagnostics?.status).toBe('blocked');
    expect(codesBefore).toContain('zip_wrapped_manifest');
    expect(codesBefore).toContain('commented_set_manifest_id');
    expect(codesBefore).toContain('config_vdf_keys_missing');
    expect(codesBefore).toContain('steam_offline_mode');
    expect(codesBefore).toContain('stuck_download_queue');
    expect(codesBefore).toContain('conflicting_st_plugin');
    // DLC addappid(2138330) must NOT be falsely flagged as missing decryption key!
    expect(codesBefore).not.toContain('missing_decryption_key');

    // Run repair (without restarting Steam in unit test)
    const repair = await manager.repairGameInstall('1091500', {
      restartSteam: false,
      clearDownloadCache: true,
    });

    expect(repair.fixedCount).toBeGreaterThanOrEqual(5);
    expect(repair.configVdfSyncedCount).toBe(1);
    expect(repair.downloadCacheCleared).toBe(true);

    // Verify every single fix took effect on disk
    // 1. Unwrapped & renamed to match internal metadata GID
    const expectedRawPath = path.join(
      customSteam,
      'depotcache',
      '1091501_5512901928374651092.manifest'
    );
    expect(fs.existsSync(expectedRawPath)).toBe(true);
    expect(fs.readFileSync(expectedRawPath).readUInt32LE(0)).toBe(0x71f617d0);
    // 2. Mirrored into config/depotcache
    expect(
      fs.existsSync(
        path.join(
          customSteam,
          'config',
          'depotcache',
          '1091501_5512901928374651092.manifest'
        )
      )
    ).toBe(true);
    // 3. Uncommented setManifestid in .lua
    const repairedLua = fs.readFileSync(
      path.join(customSteam, 'config', 'stplug-in', '1091500.lua'),
      'utf8'
    );
    expect(repairedLua).not.toContain('-- setManifestid');
    expect(repairedLua).toContain(
      'setManifestid(1091501, "5512901928374651092", 0)'
    );
    // 4. Synced key into config.vdf + backed up config.vdf in managed backups
    const configKeys = readConfigVdfDepots(
      fs.readFileSync(path.join(customSteam, 'config', 'config.vdf'), 'utf8')
    );
    expect(configKeys.get('1091501')).toBe(VALID_HEX_KEY_1);
    expect(
      repair.state.backups.some((b) => b.originalFileName === 'config.vdf')
    ).toBe(true);
    // 5. Cleared offline mode
    expect(
      fs.readFileSync(
        path.join(customSteam, 'config', 'loginusers.vdf'),
        'utf8'
      )
    ).toContain('"WantsOfflineMode"\t\t"0"');
    expect(
      fs.readFileSync(path.join(customSteam, 'steam.cfg'), 'utf8')
    ).toContain('ForceOfflineMode=disable');
    // 6. Removed stuck ACF, downloading/, state_*.patch, httpcache, and conflicting .st
    expect(
      fs.existsSync(
        path.join(customSteam, 'steamapps', 'appmanifest_1091500.acf')
      )
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          customSteam,
          'steamapps',
          'downloading',
          'state_1091500_1091501.patch'
        )
      )
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(customSteam, 'appcache', 'httpcache', 'a0', 'cache.bin')
      )
    ).toBe(false);
    expect(
      fs.existsSync(path.join(customSteam, 'config', 'stplug-in', '1091500.st'))
    ).toBe(false);

    // Re-evaluate diagnostics — game should now be 100% READY!
    const gameAfter = repair.state.games.find((g) => g.appId === '1091500')!;
    expect(gameAfter.installDiagnostics?.status).toBe('ready');

    // Simulate Steam auto-deleting the manifest from Steam/depotcache/ and verify auto-restore!
    fs.unlinkSync(expectedRawPath);
    const afterDeletion = manager.rescan();
    const deletedGame = afterDeletion.games.find((g) => g.appId === '1091500')!;
    expect(
      deletedGame.installDiagnostics?.issues.some(
        (i) => i.code === 'depotcache_desync' && i.autoFixable
      )
    ).toBe(true);

    const restoreRepair = await manager.repairGameInstall('1091500', {
      restartSteam: false,
      clearDownloadCache: false,
    });
    expect(fs.existsSync(expectedRawPath)).toBe(true);
    expect(
      restoreRepair.state.games.find((g) => g.appId === '1091500')
        ?.installDiagnostics?.status
    ).toBe('ready');
  });
});
