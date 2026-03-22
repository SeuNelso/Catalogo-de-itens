/**
 * Lista migrações registadas na base actual (server/.env → DATABASE_URL).
 * Uso: npm run db:migrations:history
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool, getConnectionTargetInfo } = require('../db/pool');

async function main() {
  const t = getConnectionTargetInfo();
  console.log(`Histórico de migrações — host=${t.host} database=${t.database}\n`);

  try {
    const r = await pool.query(`
      SELECT id, applied_at, migration_arg, migration_file, env_label
      FROM schema_migrations
      ORDER BY applied_at ASC, id ASC
    `);
    if (r.rows.length === 0) {
      console.log('(Nenhum registo. A tabela existe após a primeira migração com sucesso.)');
    } else {
      console.table(r.rows);
      console.log(`\nTotal: ${r.rows.length} registo(s).`);
    }
  } catch (e) {
    if (e.code === '42P01') {
      console.error(
        'Tabela schema_migrations ainda não existe. Corra uma migração: npm run db:migrate:...'
      );
    } else {
      console.error('Erro:', e.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
