import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import type {
  ManifestFileType,
  ParsedLuaDirective,
  ValidationResult,
} from './types.js';

/** Valve Steam DepotManifest Payload Magic (0x71F617D0 little-endian: D0 17 F6 71) */
export const STEAM_MANIFEST_MAGIC = 0x71f617d0;
export const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export interface ZipEntryData {
  fileName: string;
  data: Buffer;
}

/**
 * Parses a ZIP buffer via its Central Directory (supports Stored=0 and Deflate=8).
 * Returns empty array if buffer is not a valid ZIP archive.
 */
export function readZipEntries(buffer: Buffer): ZipEntryData[] {
  if (buffer.byteLength < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_MAGIC) {
    return [];
  }

  // Locate End of Central Directory (scan backwards up to 64KB + 22 bytes)
  const minOffset = Math.max(0, buffer.byteLength - 65557);
  let eocdOffset = -1;
  for (let i = buffer.byteLength - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_MAGIC) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return [];

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset >= eocdOffset) return [];

  const entries: ZipEntryData[] = [];
  let cursor = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (cursor + 46 > eocdOffset) break;
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_MAGIC) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    const entryName = buffer
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    // Skip directories and macOS metadata
    if (entryName.endsWith('/') || entryName.startsWith('__MACOSX/')) {
      continue;
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES || compressedSize > MAX_ZIP_ENTRY_BYTES) {
      continue;
    }
    if (localOffset + 30 > buffer.byteLength) continue;
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_MAGIC) continue;

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.byteLength) continue;

    const compressedSlice = buffer.subarray(dataStart, dataEnd);
    try {
      let data: Buffer;
      if (method === 0) {
        data = Buffer.from(compressedSlice);
      } else if (method === 8) {
        data = zlib.inflateRawSync(compressedSlice, {
          maxOutputLength: MAX_ZIP_ENTRY_BYTES,
        });
      } else {
        continue;
      }
      entries.push({ fileName: entryName, data });
    } catch {
      // Skip corrupt/encrypted entry
    }
  }

  return entries;
}

/**
 * Checks whether a buffer is a valid raw Valve DepotManifest (0x71F617D0).
 */
export function isRawSteamDepotManifest(buffer: Buffer): boolean {
  if (buffer.byteLength < 16) return false;
  if (buffer.readUInt32LE(0) !== STEAM_MANIFEST_MAGIC) return false;
  const payloadLength = buffer.readUInt32LE(4);
  return payloadLength > 0 && payloadLength <= buffer.byteLength;
}

/**
 * If a .manifest file is actually a ZIP-wrapped DepotManifest (common when saved
 * directly from Steam CDN / manifest tools), extracts the inner raw 0x71F617D0 buffer.
 */
export function unwrapZipManifestBuffer(
  buffer: Buffer
): { unwrapped: Buffer; innerFileName: string } | null {
  if (buffer.byteLength < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_MAGIC) {
    return null;
  }

  const entries = readZipEntries(buffer);
  if (entries.length === 0) return null;

  // Prefer .manifest entry, or Steam CDN's standard "z" entry, or any valid 0x71F617D0 entry
  const prioritized = [
    ...entries.filter((e) => e.fileName.toLowerCase().endsWith('.manifest')),
    ...entries.filter((e) => path.basename(e.fileName) === 'z'),
    ...entries,
  ];

  for (const entry of prioritized) {
    if (isRawSteamDepotManifest(entry.data)) {
      return {
        unwrapped: entry.data,
        innerFileName: path.basename(entry.fileName),
      };
    }
  }

  return null;
}

/**
 * Extracts all .lua and .manifest files from a dropped .zip bundle.
 * Automatically unwraps ZIP-wrapped .manifest entries if nested.
 */
export function extractManifestZipBundle(
  buffer: Buffer
): { fileName: string; data: Buffer }[] {
  const entries = readZipEntries(buffer);
  const extracted: { fileName: string; data: Buffer }[] = [];

  for (const entry of entries) {
    const base = path.basename(entry.fileName);
    const ext = path.extname(base).toLowerCase();
    if (ext === '.lua') {
      extracted.push({ fileName: base, data: entry.data });
    } else if (ext === '.manifest') {
      const inner = unwrapZipManifestBuffer(entry.data);
      extracted.push({
        fileName: base,
        data: inner ? inner.unwrapped : entry.data,
      });
    }
  }

  return extracted;
}

/**
 * Parses SteamTools / Lua manifest directives such as:
 *   addappid(1091500)
 *   addappid(1091501, 1, "a1b2c3...")
 *   setManifestid(1091501, "8492019283746512345", 0)
 */
export function parseLuaDirectives(content: string): {
  directives: ParsedLuaDirective[];
  primaryAppId?: string;
} {
  const byId = new Map<string, ParsedLuaDirective>();
  let firstRootAppId: string | undefined;
  let firstAnyId: string | undefined;

  // Strip Lua comments (-- ... and --[[ ... ]]) before matching directives
  const stripped = content
    .replace(/--\[\[[\s\S]*?\]\]/g, '')
    .replace(/--[^\r\n]*/g, '');

  const addAppIdRegex =
    /addappid\s*\(\s*(\d+)\s*(?:,\s*\d+\s*(?:,\s*["']([0-9a-fA-F]+)["'])?)?\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = addAppIdRegex.exec(stripped)) !== null) {
    const id = match[1];
    const key = match[2];
    if (!firstAnyId) firstAnyId = id;
    if (!key && !firstRootAppId) {
      firstRootAppId = id;
    }
    const existing = byId.get(id) ?? { id };
    if (key) existing.decryptionKey = key;
    byId.set(id, existing);
  }

  const setManifestRegex =
    /setManifestid\s*\(\s*(\d+)\s*,\s*["']?(\d+)["']?(?:\s*,\s*\d+)?\s*\)/gi;
  while ((match = setManifestRegex.exec(stripped)) !== null) {
    const id = match[1];
    const manifestId = match[2];
    if (!firstAnyId) firstAnyId = id;
    const existing = byId.get(id) ?? { id };
    existing.manifestId = manifestId;
    byId.set(id, existing);
  }

  return {
    directives: Array.from(byId.values()),
    primaryAppId: firstRootAppId ?? firstAnyId,
  };
}

/**
 * Updates or inserts addappid() and setManifestid() directives in a .lua script
 * so SteamTools pins the exact manifest files present in Steam/depotcache.
 */
export function upsertLuaManifestDirectives(
  content: string,
  appId: string,
  depotManifests: { depotId: string; manifestId: string; decryptionKey?: string }[]
): { updatedContent: string; changed: boolean } {
  let next = content.replace(/\r\n/g, '\n');
  const original = next;

  const { directives } = parseLuaDirectives(next);
  const existingAppEntry = directives.find((d) => d.id === appId);
  if (!existingAppEntry && /^\d+$/.test(appId)) {
    const prefix = next.trim().length > 0 ? `addappid(${appId})\n` : `-- Lunex Managed Manifest (${appId})\naddappid(${appId})\n`;
    next = prefix + next;
  }

  for (const dm of depotManifests) {
    const { depotId, manifestId, decryptionKey } = dm;
    if (!/^\d+$/.test(depotId) || !/^\d+$/.test(manifestId)) continue;

    // Ensure addappid(depotId, 1, "key") exists if we recovered a key from config.vdf
    const depotDir = parseLuaDirectives(next).directives.find(
      (d) => d.id === depotId
    );
    if (decryptionKey) {
      if (!depotDir) {
        if (next.length > 0 && !next.endsWith('\n')) next += '\n';
        next += `addappid(${depotId}, 1, "${decryptionKey}")\n`;
      } else if (!depotDir.decryptionKey) {
        const bareAddRegex = new RegExp(
          `addappid\\s*\\(\\s*${depotId}\\s*(?:,\\s*\\d+\\s*)?\\)`,
          'gi'
        );
        next = next.replace(
          bareAddRegex,
          `addappid(${depotId}, 1, "${decryptionKey}")`
        );
      }
    }

    // Update or append setManifestid(depotId, "manifestId", 0)
    const setRegex = new RegExp(
      `setManifestid\\s*\\(\\s*${depotId}\\s*,\\s*["']?(\\d+)["']?(\\s*,\\s*\\d+)?\\s*\\)`,
      'gi'
    );
    if (setRegex.test(next)) {
      next = next.replace(setRegex, (_m, _oldId, tail) => {
        const suffix = tail ?? ', 0';
        return `setManifestid(${depotId}, "${manifestId}"${suffix})`;
      });
    } else {
      if (next.length > 0 && !next.endsWith('\n')) next += '\n';
      next += `setManifestid(${depotId}, "${manifestId}", 0)\n`;
    }
  }

  return {
    updatedContent: next,
    changed: next !== original,
  };
}

/**
 * Checks basic Lua lexical/structural validity so corrupted or non-Lua files are rejected.
 */
function checkLuaSyntax(content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = content.trim();
  if (!trimmed) {
    errors.push('Lua file is empty (0 statements).');
    return { errors, warnings };
  }

  // Catch HTML error pages accidentally downloaded as .lua
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
    errors.push('File contains HTML markup instead of valid Lua script.');
    return { errors, warnings };
  }

  // Strip comments & string literals to check balanced parentheses/braces
  let i = 0;
  const len = content.length;
  let parenDepth = 0;
  let braceDepth = 0;

  while (i < len) {
    const ch = content[i];
    // Lua single/multiline comment
    if (ch === '-' && content[i + 1] === '-') {
      if (content[i + 2] === '[' && content[i + 3] === '[') {
        const closeIdx = content.indexOf(']]', i + 4);
        if (closeIdx === -1) {
          errors.push('Unclosed multiline Lua comment (--[[ ...).');
          break;
        }
        i = closeIdx + 2;
        continue;
      }
      while (i < len && content[i] !== '\n') i++;
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let closed = false;
      while (i < len) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === '\n' || content[i] === '\r') {
          break;
        }
        if (content[i] === quote) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        errors.push(`Unclosed string literal (${quote}) detected in Lua script.`);
        break;
      }
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth < 0) {
        errors.push('Unmatched closing parenthesis ")" in Lua script.');
        break;
      }
    } else if (ch === '{') braceDepth++;
    else if (ch === '}') {
      braceDepth--;
      if (braceDepth < 0) {
        errors.push('Unmatched closing brace "}" in Lua script.');
        break;
      }
    }
    i++;
  }

  if (errors.length === 0) {
    if (parenDepth !== 0) {
      errors.push('Unbalanced parentheses "(" in Lua script.');
    }
    if (braceDepth !== 0) {
      errors.push('Unbalanced curly braces "{" in Lua script.');
    }
  }

  return { errors, warnings };
}

/**
 * Validates a .lua or .manifest file buffer before importing or during library scan.
 */
export function validateManifestBuffer(
  fileName: string,
  buffer: Buffer
): Omit<ValidationResult, 'duplicateStatus' | 'existingFilePath'> {
  const ext = path.extname(fileName).toLowerCase();
  const baseName = path.basename(fileName, ext);
  const sha256 = computeSha256(buffer);
  const sizeBytes = buffer.byteLength;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (ext !== '.lua' && ext !== '.manifest') {
    return {
      fileName,
      valid: false,
      fileType: 'unknown',
      sha256,
      sizeBytes,
      errors: [
        `Unsupported file extension "${ext || '(none)'}". Only .lua, .manifest, and .zip bundles are supported.`,
      ],
      warnings: [],
    };
  }

  const fileType: ManifestFileType = ext === '.lua' ? 'lua' : 'manifest';

  if (sizeBytes === 0) {
    return {
      fileName,
      valid: false,
      fileType,
      sha256,
      sizeBytes,
      errors: ['File is empty (0 bytes).'],
      warnings: [],
    };
  }

  if (fileType === 'lua') {
    // Reject binary content containing null bytes
    if (buffer.includes(0x00)) {
      return {
        fileName,
        valid: false,
        fileType: 'lua',
        sha256,
        sizeBytes,
        errors: ['Invalid .lua file: contains binary null bytes instead of UTF-8 text.'],
        warnings: [],
      };
    }

    const text = buffer.toString('utf8');
    const syntax = checkLuaSyntax(text);
    errors.push(...syntax.errors);
    warnings.push(...syntax.warnings);

    const { directives, primaryAppId } = parseLuaDirectives(text);
    const filenameAppId = /^\d+$/.test(baseName) ? baseName : undefined;
    const detectedAppId = filenameAppId ?? primaryAppId;

    if (errors.length === 0 && directives.length === 0) {
      const hasLuaConstructs =
        /\b(local|function|return|if|then|end|for|pairs|ipairs|print|require|addappid|setManifestid)\b|--|=/.test(
          text
        );
      if (!hasLuaConstructs) {
        errors.push(
          'No Steam manifest directives (addappid / setManifestid) or valid Lua statements found.'
        );
      } else {
        warnings.push(
          'Valid Lua script, but no standard addappid() directives were detected.'
        );
      }
    }

    if (
      filenameAppId &&
      primaryAppId &&
      filenameAppId !== primaryAppId &&
      !directives.some((d) => d.id === filenameAppId)
    ) {
      warnings.push(
        `Filename AppID (${filenameAppId}) differs from primary addappid(${primaryAppId}) inside script.`
      );
    }

    return {
      fileName,
      valid: errors.length === 0,
      fileType: 'lua',
      detectedAppId,
      directives,
      sha256,
      sizeBytes,
      errors,
      warnings,
    };
  }

  // .manifest validation
  if (sizeBytes < 16) {
    errors.push(
      `Invalid .manifest file: too small (${sizeBytes} bytes) to contain a valid Steam DepotManifest header.`
    );
    return {
      fileName,
      valid: false,
      fileType: 'manifest',
      sha256,
      sizeBytes,
      errors,
      warnings,
    };
  }

  // Detect HTML or JSON text accidentally saved as .manifest
  const headAscii = buffer.subarray(0, Math.min(64, sizeBytes)).toString('utf8').trimStart();
  if (/^(<!doctype|<html|\{\s*"error")/i.test(headAscii)) {
    errors.push('Corrupted .manifest file: contains plain text / HTML instead of binary depot data.');
    return {
      fileName,
      valid: false,
      fileType: 'manifest',
      sha256,
      sizeBytes,
      errors,
      warnings,
    };
  }

  // Parse filename convention: <depotid>_<manifestid>.manifest
  let nameMatch = /^(\d+)_(\d+)$/.exec(baseName);
  let detectedDepotId = nameMatch
    ? nameMatch[1]
    : /^\d+$/.test(baseName)
      ? baseName
      : undefined;
  let detectedManifestId = nameMatch ? nameMatch[2] : undefined;

  // Verify Valve DepotManifest binary magic (0x71F617D0 LE) or ZIP-wrapped DepotManifest (0x04034B50 LE)
  const magic = buffer.readUInt32LE(0);
  const isSteamMagic = magic === STEAM_MANIFEST_MAGIC;
  const isZipMagic = magic === ZIP_LOCAL_MAGIC;
  let isZipWrapped = false;

  if (!isSteamMagic && !isZipMagic) {
    errors.push(
      `Invalid binary header (0x${magic.toString(16).toUpperCase().padStart(8, '0')}). Expected Steam DepotManifest signature (0x71F617D0).`
    );
  } else if (isSteamMagic) {
    const payloadLength = buffer.readUInt32LE(4);
    if (payloadLength === 0 || payloadLength > sizeBytes) {
      errors.push(
        `Corrupted DepotManifest header: declared payload length (${payloadLength} bytes) exceeds file size (${sizeBytes} bytes).`
      );
    }
  } else if (isZipMagic) {
    const unwrapped = unwrapZipManifestBuffer(buffer);
    if (!unwrapped) {
      errors.push(
        'ZIP-wrapped .manifest file does not contain a valid Steam DepotManifest (0x71F617D0) payload.'
      );
    } else {
      isZipWrapped = true;
      warnings.push(
        'ZIP-wrapped DepotManifest detected — Lunex will unwrap it to raw 0x71F617D0 binary for Steam depotcache.'
      );
      if (!nameMatch) {
        const innerBase = path.basename(unwrapped.innerFileName, '.manifest');
        const innerMatch = /^(\d+)_(\d+)$/.exec(innerBase);
        if (innerMatch) {
          nameMatch = innerMatch;
          detectedDepotId = innerMatch[1];
          detectedManifestId = innerMatch[2];
        }
      }
    }
  }

  if (!nameMatch && errors.length === 0) {
    warnings.push(
      'Filename does not follow standard "<depotid>_<manifestid>.manifest" naming convention.'
    );
  }

  return {
    fileName,
    valid: errors.length === 0,
    fileType: 'manifest',
    detectedDepotId,
    detectedManifestId,
    sha256,
    sizeBytes,
    errors,
    warnings,
    isZipWrapped,
  };
}

/**
 * Helper to build a valid binary Steam DepotManifest buffer (used for sample seeding & tests).
 */
export function buildValidDepotManifestBuffer(
  depotId: string,
  manifestId: string,
  extraTag = 'LunexDepotPayload'
): Buffer {
  const payload = Buffer.from(
    `\x08\x01\x12${extraTag}:${depotId}:${manifestId}:protobuf-metadata-block`,
    'utf8'
  );
  const signatureFooter = Buffer.from(
    `\x17\xb8\x81\x1bSIGNATURE:${depotId}_${manifestId}`,
    'utf8'
  );
  const header = Buffer.alloc(8);
  header.writeUInt32LE(STEAM_MANIFEST_MAGIC, 0);
  header.writeUInt32LE(payload.byteLength, 4);
  return Buffer.concat([header, payload, signatureFooter]);
}
