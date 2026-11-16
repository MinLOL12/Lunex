import fs from 'node:fs';
import path from 'node:path';
import type {
  LiveSteamAppInfo,
  LiveSteamDepotInfo,
  SteamLogDiagnostic,
  SteamLogManifestError,
} from './types.js';

const MAX_LOG_TAIL_BYTES = 512 * 1024;

function readFileTailUtf8(filePath: string, maxBytes = MAX_LOG_TAIL_BYTES): string {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return '';
  const bytesToRead = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, start);
    let text = buf.toString('utf8');
    // Drop potentially partial first line when reading from mid-file
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pure parser for Steam's `logs/content_log.txt` tailored to a specific AppID.
 * Extracts the exact Depot + Manifest GID pairs that triggered "No Connection" /
 * "Access Denied" / "Missing decryption key" / "Failed to load manifest" errors.
 */
export function parseSteamContentLogText(
  content: string,
  targetAppId: string,
  knownDepotIds: Set<string> = new Set(),
  logPath?: string
): SteamLogDiagnostic {
  const lines = content.split(/\r?\n/);
  const failedMap = new Map<string, SteamLogManifestError>();
  const missingKeyDepots = new Set<string>();
  const corruptManifestFiles = new Set<string>();
  const recentLines: string[] = [];
  let lastErrorTimestamp: string | undefined;
  let lastErrorSummary: string | undefined;

  // Track which AppID is currently being updated in Steam's sequential log stream
  let currentActiveAppId: string | null = null;

  const tsRegex = /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]\s*(.*)$/;
  const appIdContextRegex = /\bAppID\s+(\d+)\b|\[AppID\s+(\d+)\]/i;
  const fullyInstalledRegex = new RegExp(
    `\\bAppID\\s+${targetAppId}\\b.*Fully Installed`,
    'i'
  );

  // Specific Steam manifest/key/disk failure patterns
  const byldReqRegex =
    /BYldRequestDepotManifest\s*\(\s*App:\s*(\d+)\s*,\s*Depot:\s*(\d+)\s*,\s*Manifest:\s*(\d+)[^)]*\)\s*:\s*(.+)$/i;
  const failedReqCodeRegex =
    /Failed to get manifest request code(?: for)?\s+depot\s+(\d+)\s+manifest\s+(\d+)\s*(?:\(([^)]+)\)|,\s*'?([^']+)'?)?/i;
  const downloadDepotFailedRegex =
    /Download depot\s+(\d+)\s+manifest\s+(\d+)\s+failed\s*:\s*(.+)$/i;
  const failedDownloadManifestRegex =
    /AppID\s+(\d+)\s+update canceled\s*:\s*Failed to download manifest\s+(\d+)\s+for depot\s+(\d+)\s*(?:\(([^)]+)\))?/i;
  const failedInitDepotRegex =
    /Failed to initialize depot\s+(\d+)\s*,\s*manifest\s+(\d+)\s*(.+)$/i;
  const missingKeyDepotRegex =
    /(?:Missing decryption key for depot|Failed to request decryption key for depot)\s+(\d+)/i;
  const corruptDiskManifestRegex =
    /(?:Failed to load manifest from disk|Failed to parse manifest|Invalid manifest)[^:\r\n]*:?\s*([^\r\n]+)?/i;
  const appCanceledRegex = new RegExp(
    `(?:\\bAppID\\s+${targetAppId}\\b|\\[AppID\\s+${targetAppId}\\])\\s+(?:update canceled|state changed)\\s*:\\s*(.+)$`,
    'i'
  );

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const tsMatch = tsRegex.exec(trimmed);
    const timestamp = tsMatch ? tsMatch[1] : undefined;
    const body = tsMatch ? tsMatch[2] : trimmed;

    const ctxMatch = appIdContextRegex.exec(body);
    if (ctxMatch) {
      currentActiveAppId = ctxMatch[1] ?? ctxMatch[2];
    }

    // If this app later reached Fully Installed with no error, clear earlier stale failures
    if (
      fullyInstalledRegex.test(body) &&
      !/No Connection|Access Denied|Missing decryption key|Failed|Error|Corrupt/i.test(
        body
      )
    ) {
      failedMap.clear();
      missingKeyDepots.clear();
      corruptManifestFiles.clear();
      lastErrorSummary = undefined;
      lastErrorTimestamp = undefined;
      continue;
    }

    let matchedForApp = false;

    // 1. BYldRequestDepotManifest(App: X, Depot: Y, Manifest: Z, ...): Failed...
    const byld = byldReqRegex.exec(body);
    if (byld) {
      const [, app, depotId, manifestId, reason] = byld;
      if (app === targetAppId || knownDepotIds.has(depotId)) {
        matchedForApp = true;
        failedMap.set(`${depotId}_${manifestId}`, {
          depotId,
          manifestId,
          reason: reason.trim(),
          timestamp,
        });
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Depot ${depotId} manifest ${manifestId}: ${reason.trim()}`;
      }
    }

    // 2. AppID X update canceled : Failed to download manifest Z for depot Y (No Connection)
    const fdm = failedDownloadManifestRegex.exec(body);
    if (fdm) {
      const [, app, manifestId, depotId, reason] = fdm;
      if (app === targetAppId || knownDepotIds.has(depotId)) {
        matchedForApp = true;
        const cleanReason = (reason ?? 'Failed to download manifest').trim();
        failedMap.set(`${depotId}_${manifestId}`, {
          depotId,
          manifestId,
          reason: cleanReason,
          timestamp,
        });
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Failed to download manifest ${manifestId} for depot ${depotId} (${cleanReason})`;
      }
    }

    // 3. Failed to get manifest request code for depot Y manifest Z
    const frc = failedReqCodeRegex.exec(body);
    if (frc) {
      const [, depotId, manifestId, r1, r2] = frc;
      if (currentActiveAppId === targetAppId || knownDepotIds.has(depotId)) {
        matchedForApp = true;
        const cleanReason = (r1 ?? r2 ?? 'Access Denied').trim();
        failedMap.set(`${depotId}_${manifestId}`, {
          depotId,
          manifestId,
          reason: `Failed to get manifest request code (${cleanReason})`,
          timestamp,
        });
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Depot ${depotId} manifest ${manifestId}: ${cleanReason}`;
      }
    }

    // 4. Download depot Y manifest Z failed: No Connection
    const ddf = downloadDepotFailedRegex.exec(body);
    if (ddf) {
      const [, depotId, manifestId, reason] = ddf;
      if (currentActiveAppId === targetAppId || knownDepotIds.has(depotId)) {
        matchedForApp = true;
        failedMap.set(`${depotId}_${manifestId}`, {
          depotId,
          manifestId,
          reason: reason.trim(),
          timestamp,
        });
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Download depot ${depotId} manifest ${manifestId} failed: ${reason.trim()}`;
      }
    }

    // 5. Failed to initialize depot Y, manifest Z (Missing decryption key / ...)
    const fid = failedInitDepotRegex.exec(body);
    if (fid) {
      const [, depotId, manifestId, rest] = fid;
      if (currentActiveAppId === targetAppId || knownDepotIds.has(depotId)) {
        matchedForApp = true;
        if (/decryption key/i.test(rest)) {
          missingKeyDepots.add(depotId);
        } else {
          failedMap.set(`${depotId}_${manifestId}`, {
            depotId,
            manifestId,
            reason: rest.trim(),
            timestamp,
          });
        }
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Depot ${depotId} manifest ${manifestId}: ${rest.trim()}`;
      }
    }

    // 6. Missing decryption key for depot Y
    const mkd = missingKeyDepotRegex.exec(body);
    if (mkd) {
      const depotId = mkd[1];
      if (currentActiveAppId === targetAppId || knownDepotIds.has(depotId)) {
        matchedForApp = true;
        missingKeyDepots.add(depotId);
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Missing decryption key for depot ${depotId}`;
      }
    }

    // 7. Failed to load/parse manifest from disk
    const cdm = corruptDiskManifestRegex.exec(body);
    if (cdm) {
      const detail = (cdm[1] ?? body).trim();
      const mentionsKnownDepot = Array.from(knownDepotIds).some((id) =>
        detail.includes(id)
      );
      if (currentActiveAppId === targetAppId || mentionsKnownDepot) {
        matchedForApp = true;
        corruptManifestFiles.add(detail);
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        lastErrorSummary = `Failed to load local manifest: ${detail}`;
      }
    }

    // 8. Generic AppID update canceled / state changed with error parenthetical
    const ac = appCanceledRegex.exec(body);
    if (ac) {
      const detail = ac[1].trim();
      const isFailureLine =
        /update canceled/i.test(body) ||
        /\((No Connection|No Internet Connection|Content servers unreachable|Missing decryption key|Invalid app configuration|Corrupt download|Access Denied|Missing file privileges|Disk write failure)\)/i.test(
          detail
        );
      if (isFailureLine) {
        matchedForApp = true;
        lastErrorTimestamp = timestamp ?? lastErrorTimestamp;
        if (!lastErrorSummary || /update canceled/i.test(body)) {
          lastErrorSummary = detail;
        }
      }
    }

    if (matchedForApp) {
      recentLines.push(trimmed);
      if (recentLines.length > 16) {
        recentLines.shift();
      }
    }
  }

  return {
    logFound: true,
    logPath,
    lastErrorTimestamp,
    lastErrorSummary,
    failedManifests: Array.from(failedMap.values()),
    missingKeyDepots: Array.from(missingKeyDepots),
    corruptManifestFiles: Array.from(corruptManifestFiles),
    recentLines,
  };
}

/**
 * Reads Steam's `logs/content_log.txt` (with fallback to `content_log.previous.txt`)
 * to diagnose why Steam reported "No internet connection" for a given AppID.
 */
export function readSteamContentLogForApp(
  steamRoot: string,
  targetAppId: string,
  knownDepotIds: Set<string> = new Set()
): SteamLogDiagnostic {
  const candidates = [
    path.join(steamRoot, 'logs', 'content_log.txt'),
    path.join(steamRoot, 'logs', 'content_log.previous.txt'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const tail = readFileTailUtf8(candidate);
      if (!tail.trim()) continue;
      const parsed = parseSteamContentLogText(
        tail,
        targetAppId,
        knownDepotIds,
        candidate
      );
      if (
        parsed.failedManifests.length > 0 ||
        parsed.missingKeyDepots.length > 0 ||
        parsed.corruptManifestFiles.length > 0 ||
        parsed.recentLines.length > 0
      ) {
        return parsed;
      }
      // Return found=true with empty errors from primary log unless previous log has them
      if (candidate === candidates[0]) {
        const prevPath = candidates[1];
        if (fs.existsSync(prevPath)) {
          try {
            const prevParsed = parseSteamContentLogText(
              readFileTailUtf8(prevPath),
              targetAppId,
              knownDepotIds,
              prevPath
            );
            if (prevParsed.recentLines.length > 0) {
              return prevParsed;
            }
          } catch {
            // Ignore unreadable previous log
          }
        }
        return parsed;
      }
    } catch {
      // Try next log candidate
    }
  }

  return {
    logFound: false,
    failedManifests: [],
    missingKeyDepots: [],
    corruptManifestFiles: [],
    recentLines: [],
  };
}

const STEAM_DOMAIN_FRAGMENTS = [
  'steampowered.com',
  'steamstatic.com',
  'steamcontent.com',
  'steamserver.net',
  'steamcommunity.com',
];

/**
 * Checks the system hosts file (read-only) for active entries redirecting Steam CDN
 * or API domains to loopback/sinkhole addresses (127.0.0.1 / 0.0.0.0 / ::1).
 */
export function checkHostsBlockingSteam(customHostsPath?: string): string[] {
  const hostsPath =
    customHostsPath ??
    (process.platform === 'win32'
      ? path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'drivers',
          'etc',
          'hosts'
        )
      : '/etc/hosts');

  if (!fs.existsSync(hostsPath)) return [];

  const blocked = new Set<string>();
  try {
    const raw = fs.readFileSync(hostsPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.replace(/#.*$/, '').trim();
      if (!stripped) continue;
      const parts = stripped.split(/\s+/);
      if (parts.length < 2) continue;
      const ip = parts[0];
      const isSinkhole =
        ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::1' || ip === '::';
      if (!isSinkhole) continue;

      for (const host of parts.slice(1)) {
        const lower = host.toLowerCase();
        if (STEAM_DOMAIN_FRAGMENTS.some((frag) => lower.includes(frag))) {
          blocked.add(`${ip} ${lower}`);
        }
      }
    }
  } catch {
    // Ignore unreadable hosts file
  }

  return Array.from(blocked);
}

/**
 * Pure parser for `https://api.steamcmd.net/v1/info/<appId>` JSON responses.
 */
export function parseSteamCmdAppInfoJson(
  appId: string,
  payload: unknown
): LiveSteamAppInfo {
  const fetchedAt = new Date().toISOString();
  if (!payload || typeof payload !== 'object') {
    return {
      appId,
      dlcAppIds: [],
      depots: [],
      fetchedAt,
      steamReachable: false,
      error: 'Invalid response from SteamCMD metadata API.',
    };
  }

  const root = payload as Record<string, unknown>;
  const dataObj = root.data as Record<string, unknown> | undefined;
  const appData = dataObj?.[appId] as Record<string, unknown> | undefined;
  if (!appData || typeof appData !== 'object') {
    return {
      appId,
      dlcAppIds: [],
      depots: [],
      fetchedAt,
      steamReachable: true,
      error: `AppID ${appId} was not found in Steam public PICS metadata.`,
    };
  }

  const common = appData.common as Record<string, unknown> | undefined;
  const extended = appData.extended as Record<string, unknown> | undefined;
  const depotsObj = appData.depots as Record<string, unknown> | undefined;

  const name =
    typeof common?.name === 'string' && common.name.trim()
      ? common.name.trim()
      : undefined;

  const dlcAppIds: string[] = [];
  if (typeof extended?.listofdlc === 'string') {
    for (const part of extended.listofdlc.split(',')) {
      const trimmed = part.trim();
      if (/^\d+$/.test(trimmed)) dlcAppIds.push(trimmed);
    }
  }

  let buildId: string | undefined;
  const branches = depotsObj?.branches as Record<string, unknown> | undefined;
  const publicBranch = branches?.public as Record<string, unknown> | undefined;
  if (typeof publicBranch?.buildid === 'string') {
    buildId = publicBranch.buildid;
  }

  const depots: LiveSteamDepotInfo[] = [];
  if (depotsObj && typeof depotsObj === 'object') {
    for (const [key, val] of Object.entries(depotsObj)) {
      if (!/^\d+$/.test(key) || !val || typeof val !== 'object') continue;
      const entry = val as Record<string, unknown>;
      const config = entry.config as Record<string, unknown> | undefined;
      const manifests = entry.manifests as Record<string, unknown> | undefined;
      const pub = manifests?.public;

      let publicManifestId: string | undefined;
      let sizeBytes: number | undefined;
      let downloadBytes: number | undefined;

      if (typeof pub === 'string' && /^\d+$/.test(pub.trim())) {
        publicManifestId = pub.trim();
      } else if (pub && typeof pub === 'object') {
        const pubObj = pub as Record<string, unknown>;
        if (typeof pubObj.gid === 'string' && /^\d+$/.test(pubObj.gid.trim())) {
          publicManifestId = pubObj.gid.trim();
        }
        if (typeof pubObj.size === 'string' && /^\d+$/.test(pubObj.size)) {
          sizeBytes = Number.parseInt(pubObj.size, 10);
        }
        if (typeof pubObj.download === 'string' && /^\d+$/.test(pubObj.download)) {
          downloadBytes = Number.parseInt(pubObj.download, 10);
        }
      }

      const depotFromApp =
        typeof entry.depotfromapp === 'string' ? entry.depotfromapp : undefined;
      const isShared =
        entry.sharedinstall === '1' ||
        entry.sharedinstall === 1 ||
        Boolean(depotFromApp && depotFromApp !== appId);

      const dlcAppId =
        typeof entry.dlcappid === 'string'
          ? entry.dlcappid
          : typeof config?.optionaldlc === 'string'
            ? config.optionaldlc
            : undefined;

      depots.push({
        depotId: key,
        publicManifestId,
        sizeBytes,
        downloadBytes,
        oslist: typeof config?.oslist === 'string' ? config.oslist : undefined,
        language:
          typeof config?.language === 'string' ? config.language : undefined,
        dlcAppId,
        isShared,
        depotFromApp,
      });
    }
  }

  return {
    appId,
    name,
    buildId,
    dlcAppIds,
    depots,
    fetchedAt,
    steamReachable: true,
  };
}

/**
 * Fetches live public Steam depot & manifest metadata for an AppID via api.steamcmd.net
 * and verifies whether Steam's online endpoints are actually reachable from this PC.
 */
export async function fetchLiveSteamAppInfo(
  appId: string
): Promise<LiveSteamAppInfo> {
  const cleanId = appId.trim();
  const fetchedAt = new Date().toISOString();

  if (!/^\d+$/.test(cleanId)) {
    return {
      appId: cleanId,
      dlcAppIds: [],
      depots: [],
      fetchedAt,
      steamReachable: false,
      error: 'AppID must be numeric.',
    };
  }

  try {
    const res = await fetch(`https://api.steamcmd.net/v1/info/${cleanId}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Lunex-Steam-Manager/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;
    return parseSteamCmdAppInfoJson(cleanId, json);
  } catch (err) {
    // Fallback reachability probe against Valve's Steam Store to distinguish API hiccup vs offline PC
    let steamReachable = false;
    try {
      const probe = await fetch('https://store.steampowered.com/', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5_000),
      });
      steamReachable = probe.ok || probe.status < 500;
    } catch {
      steamReachable = false;
    }

    const msg = err instanceof Error ? err.message : String(err);
    return {
      appId: cleanId,
      dlcAppIds: [],
      depots: [],
      fetchedAt,
      steamReachable,
      error: steamReachable
        ? `Steam is reachable, but api.steamcmd.net lookup failed (${msg}).`
        : `Could not reach api.steamcmd.net or store.steampowered.com (${msg}).`,
    };
  }
}
