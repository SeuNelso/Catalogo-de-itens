const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadTestEnv } = require('../tests/helpers/loadTestEnv');

loadTestEnv();

const testDb = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!testDb) {
  console.warn(
    '[test:integration] TEST_DATABASE_URL não definido — testes de integração ignorados.'
  );
  process.exit(0);
}

const integrationDir = path.join(__dirname, '../tests/integration');
const files = fs
  .readdirSync(integrationDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(integrationDir, f));

if (!files.length) {
  console.warn('[test:integration] Nenhum ficheiro de teste encontrado.');
  process.exit(0);
}

const r = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '../..'),
});
process.exit(r.status === null ? 1 : r.status);
