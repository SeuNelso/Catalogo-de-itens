async function logStockMovimento({
  db,
  tipo,
  itemId,
  armazemId,
  localizacao,
  lote,
  serialnumber,
  quantidade,
  requisicaoId,
  requisicaoItemId,
  caixaId,
  usuarioId,
  payload,
}) {
  if (!db) throw new Error('logStockMovimento: db é obrigatório');
  await db.query(
    `INSERT INTO stock_movimentos_auditoria
     (tipo, item_id, armazem_id, localizacao, lote, serialnumber, quantidade, requisicao_id, requisicao_item_id, caixa_id, usuario_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      tipo,
      itemId || null,
      armazemId || null,
      localizacao || null,
      lote || null,
      serialnumber || null,
      quantidade ?? null,
      requisicaoId || null,
      requisicaoItemId || null,
      caixaId || null,
      usuarioId || null,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

module.exports = { logStockMovimento };
