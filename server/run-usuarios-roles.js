/**
 * Atualiza o constraint da coluna role em usuarios para aceitar os novos perfis.
 * Usa o mesmo pool que a API (server/db/pool.js → DATABASE_URL).
 *
 * Importante no Railway: execute com a URL **direta** do Postgres (porta 5432), não a URL
 * do **pooler** (ex. porta 6543 / host *pooler*). O pooler pode falhar em DDL ou em
 * várias instruções num único round-trip — este script corre cada instrução à parte.
 *
 * Uso: npm run db:usuarios-roles
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { pool, getConnectionTargetInfo } = require('./db/pool');

/**
 * Divide o ficheiro SQL em instruções, mantendo o bloco DO $$ ... END $$; intacto.
 */
function splitMigrationSql(sql) {
  const withoutLineComments = sql.replace(/--[^\r\n]*/g, '');
  const stmts = [];
  const re = /DO\s+\$\$[\s\S]*?\nEND\s+\$\$\s*;/gi;
  let last = 0;
  let m;
  while ((m = re.exec(withoutLineComments)) !== null) {
    const before = withoutLineComments.slice(last, m.index);
    before
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => stmts.push(s));
    stmts.push(m[0].trim());
    last = re.lastIndex;
  }
  withoutLineComments
    .slice(last)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((s) => stmts.push(s));
  return stmts;
}

function warnIfPoolerUrl() {
  try {
    const raw =
      process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()
        ? process.env.DATABASE_URL
        : process.env.DATABASE_URL_RAILWAY && String(process.env.DATABASE_URL_RAILWAY).trim()
          ? process.env.DATABASE_URL_RAILWAY
          : '';
    if (!raw) return;
    const u = new URL(String(raw).replace(/^postgres(ql)?:/i, 'postgres:'));
    const port = u.port || '5432';
    const host = (u.hostname || '').toLowerCase();
    if (port === '6543' || host.includes('pooler') || host.includes('proxy')) {
      console.warn(
        '\n[AVISO] A DATABASE_URL parece ser do pooler (PgBouncer). ' +
          'Migrações DDL são mais fiáveis com a URL **direta** do Postgres (porta 5432). ' +
          'No Railway: plugin Postgres → Connect → copiar URL com host/porta do servidor, não "Pooled".\n'
      );
    }
  } catch (_) {}
}

async function run() {
  const t = getConnectionTargetInfo();
  console.log(
    `[db:usuarios-roles] Destino: host=${t.host} port=${t.port} database=${t.database}`
  );
  warnIfPoolerUrl();

  const sqlPath = path.join(__dirname, 'migrate-usuarios-roles-novos.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const statements = splitMigrationSql(sql);
  if (statements.length === 0) {
    console.error('Nenhuma instrução SQL encontrada em migrate-usuarios-roles-novos.sql');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      console.log(`  [${i + 1}/${statements.length}] ${stmt.slice(0, 72).replace(/\s+/g, ' ')}…`);
      await client.query(stmt);
    }
    await client.query('COMMIT');
    console.log(
      'Roles atualizados (incl. supervisor_armazem, backoffice_*, operador). ' +
        'Confirme em produção com: SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = \'public.usuarios\'::regclass AND conname = \'usuarios_role_check\';'
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
