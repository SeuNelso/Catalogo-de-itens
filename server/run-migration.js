/**
 * Executa uma migração SQL (usa o .env do server = mesma BD da aplicação).
 * Uso:
 *   node server/run-migration.js                    → migração de preparação (requisicoes_itens)
 *   node server/run-migration.js separacao-confirmada → migração de confirmação de separação
 *   npm run db:migrate                              → preparação
 *   npm run db:migrate:separacao                    → confirmação de separação
 *   npm run db:migrate:em-separacao                 → status EM SEPARACAO (separação em curso)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
// Mesma resolução de DATABASE_URL / DATABASE_URL_RAILWAY / SSL que server/db/pool.js
const { pool, getConnectionTargetInfo } = require('./db/pool');
const { ensureSchemaMigrationsTable, recordSchemaMigration } = require('./utils/schemaMigrationsLog');

const arg = process.argv[2];
const migrationFile = path.join(
  __dirname,
  arg === 'separacao-confirmada'
    ? 'migrate-requisicoes-separacao-confirmada.sql'
    : arg === 'status-fases'
      ? 'migrate-requisicoes-status-fases.sql'
      : arg === 'status-finalizado'
        ? 'migrate-requisicoes-status-finalizado.sql'
      : arg === 'tra-gerada'
        ? 'migrate-requisicoes-tra-gerada.sql'
      : arg === 'preparacao-confirmada'
        ? 'migrate-requisicoes-itens-preparacao-confirmada.sql'
        : arg === 'armazens-tipo'
          ? 'migrate-armazens-tipo-central-viatura.sql'
          : arg === 'lote'
            ? 'migrate-requisicoes-itens-lote.sql'
            : arg === 'serial'
              ? 'migrate-requisicoes-itens-serial.sql'
              : arg === 'bobinas'
                ? 'migrate-requisicoes-itens-bobinas.sql'
                : arg === 'usuarios-requisicoes-armazem-origem'
                  ? 'migrate-usuarios-requisicoes-armazem-origem.sql'
                  : arg === 'usuarios-dados-pessoais'
                    ? 'migrate-usuarios-dados-pessoais.sql'
                  : arg === 'usuarios-timestamps'
                    ? 'migrate-usuarios-timestamps.sql'
                  : arg === 'catalog-timestamps'
                    ? 'migrate-catalog-timestamps.sql'
                  : arg === 'performance-indexes'
                    ? 'migrate-performance-indexes.sql'
                  : arg === 'itens-trgm'
                    ? 'migrate-itens-search-trgm.sql'
                  : arg === 'requisicoes-separador' || arg === 'separador-preparacao'
                    ? 'migrate-requisicoes-separador-usuario.sql'
                  : arg === 'em-separacao' || arg === 'status-em-separacao'
                    ? 'migrate-requisicoes-status-em-separacao.sql'
                  : arg === 'itens-nao-cadastrados' || arg === 'itens-nao-cadastrados-columns'
                    ? 'migrate-itens-nao-cadastrados-columns.sql'
                    : arg === 'requisicoes-devolucao-docs' || arg === 'devolucao-docs'
                      ? 'migrate-requisicoes-devolucao-docs.sql'
                      : arg === 'requisicoes-devolucao-transferencias-pendentes' || arg === 'devolucao-transferencias-pendentes'
                        ? 'migrate-requisicoes-devolucao-transferencias-pendentes.sql'
                      : arg === 'status-apeados'
                        ? 'migrate-requisicoes-status-apeados.sql'
                        : arg === 'requisicoes-itens-quantidade-apeados'
                          ? 'migrate-requisicoes-itens-quantidade-apeados.sql'
                      : arg === 'integrations-v1' || arg === 'integracoes-v1'
                        ? 'migrate-integrations-v1.sql'
                      : arg === 'localizacao-estoque' || arg === 'armazens-localizacao-item'
                        ? 'migrate-armazens-localizacao-item.sql'
                      : arg === 'usuarios-pode-controlo-stock' || arg === 'pode-controlo-stock'
                        ? 'migrate-usuarios-pode-controlo-stock.sql'
                      : arg === 'movimentacao-interna' || arg === 'armazem-movimentacao-interna'
                        ? 'migrate-armazem-movimentacao-interna.sql'
                      : arg === 'requisicoes-trfl-tra-estoque' || arg === 'trfl-tra-estoque'
                        ? 'migrate-requisicoes-trfl-tra-estoque.sql'
                      : 'migrate-requisicoes-itens-preparacao.sql'
);

async function run() {
  let client;
  try {
    const t = getConnectionTargetInfo();
    console.log(
      `[MIGRATE] Destino: host=${t.host} port=${t.port} database=${t.database} ` +
        '(definido por DATABASE_URL; DATABASE_URL_RAILWAY só é usada se DATABASE_URL estiver vazio e DB_* forem placeholders.)'
    );
    client = await pool.connect();
    await ensureSchemaMigrationsTable(client);

    const sql = fs.readFileSync(migrationFile, 'utf8');
    // Remove comentários de linha (-- ...) e divide por ; para executar cada comando
    const statements = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      if (statement) {
        await client.query(statement + ';');
        console.log('OK:', statement.substring(0, 60) + '...');
      }
    }
    try {
      await recordSchemaMigration(client, {
        migrationArg: arg || 'default',
        migrationFile,
      });
      console.log('Migração concluída com sucesso (registada em schema_migrations).');
    } catch (logErr) {
      console.warn(
        'AVISO: migração SQL executada, mas falhou o registo em schema_migrations:',
        logErr.message
      );
      console.log('Migração concluída com sucesso.');
    }
  } catch (e) {
    console.error('Erro na migração:', e.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run();
