const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const extensionDir = path.join(root, 'extension');
const outputDir = path.join(root, 'dist');
const archive = path.join(outputDir, 'product-owner-ai-chrome.zip');
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-owner-ai-extension-'));
fs.cpSync(extensionDir, stagingDir, { recursive: true });

const manifestPath = path.join(stagingDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = manifest.host_permissions.filter((permission) => !permission.startsWith('http://localhost'));
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(archive, { force: true });
execFileSync('zip', ['-r', '-q', archive, '.'], { cwd: stagingDir });
fs.rmSync(stagingDir, { recursive: true, force: true });
console.log(`Created ${path.relative(root, archive)}`);
