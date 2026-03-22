/**
 * Histórico de migrações SQL corridas via `node server/run-migration.js`.
 * Permite saber o que foi aplicado no db:dev para repetir na produção (mesmos comandos, DATABASE_URL da prod).
 */
const path = require('path');

const DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  migration_arg TEXT,
  migration_file TEXT NOT NULL,
  env_label TEXT
);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations (applied_at ASC);
`;

async function ensureSchemaMigrationsTable(client) {
  await client.query(DDL);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ migrationArg: string|null, migrationFile: string }} opts
 */
async function recordSchemaMigration(client, opts) {
  const migrationArg = opts.migrationArg != null ? String(opts.migrationArg) : null;
  const fileBase = path.basename(opts.migrationFile);
  const envLabel =
    process.env.MIGRATION_ENV != null && String(process.env.MIGRATION_ENV).trim()
      ? String(process.env.MIGRATION_ENV).trim()
      : process.env.MIGRATION_LABEL != null && String(process.env.MIGRATION_LABEL).trim()
        ? String(process.env.MIGRATION_LABEL).trim()
        : null;

  await client.query(
    `INSERT INTO schema_migrations (migration_arg, migration_file, env_label)
     VALUES ($1, $2, $3)`,
    [migrationArg, fileBase, envLabel]
  );
}

module.exports = {
  ensureSchemaMigrationsTable,
  recordSchemaMigration,
};
