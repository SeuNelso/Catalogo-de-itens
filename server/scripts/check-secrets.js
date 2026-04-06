const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const suspiciousPatterns = [
  /AKIA[0-9A-Z]{16}/g,
  /^\s*[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\b\s*[:=]\s*['"][^'"\n]{20,}['"]/gm,
  /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/g,
];

const ignoreDirs = new Set([
  '.git',
  'node_modules',
  'client/node_modules',
  'build',
  'client/build',
  '.cursor',
]);

const ignoreFiles = new Set([
  '.env',
  'server/.env',
  'package-lock.json',
  'client/package-lock.json',
  'THIRD_PARTY_LICENSE_INVENTORY.csv',
]);

function walk(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (ignoreDirs.has(rel) || ignoreDirs.has(entry.name)) continue;
      walk(abs, results);
      continue;
    }

    if (ignoreFiles.has(rel) || ignoreFiles.has(entry.name)) continue;
    results.push({ abs, rel });
  }
  return results;
}

function isTextLike(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [
    '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.csv', '.yml', '.yaml', '.env',
    '.sql', '.html', '.css', '.sh', '.bat', '.ps1', '.conf', '.xml'
  ].includes(ext) || ext === '';
}

function main() {
  const files = walk(root).filter((f) => isTextLike(f.abs));
  const findings = [];

  for (const f of files) {
    let content = '';
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch (_) {
      continue;
    }

    for (const pattern of suspiciousPatterns) {
      pattern.lastIndex = 0;
      const m = pattern.exec(content);
      if (m) {
        findings.push({ file: f.rel, snippet: m[0].slice(0, 120) });
        break;
      }
    }
  }

  if (findings.length) {
    console.error('[compliance] POSSIVEIS SEGREDOS ENCONTRADOS:');
    findings.forEach((x) => console.error(`- ${x.file}: ${x.snippet}`));
    process.exit(1);
  }

  console.log('[compliance] nenhum segredo suspeito encontrado nos arquivos verificados.');
}

main();
