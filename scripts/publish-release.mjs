import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const ref = process.env.GITHUB_REF || '';
const refName = process.env.GITHUB_REF_NAME || '';
const tag = ref.startsWith('refs/tags/v') ? refName : `v${pkg.version}`;

const releaseDir = path.resolve('release', pkg.version);
const exeFiles = fs
  .readdirSync(releaseDir)
  .filter(
    (name) =>
      name.toLowerCase().endsWith('.exe') &&
      !name.toLowerCase().includes('uninstaller')
  )
  .map((name) => path.join(releaseDir, name));

if (exeFiles.length === 0) {
  console.error('No .exe files found to attach to release.');
  process.exit(1);
}

let releaseExists = false;
try {
  execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' });
  releaseExists = true;
} catch {
  releaseExists = false;
}

if (releaseExists) {
  execFileSync('gh', ['release', 'upload', tag, ...exeFiles, '--clobber'], {
    stdio: 'inherit',
  });
} else {
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      ...exeFiles,
      '--title',
      `Lunex ${tag}`,
      '--generate-notes',
    ],
    { stdio: 'inherit' }
  );
}
