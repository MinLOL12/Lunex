import crypto from 'node:crypto';
import path from 'node:path';
import type {
  ManifestFileType,
  ParsedLuaDirective,
  ValidationResult,
} from './types.js';

/** Valve Steam DepotManifest Payload Magic (0x71F617D0 little-endian: D0 17 F6 71) */
export const STEAM_MANIFEST_MAGIC = 0x71f617d0;

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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
    /addappid\s*\(\s*(\d+)\s*(?:,\s*\d+\s*(?:,\s*["']([0-9a-fA-F]+)["'])?)?\s*\)/g;
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
    /setManifestid\s*\(\s*(\d+)\s*,\s*["'](\d+)["'](?:\s*,\s*\d+)?\s*\)/gi;
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
        `Unsupported file extension "${ext || '(none)'}". Only .lua and .manifest files are supported.`,
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
      // Check if it at least looks like plausible Lua statements vs random garbage
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
  const nameMatch = /^(\d+)_(\d+)$/.exec(baseName);
  const detectedDepotId = nameMatch ? nameMatch[1] : /^\d+$/.test(baseName) ? baseName : undefined;
  const detectedManifestId = nameMatch ? nameMatch[2] : undefined;

  if (!nameMatch) {
    warnings.push(
      'Filename does not follow standard "<depotid>_<manifestid>.manifest" naming convention.'
    );
  }

  // Verify Valve DepotManifest binary magic (0x71F617D0 LE) or PK zip signature (0x04034B50 LE)
  const magic = buffer.readUInt32LE(0);
  const isSteamMagic = magic === STEAM_MANIFEST_MAGIC;
  const isZipMagic = magic === 0x04034b50;

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
