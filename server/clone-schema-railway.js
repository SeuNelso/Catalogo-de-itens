/**
 * Copia só a estrutura (schema) de um Postgres para outro — sem dados.
 * Usa pg_dump e psql (cliente PostgreSQL no PATH).
 *
 * No server/.env:
 *   DATABASE_URL              → destino (base vazia de teste)
 *   DATABASE_URL_SCHEMA_SOURCE ou DATABASE_URL_RAILWAY → origem (ex.: produção)
 *
 * Uso: npm run db:clone-schema
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * No Windows o Cursor/IDE e o npm muitas vezes não herdam o PATH onde o PostgreSQL foi adicionado.
 * Procura: variável de ambiente, `where`, pastas típicas em Program Files.
 */
function resolvePostgresExecutable(name) {
  const envMap = { pg_dump: 'PG_DUMP_PATH', psql: 'PSQL_PATH' };
  const fromEnv = process.env[envMap[name]];
  if (fromEnv && fs.existsSync(fromEnv.trim())) {
    return fromEnv.trim();
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'where.exe',
        [name],
        { encoding: 'utf8', windowsHide: true }
      );
      const first = out
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.toLowerCase().includes('information'));
      if (first && fs.existsSync(first)) return first;
    } catch (_) {
      /* não está no PATH deste processo */
    }

    const exe = `${name}.exe`;
    const roots = [
      process.env['ProgramFiles'] || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    ];
    const candidates = [];
    for (const root of roots) {
      const pgRoot = path.join(root, 'PostgreSQL');
      if (!fs.existsSync(pgRoot)) continue;
      for (const dir of fs.readdirSync(pgRoot)) {
        const full = path.join(pgRoot, dir, 'bin', exe);
        if (fs.existsSync(full)) {
          const m = String(dir).match(/^(\d+)/);
          const major = m ? parseInt(m[1], 10) : 0;
          candidates.push({ major, full });
        }
      }
    }
    candidates.sort((a, b) => b.major - a.major);
    if (candidates.length) return candidates[0].full;
  } else {
    try {
      const out = execFileSync('which', [name], { encoding: 'utf8' });
      const p = out.trim().split('\n')[0];
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      /* ignore */
    }
  }

  return name;
}

function trimUrl(u) {
  return u && String(u).trim();
}

const targetUrl = trimUrl(process.env.DATABASE_URL);
const sourceUrl =
  trimUrl(process.env.DATABASE_URL_SCHEMA_SOURCE) ||
  trimUrl(process.env.DATABASE_URL_RAILWAY);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!targetUrl) {
  fail(
    'Defina DATABASE_URL no server/.env com a connection string do Postgres de destino (teste, vazio).'
  );
}
if (!sourceUrl) {
  fail(
    'Defina DATABASE_URL_SCHEMA_SOURCE ou DATABASE_URL_RAILWAY com a URL do Postgres de origem (ex.: produção).'
  );
}
if (sourceUrl === targetUrl) {
  fail('Origem e destino são iguais. Use uma DATABASE_URL de destino diferente da origem.');
}

function pipeSchema(pgDumpPath, psqlPath) {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      pgDumpPath,
      ['--schema-only', '--no-owner', '--no-acl', sourceUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const restore = spawn(psqlPath, [targetUrl], { stdio: ['pipe', 'pipe', 'pipe'] });

    let dumpErr = '';
    let restoreErr = '';
    dump.stderr.on('data', (d) => {
      dumpErr += d.toString();
    });
    restore.stderr.on('data', (d) => {
      restoreErr += d.toString();
    });

    dump.stdout.pipe(restore.stdin);

    dump.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `Não foi possível executar pg_dump em "${pgDumpPath}". ` +
              'Defina PG_DUMP_PATH no server/.env com o caminho completo (ex.: C:\\\\Program Files\\\\PostgreSQL\\\\16\\\\bin\\\\pg_dump.exe).'
          )
        );
      } else {
        reject(err);
      }
    });
    restore.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `Não foi possível executar psql em "${psqlPath}". ` +
              'Defina PSQL_PATH no server/.env com o caminho completo ao psql.exe.'
          )
        );
      } else {
        reject(err);
      }
    });

    let dumpExit = null;
    let restoreExit = null;

    function maybeDone() {
      if (dumpExit === null || restoreExit === null) return;
      if (dumpExit !== 0) {
        reject(new Error(`pg_dump falhou (código ${dumpExit}).\n${dumpErr}`));
        return;
      }
      if (restoreExit !== 0) {
        reject(new Error(`psql falhou (código ${restoreExit}).\n${restoreErr || dumpErr}`));
        return;
      }
      resolve();
    }

    dump.on('close', (code) => {
      dumpExit = code;
      maybeDone();
    });
    restore.on('close', (code) => {
      restoreExit = code;
      maybeDone();
    });
  });
}

async function main() {
  const pgDumpPath = resolvePostgresExecutable('pg_dump');
  const psqlPath = resolvePostgresExecutable('psql');
  if (pgDumpPath === 'pg_dump' || !fs.existsSync(pgDumpPath)) {
    fail(
      'pg_dump não encontrado. Instale o cliente PostgreSQL ou defina PG_DUMP_PATH no server/.env ' +
        '(caminho completo para pg_dump.exe no Windows).'
    );
  }
  if (psqlPath === 'psql' || !fs.existsSync(psqlPath)) {
    fail(
      'psql não encontrado. Instale o cliente PostgreSQL ou defina PSQL_PATH no server/.env ' +
        '(caminho completo para psql.exe no Windows).'
    );
  }
  console.log(`Usando: ${pgDumpPath}`);
  console.log(`Usando: ${psqlPath}`);

  console.log('A copiar schema (sem dados) da origem para o destino…');
  console.log(
    'Nota: use um Postgres de destino vazio; se já tiver tabelas (ex.: db:init), o restore pode falhar.'
  );
  await pipeSchema(pgDumpPath, psqlPath);
  console.log('Concluído. O destino deve refletir a estrutura da origem.');
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
