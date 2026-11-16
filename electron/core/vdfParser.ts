export interface VdfObject {
  [key: string]: string | VdfObject;
}

interface VdfToken {
  kind: 'brace_open' | 'brace_close' | 'text';
  value: string;
  start: number;
  end: number;
}

function tokenizeVdfWithOffsets(content: string): VdfToken[] {
  const tokens: VdfToken[] = [];
  let i = 0;
  const len = content.length;

  if (content.charCodeAt(0) === 0xfeff) {
    i = 1;
  }

  while (i < len) {
    const ch = content[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    if (ch === '/' && content[i + 1] === '/') {
      while (i < len && content[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '{') {
      tokens.push({ kind: 'brace_open', value: '{', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '}') {
      tokens.push({ kind: 'brace_close', value: '}', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++; // opening quote
      let str = '';
      while (i < len && content[i] !== '"') {
        if (content[i] === '\\' && i + 1 < len) {
          const next = content[i + 1];
          if (next === '\\') str += '\\';
          else if (next === '"') str += '"';
          else if (next === 'n') str += '\n';
          else if (next === 't') str += '\t';
          else str += next;
          i += 2;
        } else {
          str += content[i];
          i++;
        }
      }
      if (i < len && content[i] === '"') i++; // closing quote
      tokens.push({ kind: 'text', value: str, start, end: i });
      continue;
    }

    const start = i;
    let unquoted = '';
    while (
      i < len &&
      content[i] !== ' ' &&
      content[i] !== '\t' &&
      content[i] !== '\r' &&
      content[i] !== '\n' &&
      content[i] !== '{' &&
      content[i] !== '}' &&
      content[i] !== '"'
    ) {
      unquoted += content[i];
      i++;
    }
    if (unquoted.length > 0) {
      tokens.push({ kind: 'text', value: unquoted, start, end: i });
    }
  }

  return tokens;
}

/**
 * Parses Valve KeyValues (.vdf / .acf) text into nested JavaScript objects.
 * Supports quoted/unquoted tokens, escaped backslashes (Windows paths), comments, and nested sections.
 */
export function parseVdf(content: string): VdfObject {
  const tokens = tokenizeVdfWithOffsets(content);
  let cursor = 0;

  function parseSection(): VdfObject {
    const obj: VdfObject = {};
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.kind === 'brace_close') {
        cursor++;
        return obj;
      }
      if (token.kind === 'brace_open') {
        cursor++;
        continue;
      }

      const key = token.value;
      cursor++;
      if (cursor >= tokens.length) break;

      const next = tokens[cursor];
      if (next.kind === 'brace_open') {
        cursor++;
        const child = parseSection();
        const existing = obj[key];
        if (existing && typeof existing === 'object') {
          Object.assign(existing, child);
        } else {
          obj[key] = child;
        }
      } else if (next.kind === 'brace_close') {
        obj[key] = '';
      } else {
        obj[key] = next.value;
        cursor++;
      }
    }
    return obj;
  }

  return parseSection();
}

interface VdfSpanEntry {
  key: string;
  keyToken: VdfToken;
  isSection: boolean;
  valueToken?: VdfToken;
  openBrace?: VdfToken;
  closeBrace?: VdfToken;
  children?: Map<string, VdfSpanEntry>;
}

function buildVdfSpanTree(content: string): Map<string, VdfSpanEntry> {
  const tokens = tokenizeVdfWithOffsets(content);
  let cursor = 0;

  function parseBlock(): {
    entries: Map<string, VdfSpanEntry>;
    closeBrace?: VdfToken;
  } {
    const entries = new Map<string, VdfSpanEntry>();
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.kind === 'brace_close') {
        cursor++;
        return { entries, closeBrace: token };
      }
      if (token.kind === 'brace_open') {
        cursor++;
        continue;
      }

      const keyToken = token;
      cursor++;
      if (cursor >= tokens.length) break;

      const next = tokens[cursor];
      if (next.kind === 'brace_open') {
        cursor++;
        const inner = parseBlock();
        entries.set(keyToken.value.toLowerCase(), {
          key: keyToken.value,
          keyToken,
          isSection: true,
          openBrace: next,
          closeBrace: inner.closeBrace,
          children: inner.entries,
        });
      } else if (next.kind === 'brace_close') {
        entries.set(keyToken.value.toLowerCase(), {
          key: keyToken.value,
          keyToken,
          isSection: false,
        });
      } else {
        cursor++;
        entries.set(keyToken.value.toLowerCase(), {
          key: keyToken.value,
          keyToken,
          isSection: false,
          valueToken: next,
        });
      }
    }
    return { entries };
  }

  return parseBlock().entries;
}

export interface ParsedAppManifest {
  appId: string;
  name: string;
  installDir: string;
  stateFlags: number;
  sizeOnDisk: number;
  lastUpdated: number;
  buildId?: string;
  bytesToDownload: number;
  bytesDownloaded: number;
  bytesToStage: number;
  bytesStaged: number;
  mountedDepots: Record<string, string>;
  stagedDepots: Record<string, string>;
}

function extractDepotManifestMap(
  state: VdfObject,
  sectionName: string
): Record<string, string> {
  const out: Record<string, string> = {};
  const secKey = Object.keys(state).find(
    (k) => k.toLowerCase() === sectionName.toLowerCase()
  );
  const sec = secKey ? state[secKey] : undefined;
  if (!sec || typeof sec !== 'object') return out;

  for (const [depotId, entry] of Object.entries(sec)) {
    if (!/^\d+$/.test(depotId)) continue;
    if (typeof entry === 'string' && /^\d+$/.test(entry.trim())) {
      out[depotId] = entry.trim();
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const manifestKey = Object.keys(entry).find(
      (k) => k.toLowerCase() === 'manifest'
    );
    const val = manifestKey ? entry[manifestKey] : undefined;
    if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
      out[depotId] = val.trim();
    }
  }
  return out;
}

/**
 * Extracts game metadata and depot mount/staging state from a Steam `appmanifest_<appid>.acf` file.
 * StateFlags === 4 (bit 2 clear, bit 4 set) indicates Fully Installed in Steam.
 */
export function parseAppManifestAcf(content: string): ParsedAppManifest | null {
  const parsed = parseVdf(content);
  const appStateKey = Object.keys(parsed).find(
    (k) => k.toLowerCase() === 'appstate'
  );
  if (!appStateKey) return null;

  const state = parsed[appStateKey];
  if (!state || typeof state !== 'object') return null;

  const getVal = (field: string): string => {
    const found = Object.keys(state).find(
      (k) => k.toLowerCase() === field.toLowerCase()
    );
    const val = found ? state[found] : '';
    return typeof val === 'string' ? val : '';
  };

  const appId = getVal('appid').trim();
  const name = getVal('name').trim();
  if (!appId || !/^\d+$/.test(appId)) return null;

  return {
    appId,
    name: name || `Steam App ${appId}`,
    installDir: getVal('installdir'),
    stateFlags: Number.parseInt(getVal('StateFlags') || '4', 10) || 0,
    sizeOnDisk: Number.parseInt(getVal('SizeOnDisk') || '0', 10) || 0,
    lastUpdated: Number.parseInt(getVal('LastUpdated') || '0', 10) || 0,
    buildId: getVal('buildid') || undefined,
    bytesToDownload: Number.parseInt(getVal('BytesToDownload') || '0', 10) || 0,
    bytesDownloaded: Number.parseInt(getVal('BytesDownloaded') || '0', 10) || 0,
    bytesToStage: Number.parseInt(getVal('BytesToStage') || '0', 10) || 0,
    bytesStaged: Number.parseInt(getVal('BytesStaged') || '0', 10) || 0,
    mountedDepots: extractDepotManifestMap(state, 'MountedDepots'),
    stagedDepots: extractDepotManifestMap(state, 'StagedDepots'),
  };
}

/**
 * Extracts Steam library folder paths from `steamapps/libraryfolders.vdf`.
 */
export function parseLibraryFoldersVdf(content: string): string[] {
  const parsed = parseVdf(content);
  const rootKey = Object.keys(parsed).find(
    (k) => k.toLowerCase() === 'libraryfolders'
  );
  if (!rootKey) return [];

  const root = parsed[rootKey];
  if (!root || typeof root !== 'object') return [];

  const paths: string[] = [];
  for (const key of Object.keys(root)) {
    const entry = root[key];
    if (typeof entry === 'string' && /^\d+$/.test(key)) {
      paths.push(entry);
    } else if (entry && typeof entry === 'object') {
      const pathKey = Object.keys(entry).find((k) => k.toLowerCase() === 'path');
      if (pathKey && typeof entry[pathKey] === 'string' && entry[pathKey]) {
        paths.push(entry[pathKey] as string);
      }
    }
  }
  return paths;
}

function escapeVdfString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

export function serializeVdf(obj: VdfObject, depth = 0): string {
  const indent = '\t'.repeat(depth);
  const lines: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      lines.push(
        `${indent}"${escapeVdfString(key)}"\t\t"${escapeVdfString(val)}"`
      );
    } else if (val && typeof val === 'object') {
      lines.push(`${indent}"${escapeVdfString(key)}"`);
      lines.push(`${indent}{`);
      const inner = serializeVdf(val, depth + 1);
      if (inner) lines.push(inner);
      lines.push(`${indent}}`);
    }
  }

  return lines.join('\n');
}

function findObjectKeyCI(obj: VdfObject, target: string): string | undefined {
  return Object.keys(obj).find((k) => k.toLowerCase() === target.toLowerCase());
}

/**
 * Extracts depot decryption keys from Steam's `config/config.vdf`:
 *   InstallConfigStore -> Software -> Valve -> Steam -> depots -> <depotId> -> DecryptionKey
 */
export function readConfigVdfDepots(
  configVdfContent: string
): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const parsed = parseVdf(configVdfContent);
    const rootKey = findObjectKeyCI(parsed, 'InstallConfigStore');
    const root = rootKey ? parsed[rootKey] : undefined;
    if (!root || typeof root !== 'object') return result;

    const swKey = findObjectKeyCI(root, 'Software');
    const sw = swKey ? root[swKey] : undefined;
    if (!sw || typeof sw !== 'object') return result;

    const valveKey = findObjectKeyCI(sw, 'Valve');
    const valve = valveKey ? sw[valveKey] : undefined;
    if (!valve || typeof valve !== 'object') return result;

    const steamKey = findObjectKeyCI(valve, 'Steam');
    const steam = steamKey ? valve[steamKey] : undefined;
    if (!steam || typeof steam !== 'object') return result;

    const depotsKey = findObjectKeyCI(steam, 'depots');
    const depots = depotsKey ? steam[depotsKey] : undefined;
    if (!depots || typeof depots !== 'object') return result;

    for (const [depotId, entry] of Object.entries(depots)) {
      if (!/^\d+$/.test(depotId) || !entry || typeof entry !== 'object') continue;
      const decKeyName = findObjectKeyCI(entry, 'DecryptionKey');
      const decKey = decKeyName ? entry[decKeyName] : undefined;
      if (typeof decKey === 'string' && decKey.trim()) {
        result.set(depotId, decKey.trim());
      }
    }
  } catch {
    // Ignore malformed config.vdf
  }
  return result;
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

function applyTextEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

function getLineIndentAt(content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let indent = '';
  for (let i = lineStart; i < offset; i++) {
    const ch = content[i];
    if (ch === '\t' || ch === ' ') indent += ch;
    else break;
  }
  return indent;
}

/**
 * Surgically inserts or updates depot decryption keys in Steam's `config/config.vdf`
 * WITHOUT re-serializing unrelated sections (such as ConnectCache, CM, Accounts, SentryFile).
 * Falls back to clean full serialization only when the Steam section skeleton is absent.
 */
export function upsertConfigVdfDepotKeys(
  configVdfContent: string,
  keys: Record<string, string>
): { updatedContent: string; addedCount: number } {
  const cleanEntries: [string, string][] = [];
  for (const [depotId, decKey] of Object.entries(keys)) {
    const cleanDepot = depotId.trim();
    const cleanKey = decKey.trim();
    if (/^\d+$/.test(cleanDepot) && /^[0-9a-fA-F]{64}$/.test(cleanKey) && !/^0+$/.test(cleanKey)) {
      cleanEntries.push([cleanDepot, cleanKey]);
    }
  }

  if (cleanEntries.length === 0) {
    return { updatedContent: configVdfContent, addedCount: 0 };
  }

  const eol = configVdfContent.includes('\r\n') ? '\r\n' : '\n';
  const tree = configVdfContent.trim() ? buildVdfSpanTree(configVdfContent) : new Map();

  const rootNode = tree.get('installconfigstore');
  const swNode = rootNode?.children?.get('software');
  const valveNode = swNode?.children?.get('valve');
  const steamNode = valveNode?.children?.get('steam');

  if (steamNode?.isSection && steamNode.closeBrace) {
    const depotsNode = steamNode.children?.get('depots');
    const edits: TextEdit[] = [];
    let addedCount = 0;

    if (depotsNode?.isSection && depotsNode.closeBrace) {
      const depotsIndent = getLineIndentAt(
        configVdfContent,
        depotsNode.closeBrace.start
      );
      const entryIndent = `${depotsIndent}\t`;
      const fieldIndent = `${entryIndent}\t`;
      const newDepotBlocks: string[] = [];

      for (const [depotId, cleanKey] of cleanEntries) {
        const existingDepot = depotsNode.children?.get(depotId.toLowerCase());
        if (existingDepot?.isSection && existingDepot.closeBrace) {
          const existingKeyEntry =
            existingDepot.children?.get('decryptionkey');
          if (existingKeyEntry?.valueToken) {
            if (
              existingKeyEntry.valueToken.value.trim().toLowerCase() !==
              cleanKey.toLowerCase()
            ) {
              edits.push({
                start: existingKeyEntry.valueToken.start,
                end: existingKeyEntry.valueToken.end,
                replacement: `"${escapeVdfString(cleanKey)}"`,
              });
              addedCount++;
            }
          } else {
            const depIndent = getLineIndentAt(
              configVdfContent,
              existingDepot.closeBrace.start
            );
            const insertPos = existingDepot.closeBrace.start;
            const prefix =
              insertPos > 0 && configVdfContent[insertPos - 1] !== '\n'
                ? eol
                : '';
            edits.push({
              start: insertPos,
              end: insertPos,
              replacement: `${prefix}${depIndent}\t"DecryptionKey"\t\t"${escapeVdfString(cleanKey)}"${eol}${depIndent}`,
            });
            addedCount++;
          }
        } else {
          newDepotBlocks.push(
            `${entryIndent}"${depotId}"${eol}${entryIndent}{${eol}${fieldIndent}"DecryptionKey"\t\t"${escapeVdfString(cleanKey)}"${eol}${entryIndent}}`
          );
          addedCount++;
        }
      }

      if (newDepotBlocks.length > 0) {
        const insertPos = depotsNode.closeBrace.start;
        // Insert cleanly on a new line right before depots' closing brace indentation
        const lineStart =
          configVdfContent.lastIndexOf('\n', Math.max(0, insertPos - 1)) + 1;
        const beforeBraceOnLine = configVdfContent.slice(lineStart, insertPos);
        if (/^[ \t]*$/.test(beforeBraceOnLine)) {
          edits.push({
            start: lineStart,
            end: lineStart,
            replacement: `${newDepotBlocks.join(eol)}${eol}`,
          });
        } else {
          edits.push({
            start: insertPos,
            end: insertPos,
            replacement: `${eol}${newDepotBlocks.join(eol)}${eol}${depotsIndent}`,
          });
        }
      }

      if (addedCount === 0) {
        return { updatedContent: configVdfContent, addedCount: 0 };
      }

      return {
        updatedContent: applyTextEdits(configVdfContent, edits),
        addedCount,
      };
    }

    // "depots" section doesn't exist yet inside "Steam" — insert it right before Steam's closing brace
    const steamIndent = getLineIndentAt(
      configVdfContent,
      steamNode.closeBrace.start
    );
    const depotsIndent = `${steamIndent}\t`;
    const entryIndent = `${depotsIndent}\t`;
    const fieldIndent = `${entryIndent}\t`;
    const depotBlocks = cleanEntries.map(
      ([depotId, cleanKey]) =>
        `${entryIndent}"${depotId}"${eol}${entryIndent}{${eol}${fieldIndent}"DecryptionKey"\t\t"${escapeVdfString(cleanKey)}"${eol}${entryIndent}}`
    );
    const depotsSection = `${depotsIndent}"depots"${eol}${depotsIndent}{${eol}${depotBlocks.join(eol)}${eol}${depotsIndent}}${eol}`;

    const insertPos = steamNode.closeBrace.start;
    const lineStart =
      configVdfContent.lastIndexOf('\n', Math.max(0, insertPos - 1)) + 1;
    const beforeBraceOnLine = configVdfContent.slice(lineStart, insertPos);
    const updatedContent = /^[ \t]*$/.test(beforeBraceOnLine)
      ? configVdfContent.slice(0, lineStart) +
        depotsSection +
        configVdfContent.slice(lineStart)
      : configVdfContent.slice(0, insertPos) +
        eol +
        depotsSection +
        steamIndent +
        configVdfContent.slice(insertPos);

    return {
      updatedContent,
      addedCount: cleanEntries.length,
    };
  }

  // Fallback for empty / minimal config.vdf missing the Steam skeleton
  const parsed = configVdfContent.trim()
    ? parseVdf(configVdfContent)
    : ({} as VdfObject);

  const ensureSection = (parent: VdfObject, name: string): VdfObject => {
    const existingKey = findObjectKeyCI(parent, name);
    if (existingKey && typeof parent[existingKey] === 'object') {
      return parent[existingKey] as VdfObject;
    }
    const created: VdfObject = {};
    parent[name] = created;
    return created;
  };

  const root = ensureSection(parsed, 'InstallConfigStore');
  const sw = ensureSection(root, 'Software');
  const valve = ensureSection(sw, 'Valve');
  const steam = ensureSection(valve, 'Steam');
  const depots = ensureSection(steam, 'depots');

  let addedCount = 0;
  for (const [cleanDepot, cleanKey] of cleanEntries) {
    const depotSection = ensureSection(depots, cleanDepot);
    const existingKeyField = findObjectKeyCI(depotSection, 'DecryptionKey');
    const currentVal = existingKeyField
      ? depotSection[existingKeyField]
      : undefined;
    if (currentVal !== cleanKey) {
      depotSection[existingKeyField ?? 'DecryptionKey'] = cleanKey;
      addedCount++;
    }
  }

  return {
    updatedContent: serializeVdf(parsed) + '\n',
    addedCount,
  };
}

/**
 * Surgically clears `"WantsOfflineMode" "1"` and `"SkipOfflineModeWarning" "1"` -> `"0"`
 * for the active user (or all users if none has MostRecent="1") in Steam's
 * `config/loginusers.vdf` without touching account tokens or other fields.
 */
export function clearLoginUsersOfflineMode(content: string): {
  updatedContent: string;
  changed: boolean;
} {
  const tree = buildVdfSpanTree(content);
  const usersNode = tree.get('users');
  if (!usersNode?.isSection || !usersNode.children) {
    return { updatedContent: content, changed: false };
  }

  const userEntries = Array.from(usersNode.children.values()).filter(
    (u) => u.isSection && u.children
  );
  const hasMostRecent = userEntries.some(
    (u) => u.children?.get('mostrecent')?.valueToken?.value === '1'
  );

  const edits: TextEdit[] = [];
  for (const userEntry of userEntries) {
    if (!userEntry.children) continue;
    const mostRecent = userEntry.children.get('mostrecent')?.valueToken?.value;
    if (hasMostRecent && mostRecent !== '1') continue;

    for (const keyName of ['wantsofflinemode', 'skipofflinemodewarning']) {
      const entry = userEntry.children.get(keyName);
      if (entry?.valueToken?.value === '1') {
        edits.push({
          start: entry.valueToken.start,
          end: entry.valueToken.end,
          replacement: '"0"',
        });
      }
    }
  }

  if (edits.length === 0) {
    return { updatedContent: content, changed: false };
  }
  return {
    updatedContent: applyTextEdits(content, edits),
    changed: true,
  };
}
