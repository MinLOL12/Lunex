import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LunexManager } from '../electron/core/lunexManager.js';
import {
  buildValidDepotManifestBuffer,
  validateManifestBuffer,
} from '../electron/core/validator.js';
import {
  parseAppManifestAcf,
  parseLibraryFoldersVdf,
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
