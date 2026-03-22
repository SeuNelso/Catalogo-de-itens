const { Pool } = require('pg');

const pgPoolMax = Math.min(100, Math.max(2, parseInt(process.env.PGPOOL_MAX || '25', 10)));

function resolvePgSsl(connectionString) {
  if (process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL === '1') {
    return { rejectUnauthorized: false };
  }
  if (process.env.NODE_ENV === 'production') {
    return { rejectUnauthorized: false };
  }
  const m = connectionString && String(connectionString).match(/@([^/:?]+)/);
  const host = (m && m[1]) || process.env.DB_HOST || '';
  const local =
    !host
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1';
  return local ? false : { rejectUnauthorized: false };
}

const rawDatabaseUrl = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
const rawRailwayUrl =
  process.env.DATABASE_URL_RAILWAY && String(process.env.DATABASE_URL_RAILWAY).trim();
const envLooksLikeTemplate =
  process.env.DB_USER === 'seu_usuario' || process.env.DB_PASSWORD === 'sua_senha';

let connectionString = rawDatabaseUrl;
if (!connectionString && rawRailwayUrl && envLooksLikeTemplate) {
  console.warn(
    '[CONFIG] DATABASE_URL vazio — a usar DATABASE_URL_RAILWAY para ligar ao Postgres. ' +
    'Copie essa URL para DATABASE_URL em server/.env para ficar explícito.'
  );
  connectionString = rawRailwayUrl;
}
if (!connectionString) {
  connectionString = `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
}

const pool = new Pool({
  connectionString,
  ssl: resolvePgSsl(connectionString),
  max: pgPoolMax,
  idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONN_TIMEOUT_MS || '10000', 10),
});

/** Host e nome da base (sem password) — útil para scripts e migrações. */
function getConnectionTargetInfo() {
  try {
    const s = String(connectionString).replace(/^postgres(ql)?:/i, 'postgres:');
    const u = new URL(s);
    const db = decodeURIComponent((u.pathname || '/').replace(/^\//, '').split('/')[0] || '');
    return {
      host: u.hostname,
      port: u.port || '5432',
      database: db || '(default)',
    };
  } catch (_) {
    return { host: '(erro ao ler URL)', database: '(erro ao ler URL)', port: '' };
  }
}

module.exports = { pool, pgPoolMax, getConnectionTargetInfo };
