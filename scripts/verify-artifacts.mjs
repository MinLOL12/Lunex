import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const releaseVersionDir = path.resolve('release', pkg.version);

if (!fs.existsSync(releaseVersionDir)) {
  console.error(`Expected output directory not found: ${releaseVersionDir}`);
  if (fs.existsSync('release')) {
    console.error('Contents of release/:', fs.readdirSync('release'));
  }
  process.exit(1);
}

const entries = fs.readdirSync(releaseVersionDir, { withFileTypes: true });
const exeFiles = entries
  .filter(
    (e) =>
      e.isFile() &&
      e.name.toLowerCase().endsWith('.exe') &&
      !e.name.toLowerCase().includes('uninstaller')
  )
  .map((e) => path.join(releaseVersionDir, e.name));

if (exeFiles.length === 0) {
  console.error(`No .exe installers found in ${releaseVersionDir}`);
  console.error(
    'Directory entries:',
    entries.map((e) => e.name)
  );
  process.exit(1);
}

const summaryLines = [
  '### Packaged Windows Executables',
  '',
  '| File | Size (MB) | SHA-256 |',
  '| --- | --- | --- |',
];

for (const fullPath of exeFiles) {
  const stat = fs.statSync(fullPath);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(fullPath))
    .digest('hex');
  const name = path.basename(fullPath);
  console.log(`Verified: ${name} (${sizeMb} MB) sha256:${sha256}`);
  summaryLines.push(`| \`${name}\` | ${sizeMb} MB | \`${sha256}\` |`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    summaryLines.join('\n') + '\n',
    'utf8'
  );
}
