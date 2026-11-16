import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildValidDepotManifestBuffer } from './validator.js';
import { parseVdf } from './vdfParser.js';

export const KNOWN_STEAM_TITLES: Record<string, string> = {
  '1091500': 'Cyberpunk 2077',
  '1245620': 'ELDEN RING',
  '2358720': 'Black Myth: Wukong',
  '1086940': "Baldur's Gate 3",
  '1174180': 'Red Dead Redemption 2',
  '292030': 'The Witcher 3: Wild Hunt',
  '367520': 'Hollow Knight',
  '1145360': 'Hades',
  '1145350': 'Hades II',
  '413150': 'Stardew Valley',
  '105600': 'Terraria',
  '553850': 'HELLDIVERS 2',
  '1623730': 'Palworld',
  '1716740': 'Starfield',
  '814380': 'Sekiro: Shadows Die Twice',
  '2050650': 'Resident Evil 4',
  '1593500': 'God of War',
  '2322010': 'God of War Ragnarök',
  '1817070': "Marvel's Spider-Man Remastered",
  '2215430': 'Ghost of Tsushima DIRECTOR’S CUT',
  '620': 'Portal 2',
  '400': 'Portal',
  '220': 'Half-Life 2',
  '730': 'Counter-Strike 2',
  '570': 'Dota 2',
};

function isValidSteamDirectory(dirPath: string): boolean {
  if (!dirPath) return false;
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return false;
    return (
      fs.existsSync(path.join(dirPath, 'steamapps')) ||
      fs.existsSync(path.join(dirPath, 'steam.exe')) ||
      fs.existsSync(path.join(dirPath, 'config'))
    );
  } catch {
    return false;
  }
}

function queryWindowsSteamRegistry(): string | null {
  if (process.platform !== 'win32') return null;

  const queries = [
    { cmd: 'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', isExe: false },
    { cmd: 'reg query "HKCU\\Software\\Valve\\Steam" /v SteamExe', isExe: true },
    { cmd: 'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath', isExe: false },
    { cmd: 'reg query "HKLM\\SOFTWARE\\Valve\\Steam" /v InstallPath', isExe: false },
  ];

  for (const q of queries) {
    try {
      const output = execSync(q.cmd, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2500,
      });
      const match = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(output);
      if (match && match[1]) {
        let normalized = path.normalize(match[1].trim());
        if (q.isExe) {
          normalized = path.dirname(normalized);
        }
        if (isValidSteamDirectory(normalized)) {
          return normalized;
        }
      }
    } catch {
      // Ignore registry miss and try next candidate
    }
  }
  return null;
}

export function isSteamProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq steam.exe" /NH', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      });
      return /steam\.exe/i.test(out);
    }
    const cmd = process.platform === 'darwin' ? 'pgrep -x steam_osx' : 'pgrep -x steam';
    execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

const STEAM_PLUGIN_DLL_CANDIDATES = [
  'xinput1_4.dll',
  'hid.dll',
  'dwmapi.dll',
  'version.dll',
  'winmm.dll',
  'user32.dll',
  'dxgi.dll',
  'SteamTools.dll',
  'stUI.dll',
  'core.dll',
];

export function detectSteamPlugins(steamRoot: string): {
  detected: boolean;
  files: string[];
} {
  const found: string[] = [];
  if (!steamRoot || !fs.existsSync(steamRoot)) {
    return { detected: false, files: [] };
  }
  for (const candidate of STEAM_PLUGIN_DLL_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(steamRoot, candidate))) {
        found.push(candidate);
      }
    } catch {
      // Ignore inaccessible files
    }
  }
  return {
    detected: found.length > 0,
    files: found,
  };
}

export function checkSteamOfflineConfig(steamRoot: string): boolean {
  try {
    const steamCfg = path.join(steamRoot, 'steam.cfg');
    if (fs.existsSync(steamCfg)) {
      const content = fs.readFileSync(steamCfg, 'utf8');
      if (/ForceOfflineMode\s*=\s*(1|true|enable)/i.test(content)) {
        return true;
      }
    }

    const loginUsersPath = path.join(steamRoot, 'config', 'loginusers.vdf');
    if (fs.existsSync(loginUsersPath)) {
      const parsed = parseVdf(fs.readFileSync(loginUsersPath, 'utf8'));
      const usersKey = Object.keys(parsed).find(
        (k) => k.toLowerCase() === 'users'
      );
      const users = usersKey ? parsed[usersKey] : undefined;
      if (users && typeof users === 'object') {
        for (const entry of Object.values(users)) {
          if (!entry || typeof entry !== 'object') continue;
          const mostRecent = Object.entries(entry).find(
            ([k]) => k.toLowerCase() === 'mostrecent'
          )?.[1];
          const wantsOffline = Object.entries(entry).find(
            ([k]) => k.toLowerCase() === 'wantsofflinemode'
          )?.[1];
          if (mostRecent === '1' && wantsOffline === '1') {
            return true;
          }
        }
      }
    }
  } catch {
    // Ignore malformed Steam config
  }
  return false;
}

export async function restartSteamClient(
  steamRoot: string,
  installAppId?: string
): Promise<boolean> {
  try {
    const steamExe =
      process.platform === 'win32'
        ? path.join(steamRoot, 'steam.exe')
        : process.platform === 'darwin'
          ? '/Applications/Steam.app/Contents/MacOS/steam_osx'
          : 'steam';

    if (process.platform === 'win32' && !fs.existsSync(steamExe)) {
      return false;
    }

    if (isSteamProcessRunning()) {
      try {
        if (process.platform === 'win32') {
          spawn(steamExe, ['-shutdown'], { detached: true, stdio: 'ignore' }).unref();
        } else {
          execSync('steam -shutdown', { stdio: 'ignore', timeout: 3000 });
        }
      } catch {
        // Ignore shutdown signal errors
      }

      // Wait up to 6s for Steam to exit cleanly
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (!isSteamProcessRunning()) break;
      }

      if (process.platform === 'win32' && isSteamProcessRunning()) {
        try {
          execSync('taskkill /F /IM steam.exe', { stdio: 'ignore', timeout: 3000 });
          await new Promise((r) => setTimeout(r, 750));
        } catch {
          // Ignore force kill error
        }
      }
    }

    const args = installAppId ? [`steam://install/${installAppId}`] : [];
    const child = spawn(steamExe, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface LocatedSteamResult {
  steamPath: string;
  isSimulated: boolean;
}

/**
 * Automatically locates the user's Steam installation directory.
 * Falls back to a pre-seeded local sandbox Steam directory only when no system Steam exists.
 */
export function locateSteamDirectory(sandboxRoot: string): LocatedSteamResult {
  // 1. Windows Registry check
  const regPath = queryWindowsSteamRegistry();
  if (regPath) {
    return { steamPath: regPath, isSimulated: false };
  }

  // 2. Standard OS installation paths
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Steam',
          'C:\\Program Files\\Steam',
          'D:\\Steam',
          'D:\\Program Files (x86)\\Steam',
          'E:\\Steam',
        ]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Steam')]
        : [
            path.join(home, '.steam', 'steam'),
            path.join(home, '.local', 'share', 'Steam'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
          ];

  for (const candidate of candidates) {
    if (isValidSteamDirectory(candidate)) {
      return { steamPath: candidate, isSimulated: false };
    }
  }

  // 3. Provision realistic sandbox Steam structure for preview / development environments
  const simulatedSteamPath = path.join(sandboxRoot, 'Steam');
  ensureSimulatedSteamSeeded(simulatedSteamPath);
  return { steamPath: simulatedSteamPath, isSimulated: true };
}

/**
 * Seeds a realistic Steam folder structure (libraryfolders.vdf, appmanifest_*.acf,
 * config/stplug-in/*.lua, depotcache/*.manifest) once when running without a real Steam install.
 */
export function ensureSimulatedSteamSeeded(steamRoot: string): void {
  const markerFile = path.join(steamRoot, '.lunex-seeded');
  if (fs.existsSync(markerFile)) return;

  const steamappsDir = path.join(steamRoot, 'steamapps');
  const commonDir = path.join(steamappsDir, 'common');
  const luaDir = path.join(steamRoot, 'config', 'stplug-in');
  const depotCacheDir = path.join(steamRoot, 'depotcache');

  fs.mkdirSync(commonDir, { recursive: true });
  fs.mkdirSync(luaDir, { recursive: true });
  fs.mkdirSync(depotCacheDir, { recursive: true });

  // Write authentic libraryfolders.vdf
  const escapedRoot = steamRoot.replace(/\\/g, '\\\\');
  const libraryFoldersVdf = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"${escapedRoot}"
\t\t"label"\t\t"Primary NVMe"
\t\t"apps"
\t\t{
\t\t\t"1091500"\t\t"76482910208"
\t\t\t"1245620"\t\t"52841920512"
\t\t\t"367520"\t\t"7912480768"
\t\t\t"1145350"\t\t"9841209344"
\t\t\t"413150"\t\t"682910208"
\t\t}
\t}
}
`;
  fs.writeFileSync(path.join(steamappsDir, 'libraryfolders.vdf'), libraryFoldersVdf, 'utf8');

  // Seed installed Steam appmanifest_*.acf files
  const sampleApps = [
    {
      appId: '1091500',
      name: 'Cyberpunk 2077',
      installdir: 'Cyberpunk 2077',
      stateFlags: '4',
      sizeOnDisk: '76482910208',
      lastUpdated: '1762400100',
    },
    {
      appId: '1245620',
      name: 'ELDEN RING',
      installdir: 'ELDEN RING',
      stateFlags: '4',
      sizeOnDisk: '52841920512',
      lastUpdated: '1762812000',
    },
    {
      appId: '367520',
      name: 'Hollow Knight',
      installdir: 'Hollow Knight',
      stateFlags: '4',
      sizeOnDisk: '7912480768',
      lastUpdated: '1761904200',
    },
    {
      appId: '1145350',
      name: 'Hades II',
      installdir: 'Hades II',
      stateFlags: '6', // Update Required
      sizeOnDisk: '9841209344',
      lastUpdated: '1763011500',
    },
    {
      appId: '413150',
      name: 'Stardew Valley',
      installdir: 'Stardew Valley',
      stateFlags: '4',
      sizeOnDisk: '682910208',
      lastUpdated: '1760502000',
    },
  ];

  for (const app of sampleApps) {
    fs.mkdirSync(path.join(commonDir, app.installdir), { recursive: true });
    const acf = `"AppState"
{
\t"appid"\t\t"${app.appId}"
\t"Universe"\t\t"1"
\t"name"\t\t"${app.name}"
\t"StateFlags"\t\t"${app.stateFlags}"
\t"installdir"\t\t"${app.installdir}"
\t"LastUpdated"\t\t"${app.lastUpdated}"
\t"SizeOnDisk"\t\t"${app.sizeOnDisk}"
}
`;
    fs.writeFileSync(
      path.join(steamappsDir, `appmanifest_${app.appId}.acf`),
      acf,
      'utf8'
    );
  }

  // Seed authentic .lua manifests in config/stplug-in
  const cyberpunkLua = `-- Lunex Managed Manifest: Cyberpunk 2077 (1091500)
addappid(1091500)
addappid(1091501, 1, "8f3c4a1290e7b451c209de78a12b49087712fa980c41e2b39d08112ac76e4501")
setManifestid(1091501, "7829401928374651092", 0)
addappid(2138330, 1, "5a9120bc78d4ef0192837465ab98cd1209ef4321ab76cd908123ef4567ab8901")
setManifestid(2138330, "4910293847561029384", 0)
`;
  fs.writeFileSync(path.join(luaDir, '1091500.lua'), cyberpunkLua, 'utf8');

  const eldenRingLua = `-- Lunex Managed Manifest: ELDEN RING (1245620)
addappid(1245620)
addappid(1245621, 1, "2c74e91a03f8d1209bc4567ea8901f23c456d7890ab12cd34ef567890ab12cd3")
setManifestid(1245621, "6192837465109283746", 0)
addappid(2778580, 1, "9e01f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f")
setManifestid(2778580, "3847561029384756102", 0)
`;
  fs.writeFileSync(path.join(luaDir, '1245620.lua'), eldenRingLua, 'utf8');

  // Also seed a Lua manifest for a game not yet installed via ACF (Black Myth: Wukong - 2358720)
  const wukongLua = `-- Lunex Managed Manifest: Black Myth: Wukong (2358720)
addappid(2358720)
addappid(2358721, 1, "4d18a920bc34ef5678901234ab56cd78ef901234ab56cd78ef901234ab56cd78")
setManifestid(2358721, "9182736450192837465", 0)
`;
  fs.writeFileSync(path.join(luaDir, '2358720.lua'), wukongLua, 'utf8');

  // Seed binary .manifest files in depotcache with valid Valve DepotManifest headers
  const sampleDepots = [
    { depotId: '1091501', manifestId: '7829401928374651092' },
    { depotId: '2138330', manifestId: '4910293847561029384' },
    { depotId: '1245621', manifestId: '6192837465109283746' },
    { depotId: '2358721', manifestId: '9182736450192837465' },
  ];

  for (const d of sampleDepots) {
    const buf = buildValidDepotManifestBuffer(d.depotId, d.manifestId);
    fs.writeFileSync(
      path.join(depotCacheDir, `${d.depotId}_${d.manifestId}.manifest`),
      buf
    );
  }

  fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
}
