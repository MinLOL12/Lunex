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
