import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { LunexManager } from './lunexManager.js';
import type { IncomingFilePayload, LunexSettings } from './types.js';
import { buildValidDepotManifestBuffer } from './validator.js';

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBytes = 64 * 1024 * 1024; // 64MB limit for depot manifests

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload exceeds 64MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function lunexApiPlugin(dataDir?: string): Plugin {
  const manager = new LunexManager({
    dataDir: dataDir ?? path.resolve(process.cwd(), '.lunex-dev-data'),
    isElectron: false,
  });

  const handleApiRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ) => {
    const urlStr = req.url ?? '';
    if (!urlStr.startsWith('/api/')) {
      next();
      return;
    }

    const pathname = urlStr.split('?')[0];
    const method = req.method?.toUpperCase() ?? 'GET';

    try {
      if (method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, manager.getState());
        return;
      }

      if (method === 'POST' && pathname === '/api/rescan') {
        sendJson(res, 200, manager.rescan());
        return;
      }

      if (method === 'POST' && pathname === '/api/validate') {
        const body = await readJsonBody(req);
        const files = (body.files as IncomingFilePayload[]) ?? [];
        sendJson(res, 200, manager.validateIncomingFiles(files));
        return;
      }

      if (method === 'POST' && pathname === '/api/unpack-zip') {
        const body = await readJsonBody(req);
        const files = (body.files as IncomingFilePayload[]) ?? [];
        sendJson(res, 200, manager.unpackZipFiles(files));
        return;
      }

      if (method === 'POST' && pathname === '/api/repair-install') {
        const body = await readJsonBody(req);
        const appId = String(body.appId ?? '');
        const options = body.options as { restartSteam?: boolean } | undefined;
        sendJson(res, 200, await manager.repairGameInstall(appId, options));
        return;
      }

      if (method === 'POST' && pathname === '/api/import') {
        const body = await readJsonBody(req);
        const files = (body.files as IncomingFilePayload[]) ?? [];
        const options = body.options as
          | { allowReplaceDuplicates?: boolean; syncLuaDirectives?: boolean }
          | undefined;
        sendJson(res, 200, manager.importFiles(files, options));
        return;
      }

      if (method === 'POST' && pathname === '/api/associate') {
        const body = await readJsonBody(req);
        const filePath = String(body.filePath ?? '');
        const appId = String(body.appId ?? '');
        sendJson(res, 200, manager.associateManifest(filePath, appId));
        return;
      }

      if (method === 'POST' && pathname === '/api/delete-manifest') {
        const body = await readJsonBody(req);
        const filePath = String(body.filePath ?? '');
        sendJson(res, 200, manager.deleteManifest(filePath));
        return;
      }

      if (method === 'POST' && pathname === '/api/restore-backup') {
        const body = await readJsonBody(req);
        const backupId = String(body.backupId ?? '');
        sendJson(res, 200, manager.restoreBackup(backupId));
        return;
      }

      if (method === 'POST' && pathname === '/api/inspect-manifest') {
        const body = await readJsonBody(req);
        const filePath = String(body.filePath ?? '');
        sendJson(res, 200, manager.inspectManifest(filePath));
        return;
      }

      if (method === 'POST' && pathname === '/api/games/manual') {
        const body = await readJsonBody(req);
        const appId = String(body.appId ?? '');
        const customName =
          typeof body.customName === 'string' ? body.customName : undefined;
        sendJson(res, 200, manager.addManualGame(appId, customName));
        return;
      }

      if (method === 'DELETE' && pathname === '/api/games/manual') {
        const body = await readJsonBody(req);
        const appId = String(body.appId ?? '');
        sendJson(res, 200, manager.removeManualGame(appId));
        return;
      }

      if (method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        sendJson(
          res,
          200,
          manager.updateSettings(body as Partial<LunexSettings>)
        );
        return;
      }

      if (method === 'POST' && pathname === '/api/operations/clear') {
        sendJson(res, 200, manager.clearOperations());
        return;
      }

      if (method === 'GET' && pathname === '/api/sample-files') {
        const bg3Lua = `-- Baldur's Gate 3 (1086940) SteamTools Manifest
addappid(1086940)
addappid(1086941, 1, "7b19c4d2e8f0a312948576abcd12ef34567890abcdef1234567890abcdef1234")
setManifestid(1086941, "5512901928374651092", 0)
`;
        const bg3Manifest = buildValidDepotManifestBuffer(
          '1086941',
          '5512901928374651092'
        );
        const updatedCyberpunkLua = `-- Cyberpunk 2077 (1091500) Updated Patch v2.21 Manifest
addappid(1091500)
addappid(1091501, 1, "8f3c4a1290e7b451c209de78a12b49087712fa980c41e2b39d08112ac76e4501")
setManifestid(1091501, "9940129384756102938", 0)
addappid(2138330, 1, "5a9120bc78d4ef0192837465ab98cd1209ef4321ab76cd908123ef4567ab8901")
setManifestid(2138330, "4910293847561029384", 0)
`;
        const corruptedManifest = Buffer.from(
          '<!DOCTYPE html><html><body>404 Not Found</body></html>',
          'utf8'
        );

        const samples: { label: string; description: string; files: IncomingFilePayload[] }[] = [
          {
            label: "Baldur's Gate 3 Bundle (.lua + .manifest)",
            description: 'Valid new AppID 1086940 Lua script + binary depot manifest',
            files: [
              {
                fileName: '1086940.lua',
                base64Content: Buffer.from(bg3Lua, 'utf8').toString('base64'),
              },
              {
                fileName: '1086941_5512901928374651092.manifest',
                base64Content: bg3Manifest.toString('base64'),
              },
            ],
          },
          {
            label: 'Update Existing 1091500.lua (Triggers Backup)',
            description: 'Replaces Cyberpunk 2077 Lua manifest and creates automatic backup',
            files: [
              {
                fileName: '1091500.lua',
                base64Content: Buffer.from(updatedCyberpunkLua, 'utf8').toString(
                  'base64'
                ),
              },
            ],
          },
          {
            label: 'Corrupted .manifest Test (Validation Reject)',
            description: 'Tests pre-import header validation & failed operation logging',
            files: [
              {
                fileName: '999999_1234567890.manifest',
                base64Content: corruptedManifest.toString('base64'),
              },
            ],
          },
        ];

        sendJson(res, 200, { samples });
        return;
      }

      sendJson(res, 404, { error: `Unknown API endpoint: ${pathname}` });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      sendJson(res, 400, { error: message });
    }
  };

  return {
    name: 'lunex-api-plugin',
    configureServer(server) {
      server.middlewares.use(handleApiRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleApiRequest);
    },
  };
}
