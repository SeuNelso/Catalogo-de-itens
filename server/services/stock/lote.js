const { statusStockLoteFromQuantidades, SQL_STOCK_LOTE_STATUS, STOCK_STATUS } = require('./loteStatus');

function makeStockPrepBizError(status, error, code, extra = {}) {
  const err = new Error(error);
  err.isStockPrepBiz = true;
  err.status = status;
  err.payload = { error, ...(code ? { code } : {}), ...extra };
  return err;
}

async function reservarMetros(db, logMovimento, opts) {
  const {
    itemId,
    armazemId,
    localizacao,
    lote,
    metros,
    requisicaoId,
    requisicaoItemId,
    usuarioId,
    origem = 'atender-item',
  } = opts;
  const loteB = String(lote || '').trim();
  const qtd = Number(metros) || 0;
  if (!loteB || qtd <= 0) return;
  const reserva = await db.query(
    `UPDATE stock_lote
     SET quantidade_disponivel = quantidade_disponivel - $5,
         quantidade_reservada = quantidade_reservada + $5,
         atualizado_em = CURRENT_TIMESTAMP
     WHERE item_id = $1
       AND armazem_id = $2
       AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
       AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))
       AND quantidade_disponivel >= $5
     RETURNING id`,
    [itemId, armazemId, localizacao, loteB, qtd]
  );
  if (!reserva.rows.length) {
    throw makeStockPrepBizError(
      400,
      `Lote ${loteB} sem saldo disponível suficiente para reservar ${qtd}.`
    );
  }
  if (typeof logMovimento === 'function') {
    await logMovimento({
      db,
      tipo: 'reserva_lote_preparacao',
      itemId,
      armazemId,
      localizacao,
      lote: loteB,
      quantidade: qtd,
      requisicaoId,
      requisicaoItemId,
      usuarioId,
      payload: { origem },
    });
  }
}

async function liberarMetrosPorRequisicaoItem(db, logMovimento, opts) {
  const { requisicaoItemId, usuarioId = null, origem = 'desconhecida' } = opts;
  const antigas = await db.query(
    `SELECT b.lote, b.metros, ri.item_id, ri.localizacao_origem, r.armazem_origem_id
     FROM requisicoes_itens_bobinas b
     INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
     INNER JOIN requisicoes r ON r.id = ri.requisicao_id
     WHERE b.requisicao_item_id = $1`,
    [requisicaoItemId]
  );
  for (const row of antigas.rows || []) {
    const metros = Number(row.metros) || 0;
    if (metros <= 0 || !row.lote || !row.localizacao_origem || !row.armazem_origem_id || !row.item_id) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `UPDATE stock_lote
       SET quantidade_disponivel = quantidade_disponivel + CASE WHEN quantidade_reservada >= $5 THEN $5 ELSE quantidade_reservada END,
           quantidade_reservada = CASE WHEN quantidade_reservada >= $5 THEN quantidade_reservada - $5 ELSE 0 END,
           atualizado_em = CURRENT_TIMESTAMP
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
      [row.item_id, row.armazem_origem_id, row.localizacao_origem, row.lote, metros]
    );
    if (typeof logMovimento === 'function') {
      // eslint-disable-next-line no-await-in-loop
      await logMovimento({
        db,
        tipo: 'libera_reserva_lote',
        itemId: row.item_id,
        armazemId: row.armazem_origem_id,
        localizacao: row.localizacao_origem,
        lote: row.lote,
        quantidade: metros,
        requisicaoItemId,
        usuarioId,
        payload: { origem },
      });
    }
  }
}

module.exports = {
  STOCK_STATUS,
  SQL_STOCK_LOTE_STATUS,
  statusStockLoteFromQuantidades,
  makeStockPrepBizError,
  reservarMetros,
  liberarMetrosPorRequisicaoItem,
};
