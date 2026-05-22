async function confirmarSeparacao(pool, requisicaoId) {
  await pool.query(
    `UPDATE requisicoes
     SET separacao_confirmada = true,
         separacao_confirmada_em = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [requisicaoId]
  );
  const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [requisicaoId]);
  return updated.rows[0];
}

async function completarSeparacao(pool, { requisicaoId, hasRecebimentoMarker }) {
  const check = await pool.query(
    `SELECT id, status, observacoes FROM requisicoes WHERE id = $1`,
    [requisicaoId]
  );
  if (!check.rows.length) {
    const err = new Error('Requisição não encontrada');
    err.status = 404;
    throw err;
  }
  const row = check.rows[0];
  if (!['pendente', 'EM SEPARACAO'].includes(row.status)) {
    const err = new Error(
      'Só pode completar a separação quando a requisição está pendente ou em separação e todos os itens foram preparados.'
    );
    err.status = 400;
    throw err;
  }
  let itens;
  try {
    itens = await pool.query(
      'SELECT preparacao_confirmada FROM requisicoes_itens WHERE requisicao_id = $1',
      [requisicaoId]
    );
  } catch (qErr) {
    if (qErr.code === '42703') {
      const err = new Error(
        'É obrigatório confirmar a preparação de cada item (incl. 0 quando não houver stock).'
      );
      err.status = 503;
      err.details = 'Execute a migração: server/Migrate/migrate-requisicoes-itens-preparacao-confirmada.sql';
      throw err;
    }
    throw qErr;
  }
  const allConfirmed =
    itens.rows.length > 0 && itens.rows.every((r) => r.preparacao_confirmada === true);
  if (!allConfirmed) {
    const err = new Error(
      'Confirme a preparação de todos os itens antes de completar a separação (inclua 0 na quantidade quando não tiver o item).'
    );
    err.status = 400;
    throw err;
  }
  const ehRecebimentoTransfer = typeof hasRecebimentoMarker === 'function' && hasRecebimentoMarker(row);
  const nextStatus = ehRecebimentoTransfer ? 'EM EXPEDICAO' : 'separado';
  await pool.query(
    'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [nextStatus, requisicaoId]
  );
  return { nextStatus };
}

module.exports = {
  confirmarSeparacao,
  completarSeparacao,
};
