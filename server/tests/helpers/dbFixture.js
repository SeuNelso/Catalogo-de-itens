const { loadTestEnv } = require('./loadTestEnv');

loadTestEnv();

const { pool } = require('../../db/pool');

async function tableExists(client, tableName) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName]
  );
  return r.rows.length > 0;
}

async function requireStockTables(client) {
  const ok = await tableExists(client, 'stock_lote');
  if (!ok) {
    const err = new Error('Tabela stock_lote em falta. Execute as migrações de stock rastreável.');
    err.code = 'TEST_SKIP_SCHEMA';
    throw err;
  }
}

/**
 * Cenário mínimo: central origem/destino, item LOTE, stock_lote, requisição pendente.
 * Usar dentro de transação com ROLLBACK após o teste.
 */
async function seedLotePreparacaoScenario(client) {
  const tag = `T${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const armOrig = await client.query(
    `INSERT INTO armazens (codigo, descricao, tipo, ativo)
     VALUES ($1, $2, 'central', true)
     RETURNING id`,
    [`${tag}-O`, `Test origem ${tag}`]
  );
  const armDest = await client.query(
    `INSERT INTO armazens (codigo, descricao, tipo, ativo)
     VALUES ($1, $2, 'central', true)
     RETURNING id`,
    [`${tag}-D`, `Test destino ${tag}`]
  );
  const armOrigemId = armOrig.rows[0].id;
  const armDestinoId = armDest.rows[0].id;
  const loc = `LOC.${tag}`;

  try {
    await client.query(
      `UPDATE armazens SET compartilha_stock_serial = true WHERE id = $1`,
      [armOrigemId]
    );
  } catch (_) {
    /* coluna opcional */
  }

  const itemDesc = `Item teste lote ${tag}`;
  const item = await client.query(
    `INSERT INTO itens (
       codigo, nome, descricao, categoria, tipocontrolo, ativo, quantidade, preco
     )
     VALUES ($1, $2, $2, 'TESTE', 'LOTE', true, 0, 0)
     RETURNING id`,
    [`ITEM-${tag}`, itemDesc]
  );
  const itemId = item.rows[0].id;

  await client.query(
    `INSERT INTO stock_lote (item_id, armazem_id, localizacao, lote, quantidade_disponivel, quantidade_reservada)
     VALUES ($1, $2, $3, $4, 100, 0)`,
    [itemId, armOrigemId, loc, `LOTE-${tag}`]
  );

  const req = await client.query(
    `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
     VALUES ($1, $2, $3, NULL, 'pendente')
     RETURNING id`,
    [armOrigemId, armDestinoId, `Test requisicao ${tag}`]
  );
  const requisicaoId = req.rows[0].id;

  const ri = await client.query(
    `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
     VALUES ($1, $2, 1)
     RETURNING id`,
    [requisicaoId, itemId]
  );

  return {
    tag,
    armOrigemId,
    armDestinoId,
    itemId,
    loc,
    lote: `LOTE-${tag}`,
    requisicaoId,
    requisicaoItemId: ri.rows[0].id,
  };
}

async function getStockLoteRow(client, { itemId, armazemId, localizacao, lote }) {
  const r = await client.query(
    `SELECT quantidade_disponivel, quantidade_reservada
     FROM stock_lote
     WHERE item_id = $1 AND armazem_id = $2
       AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
       AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
    [itemId, armazemId, localizacao, lote]
  );
  return r.rows[0] || null;
}

async function cleanupLotePreparacaoScenario(client, fx) {
  if (!fx?.requisicaoId) return;
  try {
    await client.query('DELETE FROM requisicoes_itens_bobinas WHERE requisicao_item_id = $1', [
      fx.requisicaoItemId,
    ]);
  } catch (_) {
    /* tabela opcional */
  }
  try {
    await client.query('DELETE FROM stock_movimentos_auditoria WHERE requisicao_id = $1', [fx.requisicaoId]);
  } catch (_) {
    /* ignore */
  }
  await client.query('DELETE FROM requisicoes_itens WHERE requisicao_id = $1', [fx.requisicaoId]);
  await client.query('DELETE FROM requisicoes WHERE id = $1', [fx.requisicaoId]);
  await client.query('DELETE FROM stock_lote WHERE item_id = $1', [fx.itemId]);
  await client.query('DELETE FROM itens WHERE id = $1', [fx.itemId]);
  await client.query('DELETE FROM armazens WHERE id = ANY($1::int[])', [
    [fx.armOrigemId, fx.armDestinoId],
  ]);
}

module.exports = {
  pool,
  tableExists,
  requireStockTables,
  seedLotePreparacaoScenario,
  getStockLoteRow,
  cleanupLotePreparacaoScenario,
};
