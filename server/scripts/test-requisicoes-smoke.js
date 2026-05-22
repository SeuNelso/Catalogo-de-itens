const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '../..');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

run('npm', ['run', 'test:unit']);
run('npm', ['run', 'test:integration']);
run(
  process.execPath,
  ['--test', path.join(root, 'server/tests/integration/requisicoesCrudDocumentosSmoke.test.js')],
  { shell: false }
);
console.log('✅ Smoke requisições (unit + integration + HTTP CRUD/docs) concluído.');
