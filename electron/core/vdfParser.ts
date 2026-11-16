export interface VdfObject {
  [key: string]: string | VdfObject;
}

/**
 * Parses Valve KeyValues (.vdf / .acf) text into nested JavaScript objects.
 * Supports quoted/unquoted tokens, escaped backslashes (Windows paths), comments, and nested sections.
 */
export function parseVdf(content: string): VdfObject {
  const tokens: string[] = [];
  let i = 0;
  const len = content.length;

  // Strip UTF-8 BOM if present
  if (content.charCodeAt(0) === 0xfeff) {
    i = 1;
  }

  while (i < len) {
    const ch = content[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // Skip // comments
    if (ch === '/' && content[i + 1] === '/') {
      while (i < len && content[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Structural braces
    if (ch === '{' || ch === '}') {
      tokens.push(ch);
      i++;
      continue;
    }

    // Quoted string
    if (ch === '"') {
      i++; // skip opening quote
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
      i++; // skip closing quote
      tokens.push(str);
      continue;
    }

    // Unquoted token
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
      tokens.push(unquoted);
    }
  }

  let cursor = 0;

  function parseSection(): VdfObject {
    const obj: VdfObject = {};
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token === '}') {
        cursor++;
        return obj;
      }
      if (token === '{') {
        cursor++;
        continue;
      }

      const key = token;
      cursor++;
      if (cursor >= tokens.length) break;

      const next = tokens[cursor];
      if (next === '{') {
        cursor++; // consume '{'
        const child = parseSection();
        const existing = obj[key];
        if (existing && typeof existing === 'object') {
          Object.assign(existing, child);
        } else {
          obj[key] = child;
        }
      } else if (next === '}') {
        // Malformed empty value before closing brace
        obj[key] = '';
      } else {
        obj[key] = next;
        cursor++;
      }
    }
    return obj;
  }

  return parseSection();
}

export interface ParsedAppManifest {
  appId: string;
  name: string;
  installDir: string;
  stateFlags: number;
  sizeOnDisk: number;
  lastUpdated: number;
}

/**
 * Extracts game metadata from a Steam `appmanifest_<appid>.acf` file.
 * StateFlags bit 4 (value 4) = Fully Installed in Steam.
 */
export function parseAppManifestAcf(content: string): ParsedAppManifest | null {
  const parsed = parseVdf(content);
  // Case-insensitive lookup for AppState
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
      // Legacy VDF format: "1" "D:\\SteamLibrary"
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
      lines.push(`${indent}"${escapeVdfString(key)}"\t\t"${escapeVdfString(val)}"`);
    } else if (val && typeof val === 'object') {
      lines.push(`${indent}"${escapeVdfString(key)}"`);
      lines.push(`${indent}{`);
      lines.push(serializeVdf(val, depth + 1));
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
export function readConfigVdfDepots(configVdfContent: string): Map<string, string> {
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

/**
 * Inserts or updates depot decryption keys in Steam's `config/config.vdf`.
 */
export function upsertConfigVdfDepotKeys(
  configVdfContent: string,
  keys: Record<string, string>
): { updatedContent: string; addedCount: number } {
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
  for (const [depotId, decKey] of Object.entries(keys)) {
    const cleanDepot = depotId.trim();
    const cleanKey = decKey.trim();
    if (!/^\d+$/.test(cleanDepot) || !cleanKey) continue;

    const depotSection = ensureSection(depots, cleanDepot);
    const existingKeyField = findObjectKeyCI(depotSection, 'DecryptionKey');
    const currentVal = existingKeyField ? depotSection[existingKeyField] : undefined;
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
