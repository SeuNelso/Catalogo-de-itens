const express = require('express');
const { logStockMovimento } = require('../../services/stock/auditoria');

function createPreparacaoStockRouter(deps) {
  const { pool, requisicaoAuth } = deps;
  const router = express.Router();

  router.post('/:id/itens/:requisicaoItemId/reservar-caixa', ...requisicaoAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const reqId = Number(req.params.id || 0);
      const reqItemId = Number(req.params.requisicaoItemId || 0);
      const codigoCaixa = String(req.body?.codigo_caixa || '').trim();
      if (!reqId || !reqItemId || !codigoCaixa) return res.status(400).json({ error: 'Parâmetros inválidos' });
      await client.query('BEGIN');
      const reqItem = await client.query(
        `SELECT ri.*, r.armazem_origem_id
         FROM requisicoes_itens ri
         INNER JOIN requisicoes r ON r.id = ri.requisicao_id
         WHERE ri.id = $1 AND ri.requisicao_id = $2
         FOR UPDATE`,
        [reqItemId, reqId]
      );
      if (!reqItem.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Item de requisição não encontrado' });
      }
      const itemRow = reqItem.rows[0];
      const caixa = await client.query('SELECT * FROM stock_caixas WHERE codigo_caixa = $1 FOR UPDATE', [codigoCaixa]);
      if (!caixa.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Caixa não encontrada' });
      }
      const c = caixa.rows[0];
      if (Number(c.item_id) !== Number(itemRow.item_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Caixa não pertence ao artigo desta linha.' });
      }
      if (Number(c.armazem_id) !== Number(itemRow.armazem_origem_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Caixa não pertence ao armazém de origem desta requisição.' });
      }
      // Libera reservas antigas desta linha para recalcular a partir da caixa escaneada.
      await client.query(
        `UPDATE stock_serial
         SET status = 'disponivel', requisicao_id = NULL, requisicao_item_id = NULL, reservado_em = NULL, atualizado_em = CURRENT_TIMESTAMP
         WHERE requisicao_item_id = $1 AND status = 'reservado'`,
        [reqItemId]
      );
      const serialRows = await client.query(
        `SELECT s.id, s.serialnumber, s.status
         FROM stock_caixa_seriais cs
         INNER JOIN stock_serial s ON s.id = cs.stock_serial_id
         WHERE cs.caixa_id = $1
         ORDER BY s.serialnumber
         FOR UPDATE`,
        [c.id]
      );
      const reservados = [];
      const invalidos = [];
      for (const sr of serialRows.rows || []) {
        if (String(sr.status) !== STOCK_STATUS.DISPONIVEL) {
          invalidos.push({ serialnumber: sr.serialnumber, motivo: `status ${sr.status}` });
          continue;
        }
        await client.query(
          `UPDATE stock_serial
           SET status = 'reservado',
               requisicao_id = $1,
               requisicao_item_id = $2,
               reservado_em = CURRENT_TIMESTAMP,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [reqId, reqItemId, sr.id]
        );
        reservados.push(sr.serialnumber);
      }
      await client.query(
        `UPDATE requisicoes_itens
         SET serialnumber = $1,
             quantidade_preparada = $2
         WHERE id = $3`,
        [reservados.join('\n'), reservados.length, reqItemId]
      );
      await logStockMovimento({
        db: client,
        tipo: 'reserva_caixa',
        itemId: itemRow.item_id,
        armazemId: itemRow.armazem_origem_id,
        localizacao: c.localizacao,
        quantidade: reservados.length,
        requisicaoId: reqId,
        requisicaoItemId: reqItemId,
        caixaId: c.id,
        usuarioId: req.user?.id || null,
        payload: { codigo_caixa: codigoCaixa, invalidos },
      });
      await client.query('COMMIT');
      return res.json({ ok: true, codigo_caixa: codigoCaixa, reservados, invalidos });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ error: e.message || 'Erro ao reservar caixa' });
    } finally {
      client.release();
    }
  });

  router.post('/:id/itens/:requisicaoItemId/reservar-seriais', ...requisicaoAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const reqId = Number(req.params.id || 0);
      const reqItemId = Number(req.params.requisicaoItemId || 0);
      const seriais = Array.isArray(req.body?.seriais)
        ? serialsNormalizadosList(req.body.seriais.join('\n'))
        : [];
      if (!reqId || !reqItemId || !seriais.length) {
        return res.status(400).json({ error: 'Parâmetros inválidos' });
      }
      const serialsUnicos = [...new Set(seriais)];
      if (serialsUnicos.length !== seriais.length) {
        return res.status(400).json({ error: 'Existem serial numbers duplicados na seleção.' });
      }
      await client.query('BEGIN');
      const reqItem = await client.query(
        `SELECT ri.*, r.armazem_origem_id, ao.tipo AS armazem_origem_tipo
         FROM requisicoes_itens ri
         INNER JOIN requisicoes r ON r.id = ri.requisicao_id
         LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
         WHERE ri.id = $1 AND ri.requisicao_id = $2
         FOR UPDATE`,
        [reqItemId, reqId]
      );
      if (!reqItem.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Item de requisição não encontrado' });
      }
      const itemRow = reqItem.rows[0];
      const origemControlaSeriais = await obterCompartilhaStockSerialArmazem(
        client,
        itemRow.armazem_origem_id,
        itemRow.armazem_origem_tipo
      );

      if (!origemControlaSeriais) {
        await client.query(
          `UPDATE requisicoes_itens
           SET serialnumber = $1,
               quantidade_preparada = $2
           WHERE id = $3`,
          [serialsUnicos.join('\n'), serialsUnicos.length, reqItemId]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, reservados: serialsUnicos, invalidos: [] });
      }
      await client.query(
        `UPDATE stock_serial
         SET status = 'disponivel', requisicao_id = NULL, requisicao_item_id = NULL, reservado_em = NULL, atualizado_em = CURRENT_TIMESTAMP
         WHERE requisicao_item_id = $1 AND status = 'reservado'`,
        [reqItemId]
      );
      const serialRows = await client.query(
        `SELECT id, serialnumber, status, localizacao
         FROM stock_serial
         WHERE item_id = $1
           AND armazem_id = $2
           AND serialnumber = ANY($3::text[])
         ORDER BY serialnumber
         FOR UPDATE`,
        [itemRow.item_id, itemRow.armazem_origem_id, serialsUnicos]
      );
      const bySerial = new Map((serialRows.rows || []).map((r) => [String(r.serialnumber), r]));
      const reservados = [];
      const invalidos = [];
      for (const sn of serialsUnicos) {
        const row = bySerial.get(sn);
        if (!row) {
          invalidos.push({ serialnumber: sn, motivo: 'não encontrado no armazém/item' });
          continue;
        }
        if (String(row.status) !== STOCK_STATUS.DISPONIVEL) {
          invalidos.push({ serialnumber: sn, motivo: `status ${row.status}` });
          continue;
        }
        await client.query(
          `UPDATE stock_serial
           SET status = 'reservado',
               requisicao_id = $1,
               requisicao_item_id = $2,
               reservado_em = CURRENT_TIMESTAMP,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [reqId, reqItemId, row.id]
        );
        reservados.push(sn);
      }
      if (invalidos.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Nem todos os seriais puderam ser reservados.',
          reservados,
          invalidos,
        });
      }
      await client.query(
        `UPDATE requisicoes_itens
         SET serialnumber = $1,
             quantidade_preparada = $2
         WHERE id = $3`,
        [reservados.join('\n'), reservados.length, reqItemId]
      );
      await logStockMovimento({
        db: client,
        tipo: 'reserva_serial_manual',
        itemId: itemRow.item_id,
        armazemId: itemRow.armazem_origem_id,
        quantidade: reservados.length,
        requisicaoId: reqId,
        requisicaoItemId: reqItemId,
        usuarioId: req.user?.id || null,
        payload: { seriais: reservados },
      });
      await client.query('COMMIT');
      return res.json({ ok: true, reservados, invalidos: [] });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ error: e.message || 'Erro ao reservar seriais' });
    } finally {
      client.release();
    }
  });

  router.post('/:id/itens/:requisicaoItemId/liberar-reservas', ...requisicaoAuth, async (req, res) => {
    try {
      const reqItemId = Number(req.params.requisicaoItemId || 0);
      if (!reqItemId) return res.status(400).json({ error: 'ID inválido' });
      const r = await pool.query(
        `UPDATE stock_serial
         SET status = 'disponivel', requisicao_id = NULL, requisicao_item_id = NULL, reservado_em = NULL, atualizado_em = CURRENT_TIMESTAMP
         WHERE requisicao_item_id = $1 AND status = 'reservado'
         RETURNING id`,
        [reqItemId]
      );
      return res.json({ ok: true, liberados: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao liberar reservas' });
    }
  });

  return router;
}

module.exports = { createPreparacaoStockRouter };
