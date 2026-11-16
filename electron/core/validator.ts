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
/** Valve Steam ContentManifestMetadata Magic (0x1F4812BE little-endian: BE 12 48 1F) */
export const STEAM_MANIFEST_METADATA_MAGIC = 0x1f4812be;
export const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_UINT64 = 18446744073709551615n;

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isValidDepotDecryptionKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) && !/^0+$/.test(trimmed);
}

export function isValidManifestGid(manifestId?: string): boolean {
  if (!manifestId) return false;
  const trimmed = manifestId.trim();
  if (!/^\d+$/.test(trimmed) || /^0+$/.test(trimmed)) return false;
  try {
    const val = BigInt(trimmed);
    return val > 0n && val <= MAX_UINT64;
  } catch {
    return false;
  }
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

    if (entryName.endsWith('/') || entryName.startsWith('__MACOSX/')) {
      continue;
    }
    if (
      uncompressedSize > MAX_ZIP_ENTRY_BYTES ||
      compressedSize > MAX_ZIP_ENTRY_BYTES
    ) {
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
 * Supports both non-empty payloads and valid 0-byte empty payloads followed by 0x1F4812BE metadata.
 */
export function isRawSteamDepotManifest(buffer: Buffer): boolean {
  if (buffer.byteLength < 16) return false;
  if (buffer.readUInt32LE(0) !== STEAM_MANIFEST_MAGIC) return false;
  const payloadLength = buffer.readUInt32LE(4);
  if (payloadLength > buffer.byteLength - 8) return false;
  if (payloadLength === 0) {
    return (
      buffer.byteLength >= 16 &&
      buffer.readUInt32LE(8) === STEAM_MANIFEST_METADATA_MAGIC
    );
  }
  return true;
}

export interface DepotManifestBinaryMetadata {
  depotId?: string;
  manifestId?: string;
  creationTime?: number;
  filenamesEncrypted?: boolean;
  originalSize?: number;
  compressedSize?: number;
  uniqueChunks?: number;
}

function readProtobufVarint(
  buf: Buffer,
  offset: number,
  end: number
): { value: bigint; nextOffset: number } | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < end && shift <= 63n) {
    const b = BigInt(buf[pos]);
    pos++;
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
  }
  return null;
}

/**
 * Parses the Valve ContentManifestMetadata (0x1F4812BE) protobuf section immediately
 * following the DepotManifest payload, if present, to recover the authoritative
 * depot_id (field 1) and gid_manifest (field 2).
 */
export function parseDepotManifestMetadata(
  buffer: Buffer
): DepotManifestBinaryMetadata | null {
  if (!isRawSteamDepotManifest(buffer)) return null;
  const payloadLength = buffer.readUInt32LE(4);
  const metaHeaderOffset = 8 + payloadLength;
  if (metaHeaderOffset + 8 > buffer.byteLength) return null;
  if (buffer.readUInt32LE(metaHeaderOffset) !== STEAM_MANIFEST_METADATA_MAGIC) {
    return null;
  }
  const metaLength = buffer.readUInt32LE(metaHeaderOffset + 4);
  const metaStart = metaHeaderOffset + 8;
  const metaEnd = metaStart + metaLength;
  if (metaLength === 0 || metaEnd > buffer.byteLength) return null;

  const result: DepotManifestBinaryMetadata = {};
  let pos = metaStart;

  while (pos < metaEnd) {
    const tagRes = readProtobufVarint(buffer, pos, metaEnd);
    if (!tagRes) break;
    pos = tagRes.nextOffset;
    const fieldNumber = Number(tagRes.value >> 3n);
    const wireType = Number(tagRes.value & 7n);

    if (wireType === 0) {
      const valRes = readProtobufVarint(buffer, pos, metaEnd);
      if (!valRes) break;
      pos = valRes.nextOffset;
      if (fieldNumber === 1 && valRes.value > 0n) {
        result.depotId = valRes.value.toString(10);
      } else if (fieldNumber === 2 && valRes.value > 0n) {
        result.manifestId = valRes.value.toString(10);
      } else if (fieldNumber === 3) {
        result.creationTime = Number(valRes.value);
      } else if (fieldNumber === 4) {
        result.filenamesEncrypted = valRes.value !== 0n;
      } else if (fieldNumber === 5) {
        result.originalSize = Number(valRes.value);
      } else if (fieldNumber === 6) {
        result.compressedSize = Number(valRes.value);
      } else if (fieldNumber === 7) {
        result.uniqueChunks = Number(valRes.value);
      }
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const lenRes = readProtobufVarint(buffer, pos, metaEnd);
      if (!lenRes) break;
      pos = lenRes.nextOffset + Number(lenRes.value);
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }

  return result.depotId || result.manifestId ? result : null;
}

function isGzipBuffer(buffer: Buffer): boolean {
  return buffer.byteLength >= 18 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isZlibBuffer(buffer: Buffer): boolean {
  if (buffer.byteLength < 10) return false;
  if (buffer[0] !== 0x78) return false;
  return (
    buffer[1] === 0x01 ||
    buffer[1] === 0x5e ||
    buffer[1] === 0x9c ||
    buffer[1] === 0xda
  );
}

/**
 * If a .manifest file is actually ZIP-, GZIP-, or ZLIB-wrapped (common when saved
 * directly from Steam CDN / manifest tools), extracts the inner raw 0x71F617D0 buffer.
 */
export function unwrapZipManifestBuffer(
  buffer: Buffer
): { unwrapped: Buffer; innerFileName: string; format: 'zip' | 'gzip' | 'zlib' } | null {
  // 1. Standard ZIP wrapper (PK\x03\x04)
  if (buffer.byteLength >= 22 && buffer.readUInt32LE(0) === ZIP_LOCAL_MAGIC) {
    const entries = readZipEntries(buffer);
    if (entries.length === 0) return null;

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
          format: 'zip',
        };
      }
    }
    return null;
  }

  // 2. GZIP wrapper (1F 8B)
  if (isGzipBuffer(buffer)) {
    try {
      const gunzipped = zlib.gunzipSync(buffer, {
        maxOutputLength: MAX_ZIP_ENTRY_BYTES,
      });
      if (isRawSteamDepotManifest(gunzipped)) {
        return { unwrapped: gunzipped, innerFileName: 'z', format: 'gzip' };
      }
    } catch {
      return null;
    }
  }

  // 3. Raw ZLIB wrapper (78 9C / 78 DA / etc.)
  if (isZlibBuffer(buffer)) {
    try {
      const inflated = zlib.inflateSync(buffer, {
        maxOutputLength: MAX_ZIP_ENTRY_BYTES,
      });
      if (isRawSteamDepotManifest(inflated)) {
        return { unwrapped: inflated, innerFileName: 'z', format: 'zlib' };
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Extracts all .lua and .manifest files from a dropped .zip bundle.
 * Automatically unwraps compressed .manifest entries if nested.
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
 *   addappid(1091501, "a1b2c3...")
 *   setManifestid(1091501, "8492019283746512345", 0)
 * Also detects commented-out `-- setManifestid(...)` lines so diagnostics can surface them.
 */
export function parseLuaDirectives(content: string): {
  directives: ParsedLuaDirective[];
  primaryAppId?: string;
} {
  const byId = new Map<string, ParsedLuaDirective>();
  let firstRootAppId: string | undefined;
  let firstAnyId: string | undefined;

  // Detect commented-out setManifestid lines before stripping comments
  const commentedSetRegex =
    /^\s*--\s*setManifestid\s*\(\s*(\d+)\s*,\s*["']?(\d+)["']?(?:\s*,\s*\d+)?\s*\)/gim;
  const commentedPins = new Map<string, string>();
  let cmMatch: RegExpExecArray | null;
  while ((cmMatch = commentedSetRegex.exec(content)) !== null) {
    commentedPins.set(cmMatch[1], cmMatch[2]);
  }

  // Strip Lua comments (--[[ ... ]] and -- ...) before matching active directives
  const stripped = content
    .replace(/--\[\[[\s\S]*?\]\]/g, '')
    .replace(/--[^\r\n]*/g, '');

  // Matches addappid(id), addappid(id, flag), addappid(id, flag, "key"), and addappid(id, "key")
  const addAppIdRegex =
    /addappid\s*\(\s*(\d+)\s*(?:,\s*(?:\d+\s*(?:,\s*["']([0-9a-fA-F]+)["'])?|["']([0-9a-fA-F]+)["']))?\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = addAppIdRegex.exec(stripped)) !== null) {
    const id = match[1];
    const key = match[2] ?? match[3];
    if (!firstAnyId) firstAnyId = id;
    if (!key && !firstRootAppId) {
      firstRootAppId = id;
    }
    const existing = byId.get(id) ?? { id };
    if (key) {
      existing.decryptionKey = key;
      existing.keyValid = isValidDepotDecryptionKey(key);
    }
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
    existing.manifestIdValid = isValidManifestGid(manifestId);
    byId.set(id, existing);
  }

  // Attach commented-out setManifestid info when no active pin exists for that depot
  for (const [id, cManifestId] of commentedPins.entries()) {
    const existing = byId.get(id);
    if (existing && !existing.manifestId) {
      existing.commentedManifestId = cManifestId;
    }
  }

  return {
    directives: Array.from(byId.values()),
    primaryAppId: firstRootAppId ?? firstAnyId,
  };
}

/**
 * Updates or inserts addappid() and setManifestid() directives in a .lua script
 * line-by-line so:
 *  - Commented-out `-- setManifestid(depotId, ...)` lines are cleanly UNCOMMENTED and updated
 *  - Duplicate `setManifestid(depotId, ...)` lines for the same depot are deduplicated
 *  - Unrelated comments, addtoken(), and other directives are preserved intact
 */
export function upsertLuaManifestDirectives(
  content: string,
  appId: string,
  depotManifests: { depotId: string; manifestId: string; decryptionKey?: string }[]
): { updatedContent: string; changed: boolean } {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.length > 0 ? normalized.split('\n') : [];
  // Remove a single trailing empty element from split if content ended with \n
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const { directives } = parseLuaDirectives(normalized);
  const existingAppEntry = directives.find((d) => d.id === appId);
  if (!existingAppEntry && /^\d+$/.test(appId)) {
    if (lines.length === 0) {
      lines.push(`-- Lunex Managed Manifest (${appId})`);
      lines.push(`addappid(${appId})`);
    } else {
      lines.unshift(`addappid(${appId})`);
    }
  }

  for (const dm of depotManifests) {
    const { depotId, manifestId, decryptionKey } = dm;
    if (!/^\d+$/.test(depotId) || !isValidManifestGid(manifestId)) continue;

    // 1. Ensure addappid(depotId, 1, "key") exists if we have a valid 64-hex key
    if (decryptionKey && isValidDepotDecryptionKey(decryptionKey)) {
      const currentDirectives = parseLuaDirectives(lines.join('\n')).directives;
      const depotDir = currentDirectives.find((d) => d.id === depotId);

      if (!depotDir) {
        lines.push(`addappid(${depotId}, 1, "${decryptionKey}")`);
      } else if (!depotDir.decryptionKey || !depotDir.keyValid) {
        const bareLineRegex = new RegExp(
          `^(\\s*)addappid\\s*\\(\\s*${depotId}\\s*(?:,\\s*\\d+\\s*(?:,\\s*["'][0-9a-fA-F]*["'])?)?\\s*\\)(.*)$`,
          'i'
        );
        let replacedKeyLine = false;
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*--/.test(lines[i])) continue;
          const m = bareLineRegex.exec(lines[i]);
          if (m) {
            lines[i] = `${m[1]}addappid(${depotId}, 1, "${decryptionKey}")${m[2]}`;
            replacedKeyLine = true;
            break;
          }
        }
        if (!replacedKeyLine) {
          lines.push(`addappid(${depotId}, 1, "${decryptionKey}")`);
        }
      }
    }

    // 2. Replace active OR uncomment commented-out setManifestid(depotId, ...) lines; deduplicate extras
    const setLineRegex = new RegExp(
      `^(\\s*)(?:--\\s*)?setManifestid\\s*\\(\\s*${depotId}\\s*,\\s*["']?(\\d+)["']?(\\s*,\\s*\\d+)?\\s*\\)(.*)$`,
      'i'
    );
    let updatedPin = false;
    const nextLines: string[] = [];

    for (const line of lines) {
      const m = setLineRegex.exec(line);
      if (m) {
        if (!updatedPin) {
          const indent = m[1] ?? '';
          const tailArg = m[3] ?? ', 0';
          const trailing = m[4] ?? '';
          nextLines.push(
            `${indent}setManifestid(${depotId}, "${manifestId}"${tailArg})${trailing}`
          );
          updatedPin = true;
        }
        // Drop duplicate setManifestid lines for the exact same depotId
      } else {
        nextLines.push(line);
      }
    }

    if (!updatedPin) {
      nextLines.push(`setManifestid(${depotId}, "${manifestId}", 0)`);
    }

    lines.length = 0;
    lines.push(...nextLines);
  }

  const updatedContent = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  return {
    updatedContent,
    changed: updatedContent !== normalized,
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

  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
    errors.push('File contains HTML markup instead of valid Lua script.');
    return { errors, warnings };
  }

  let i = 0;
  const len = content.length;
  let parenDepth = 0;
  let braceDepth = 0;

  while (i < len) {
    const ch = content[i];
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
    if (buffer.includes(0x00)) {
      return {
        fileName,
        valid: false,
        fileType: 'lua',
        sha256,
        sizeBytes,
        errors: [
          'Invalid .lua file: contains binary null bytes instead of UTF-8 text.',
        ],
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

    for (const d of directives) {
      if (d.decryptionKey && !d.keyValid) {
        warnings.push(
          `Depot ${d.id} has an invalid or placeholder decryption key (must be 64 non-zero hex characters).`
        );
      }
      if (d.manifestId && !d.manifestIdValid) {
        warnings.push(
          `Depot ${d.id} has an invalid or placeholder setManifestid("${d.manifestId}").`
        );
      }
      if (d.commentedManifestId && !d.manifestId) {
        warnings.push(
          `Depot ${d.id} has a commented-out -- setManifestid(${d.id}, "${d.commentedManifestId}") that Steam ignores until uncommented.`
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

  const headAscii = buffer
    .subarray(0, Math.min(64, sizeBytes))
    .toString('utf8')
    .trimStart();
  if (/^(<!doctype|<html|\{\s*"error")/i.test(headAscii)) {
    errors.push(
      'Corrupted .manifest file: contains plain text / HTML instead of binary depot data.'
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

  let nameMatch = /^(\d+)_(\d+)$/.exec(baseName);
  let detectedDepotId = nameMatch
    ? nameMatch[1]
    : /^\d+$/.test(baseName)
      ? baseName
      : undefined;
  let detectedManifestId = nameMatch ? nameMatch[2] : undefined;

  let rawBufferForMeta: Buffer | null = null;
  let isZipWrapped = false;

  const magic = buffer.readUInt32LE(0);
  const isSteamMagic = magic === STEAM_MANIFEST_MAGIC;
  const isCompressedMagic =
    magic === ZIP_LOCAL_MAGIC || isGzipBuffer(buffer) || isZlibBuffer(buffer);

  if (isSteamMagic) {
    if (!isRawSteamDepotManifest(buffer)) {
      const payloadLength = buffer.readUInt32LE(4);
      errors.push(
        `Corrupted DepotManifest header: declared payload length (${payloadLength} bytes) exceeds file size (${sizeBytes} bytes).`
      );
    } else {
      rawBufferForMeta = buffer;
    }
  } else if (isCompressedMagic) {
    const unwrapped = unwrapZipManifestBuffer(buffer);
    if (!unwrapped) {
      errors.push(
        'Compressed .manifest file does not contain a valid Steam DepotManifest (0x71F617D0) payload.'
      );
    } else {
      isZipWrapped = true;
      rawBufferForMeta = unwrapped.unwrapped;
      warnings.push(
        `${unwrapped.format.toUpperCase()}-wrapped DepotManifest detected — Lunex will unwrap it to raw 0x71F617D0 binary for Steam depotcache.`
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
  } else {
    errors.push(
      `Invalid binary header (0x${magic.toString(16).toUpperCase().padStart(8, '0')}). Expected Steam DepotManifest signature (0x71F617D0).`
    );
  }

  // Extract authoritative depot_id and gid_manifest from 0x1F4812BE metadata block if present
  let headerDepotId: string | undefined;
  let headerManifestId: string | undefined;
  if (rawBufferForMeta) {
    const meta = parseDepotManifestMetadata(rawBufferForMeta);
    if (meta) {
      headerDepotId = meta.depotId;
      headerManifestId = meta.manifestId;
      if (!detectedDepotId && headerDepotId) detectedDepotId = headerDepotId;
      if (!detectedManifestId && headerManifestId) detectedManifestId = headerManifestId;

      if (
        nameMatch &&
        ((headerDepotId && headerDepotId !== nameMatch[1]) ||
          (headerManifestId && headerManifestId !== nameMatch[2]))
      ) {
        warnings.push(
          `Filename (${nameMatch[1]}_${nameMatch[2]}) disagrees with binary DepotManifest header (${headerDepotId ?? '?'}_${headerManifestId ?? '?'}). Steam will reject this file until renamed.`
        );
      }
    }
  }

  if (!nameMatch && !headerDepotId && errors.length === 0) {
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
    headerDepotId,
    headerManifestId,
    sha256,
    sizeBytes,
    errors,
    warnings,
    isZipWrapped,
  };
}

function encodeProtobufVarint(value: bigint): Buffer {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

/**
 * Helper to build a valid binary Steam DepotManifest buffer including both
 * 0x71F617D0 payload and authentic 0x1F4812BE ContentManifestMetadata protobuf block.
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
  const payloadHeader = Buffer.alloc(8);
  payloadHeader.writeUInt32LE(STEAM_MANIFEST_MAGIC, 0);
  payloadHeader.writeUInt32LE(payload.byteLength, 4);

  const metaParts: Buffer[] = [];
  if (/^\d+$/.test(depotId)) {
    metaParts.push(Buffer.from([0x08]), encodeProtobufVarint(BigInt(depotId)));
  }
  if (/^\d+$/.test(manifestId)) {
    metaParts.push(Buffer.from([0x10]), encodeProtobufVarint(BigInt(manifestId)));
  }
  const metaBody = Buffer.concat(metaParts);
  const metaHeader = Buffer.alloc(8);
  metaHeader.writeUInt32LE(STEAM_MANIFEST_METADATA_MAGIC, 0);
  metaHeader.writeUInt32LE(metaBody.byteLength, 4);

  const signatureFooter = Buffer.from(
    `\x17\xb8\x81\x1bSIGNATURE:${depotId}_${manifestId}`,
    'utf8'
  );

  return Buffer.concat([
    payloadHeader,
    payload,
    metaHeader,
    metaBody,
    signatureFooter,
  ]);
}
