const express = require('express');
const { SQL_STOCK_LOTE_STATUS, STOCK_STATUS } = require('../../services/stock/loteStatus');
const { logStockMovimento } = require('../../services/stock/auditoria');

function createStockRemainingRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    denyNonAdmin,
    requisicaoArmazemOrigemAcessoPermitido,
  } = deps;
  const router = express.Router();

  router.get('/seriais-por-armazem', ...requisicaoAuth, async (req, res) => {
    try {
      const armazemId = Number(req.query.armazem_id || 0);
      const itemId = Number(req.query.item_id || 0) || null;
      const itemCodigo = String(req.query.item_codigo || '').trim();
      const localizacao = String(req.query.localizacao || '').trim();
      const status = String(req.query.status || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      if (!armazemId) return res.status(400).json({ error: 'armazem_id é obrigatório' });
      if (!requisicaoArmazemOrigemAcessoPermitido(req, armazemId)) {
        return res.status(403).json({ error: 'Sem acesso ao armazém informado.' });
      }

      const serialParams = [armazemId];
      const serialFilters = ['s.armazem_id = $1'];
      let sp = 2;
      if (itemId && itemCodigo) {
        const idxItemId = sp++;
        serialParams.push(itemId);
        const idxItemCodigo = sp++;
        serialParams.push(`%${itemCodigo}%`);
        serialFilters.push(`(s.item_id = $${idxItemId} OR UPPER(TRIM(i.codigo::text)) LIKE UPPER(TRIM($${idxItemCodigo}::text)))`);
      } else if (itemId) {
        serialFilters.push(`s.item_id = $${sp++}`);
        serialParams.push(itemId);
      } else if (itemCodigo) {
        serialFilters.push(`UPPER(TRIM(i.codigo::text)) LIKE UPPER(TRIM($${sp++}::text))`);
        serialParams.push(`%${itemCodigo}%`);
      }
      if (localizacao) {
        serialFilters.push(`s.localizacao = $${sp++}`);
        serialParams.push(localizacao);
      }
      if (status) {
        serialFilters.push(`s.status = $${sp++}`);
        serialParams.push(status);
      }

      const loteParams = [armazemId];
      const loteParamStart = serialParams.length + 1;
      const loteFilters = [`l.armazem_id = $${loteParamStart}`];
      let lp = loteParamStart + 1;
      if (itemId && itemCodigo) {
        const idxItemId = lp++;
        loteParams.push(itemId);
        const idxItemCodigo = lp++;
        loteParams.push(`%${itemCodigo}%`);
        loteFilters.push(`(l.item_id = $${idxItemId} OR UPPER(TRIM(i.codigo::text)) LIKE UPPER(TRIM($${idxItemCodigo}::text)))`);
      } else if (itemId) {
        loteFilters.push(`l.item_id = $${lp++}`);
        loteParams.push(itemId);
      } else if (itemCodigo) {
        loteFilters.push(`UPPER(TRIM(i.codigo::text)) LIKE UPPER(TRIM($${lp++}::text))`);
        loteParams.push(`%${itemCodigo}%`);
      }
      if (localizacao) {
        loteFilters.push(`l.localizacao = $${lp++}`);
        loteParams.push(localizacao);
      }
      if (status) {
        loteFilters.push(`${SQL_STOCK_LOTE_STATUS} = $${lp++}`);
        loteParams.push(status);
      }

      const serialWhere = serialFilters.join(' AND ');
      const loteWhere = loteFilters.join(' AND ');

      const sliceCol = (v) => String(v || '').trim().slice(0, 200);
      const colTipo = sliceCol(req.query.col_tipo);
      const colArtigo = sliceCol(req.query.col_artigo);
      const colDescricao = sliceCol(req.query.col_descricao);
      const colSerial = sliceCol(req.query.col_serial);
      const colLote = sliceCol(req.query.col_lote);
      const colQuantidade = sliceCol(req.query.col_quantidade);
      const colLocalizacao = sliceCol(req.query.col_localizacao);
      const colCaixa = sliceCol(req.query.col_caixa);
      const colStatusCol = sliceCol(req.query.col_status);
      const colReq = sliceCol(req.query.col_req);

      const extraColFilters = [];
      const extraColParams = [];
      let ecp = serialParams.length + loteParams.length + 1;
      const pushColStr = (sqlExpr, val) => {
        if (!val) return;
        extraColParams.push(val);
        extraColFilters.push(`strpos(lower(${sqlExpr}), lower($${ecp}::text)) > 0`);
        ecp += 1;
      };
      pushColStr(`COALESCE(u.tipo::text, '')`, colTipo);
      pushColStr(`COALESCE(u.item_codigo::text, '')`, colArtigo);
      pushColStr(`COALESCE(u.item_descricao::text, '')`, colDescricao);
      pushColStr(`COALESCE(u.serialnumber::text, '')`, colSerial);
      pushColStr(`COALESCE(u.lote::text, '')`, colLote);
      pushColStr(`trim(both ' ' from u.quantidade::text)`, colQuantidade);
      pushColStr(`COALESCE(u.localizacao::text, '')`, colLocalizacao);
      pushColStr(
        `COALESCE(NULLIF(TRIM(u.codigo_caixa::text), ''), '—')`,
        colCaixa
      );
      pushColStr(`COALESCE(u.status::text, '')`, colStatusCol);
      pushColStr(
        `CASE WHEN u.requisicao_id IS NULL THEN '—' ELSE u.requisicao_id::text END`,
        colReq
      );

      const outerWhere =
        extraColFilters.length > 0 ? extraColFilters.join(' AND ') : 'TRUE';

      const unionSql = `
        SELECT
          s.id::bigint AS id,
          'serial'::text AS tipo,
          s.item_id,
          i.codigo AS item_codigo,
          i.descricao AS item_descricao,
          s.localizacao,
          s.serialnumber,
          s.lote,
          s.status,
          1::numeric AS quantidade,
          NULL::numeric AS quantidade_reservada,
          s.requisicao_id,
          s.requisicao_item_id,
          c.codigo_caixa,
          s.reservado_em,
          s.consumido_em,
          s.criado_em,
          s.atualizado_em
        FROM stock_serial s
        INNER JOIN itens i ON i.id = s.item_id
        LEFT JOIN stock_caixa_seriais cs ON cs.stock_serial_id = s.id
        LEFT JOIN stock_caixas c ON c.id = cs.caixa_id
        WHERE ${serialWhere}
        UNION ALL
        SELECT
          (1000000000000::bigint + l.id::bigint) AS id,
          'lote'::text AS tipo,
          l.item_id,
          i.codigo AS item_codigo,
          i.descricao AS item_descricao,
          l.localizacao,
          NULL::text AS serialnumber,
          l.lote,
          ${SQL_STOCK_LOTE_STATUS} AS status,
          l.quantidade_disponivel AS quantidade,
          l.quantidade_reservada AS quantidade_reservada,
          NULL::int AS requisicao_id,
          NULL::int AS requisicao_item_id,
          NULL::text AS codigo_caixa,
          NULL::timestamp AS reservado_em,
          NULL::timestamp AS consumido_em,
          l.criado_em,
          l.atualizado_em
        FROM stock_lote l
        INNER JOIN itens i ON i.id = l.item_id
        WHERE ${loteWhere}
      `;

      const baseUnionParams = [...serialParams, ...loteParams];
      const allButLimit = [...baseUnionParams, ...extraColParams];
      const limIdx = allButLimit.length + 1;
      const offIdx = allButLimit.length + 2;

      const rowsSql = `SELECT * FROM (${unionSql}) u
         WHERE ${outerWhere}
         ORDER BY (
           CASE LOWER(TRIM(COALESCE(u.status::text, '')))
             WHEN 'reservado' THEN 0
             WHEN 'disponivel' THEN 1
             WHEN 'consumido' THEN 2
             ELSE 3
           END
         ), u.atualizado_em DESC, u.id DESC
         LIMIT $${limIdx}
         OFFSET $${offIdx}`;

      let totalVal = null;
      let rowsQ;
      if (offset === 0) {
        const countSql = `SELECT COUNT(*)::int AS c FROM (${unionSql}) u WHERE ${outerWhere}`;
        const [totalQ, rq] = await Promise.all([
          pool.query(countSql, allButLimit),
          pool.query(rowsSql, [...allButLimit, limit, offset]),
        ]);
        totalVal = totalQ.rows[0]?.c ?? 0;
        rowsQ = rq;
      } else {
        rowsQ = await pool.query(rowsSql, [...allButLimit, limit, offset]);
      }

      return res.json({
        total: totalVal,
        limit,
        offset,
        rows: rowsQ.rows || [],
      });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao consultar seriais por armazém' });
    }
  });

  router.delete('/seriais-por-armazem', ...requisicaoAuth, denyNonAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const tipo = String(req.body?.tipo || '').trim().toLowerCase();
      const itemId = Number(req.body?.item_id || 0) || null;
      const armazemId = Number(req.body?.armazem_id || 0) || null;
      const localizacao = String(req.body?.localizacao || '').trim();
      const serialnumber = String(req.body?.serialnumber || '').trim();
      const lote = String(req.body?.lote || '').trim();

      if (!['serial', 'lote'].includes(tipo)) {
        return res.status(400).json({ error: 'tipo inválido. Use serial ou lote.' });
      }
      if (!itemId || !armazemId || !localizacao) {
        return res.status(400).json({ error: 'item_id, armazem_id e localizacao são obrigatórios.' });
      }
      if (tipo === 'serial' && !serialnumber) {
        return res.status(400).json({ error: 'serialnumber é obrigatório para apagar serial.' });
      }
      if (tipo === 'lote' && !lote) {
        return res.status(400).json({ error: 'lote é obrigatório para apagar lote.' });
      }

      await client.query('BEGIN');
      if (tipo === 'serial') {
        const serialQ = await client.query(
          `SELECT id, item_id, armazem_id, localizacao, lote, serialnumber
           FROM stock_serial
           WHERE item_id = $1
             AND armazem_id = $2
             AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
             AND UPPER(TRIM(serialnumber)) = UPPER(TRIM($4::text))
           LIMIT 1`,
          [itemId, armazemId, localizacao, serialnumber]
        );
        if (!serialQ.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Serial não encontrado para exclusão.' });
        }
        const row = serialQ.rows[0];
        await client.query('DELETE FROM stock_caixa_seriais WHERE stock_serial_id = $1', [row.id]);
        await client.query('DELETE FROM stock_serial WHERE id = $1', [row.id]);
        await logStockMovimento({
          db: client,
          tipo: 'delete_serial_manual',
          itemId: row.item_id,
          armazemId: row.armazem_id,
          localizacao: row.localizacao,
          lote: row.lote || null,
          serialnumber: row.serialnumber,
          quantidade: 1,
          usuarioId: req.user?.id || null,
          payload: { origem: 'stock-rastreavel-consulta' },
        });
      } else {
        const loteQ = await client.query(
          `SELECT id, item_id, armazem_id, localizacao, lote, quantidade_disponivel
           FROM stock_lote
           WHERE item_id = $1
             AND armazem_id = $2
             AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
             AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))
           LIMIT 1`,
          [itemId, armazemId, localizacao, lote]
        );
        if (!loteQ.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Lote não encontrado para exclusão.' });
        }
        const row = loteQ.rows[0];
        await client.query('DELETE FROM stock_lote WHERE id = $1', [row.id]);
        await logStockMovimento({
          db: client,
          tipo: 'delete_lote_manual',
          itemId: row.item_id,
          armazemId: row.armazem_id,
          localizacao: row.localizacao,
          lote: row.lote,
          quantidade: Number(row.quantidade_disponivel || 0),
          usuarioId: req.user?.id || null,
          payload: { origem: 'stock-rastreavel-consulta' },
        });
      }

      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ error: e.message || 'Erro ao apagar registo de stock rastreável' });
    } finally {
      client.release();
    }
  });

  router.patch('/seriais-por-armazem', ...requisicaoAuth, denyNonAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const tipo = String(req.body?.tipo || '').trim().toLowerCase();
      const itemId = Number(req.body?.item_id || 0) || null;
      const armazemId = Number(req.body?.armazem_id || 0) || null;
      const localizacao = String(req.body?.localizacao || '').trim();
      const serialnumber = String(req.body?.serialnumber || '').trim();
      const lote = String(req.body?.lote || '').trim();
      const statusBody = req.body?.status;
      const requisicaoIdBody = req.body?.requisicao_id;
      const requisicaoItemIdBody = req.body?.requisicao_item_id;
      const quantidadeBody = req.body?.quantidade;
      const statusInformado = statusBody !== undefined && statusBody !== null && String(statusBody).trim() !== '';
      const requisicaoIdInformado = Object.prototype.hasOwnProperty.call(req.body || {}, 'requisicao_id');
      const requisicaoItemIdInformado = Object.prototype.hasOwnProperty.call(req.body || {}, 'requisicao_item_id');
      const quantidadeInformada = quantidadeBody !== undefined && quantidadeBody !== null && String(quantidadeBody).trim() !== '';

      if (!['serial', 'lote'].includes(tipo)) {
        return res.status(400).json({ error: 'tipo inválido. Use serial ou lote.' });
      }
      if (!itemId || !armazemId || !localizacao) {
        return res.status(400).json({ error: 'item_id, armazem_id e localizacao são obrigatórios.' });
      }
      if (tipo === 'serial' && !serialnumber) {
        return res.status(400).json({ error: 'serialnumber é obrigatório para editar serial.' });
      }
      if (tipo === 'lote' && !lote) {
        return res.status(400).json({ error: 'lote é obrigatório para editar lote.' });
      }
      if (tipo === 'serial' && !statusInformado && !requisicaoIdInformado && !requisicaoItemIdInformado) {
        return res.status(400).json({ error: 'Informe status, requisicao_id ou requisicao_item_id para editar serial.' });
      }
      if (tipo === 'lote' && !statusInformado && !quantidadeInformada) {
        return res.status(400).json({ error: 'Informe status ou quantidade para editar lote.' });
      }

      const parseOptionalInt = (value) => {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
      };

      await client.query('BEGIN');
      if (tipo === 'serial') {
        const serialQ = await client.query(
          `SELECT id, item_id, armazem_id, localizacao, lote, serialnumber, status,
                  requisicao_id, requisicao_item_id, reservado_em, consumido_em
           FROM stock_serial
           WHERE item_id = $1
             AND armazem_id = $2
             AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
             AND UPPER(TRIM(serialnumber)) = UPPER(TRIM($4::text))
           LIMIT 1
           FOR UPDATE`,
          [itemId, armazemId, localizacao, serialnumber]
        );
        if (!serialQ.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Serial não encontrado para edição.' });
        }
        const before = serialQ.rows[0];
        const nextStatus = statusInformado
          ? String(statusBody).trim().toLowerCase()
          : String(before.status || '').trim().toLowerCase();
        if (![STOCK_STATUS.DISPONIVEL, STOCK_STATUS.RESERVADO, STOCK_STATUS.CONSUMIDO].includes(nextStatus)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'status inválido. Use disponivel, reservado ou consumido.' });
        }

        let nextReqId = requisicaoIdInformado ? parseOptionalInt(requisicaoIdBody) : before.requisicao_id;
        let nextReqItemId = requisicaoItemIdInformado
          ? parseOptionalInt(requisicaoItemIdBody)
          : before.requisicao_item_id;
        if (requisicaoIdInformado && requisicaoIdBody !== null && String(requisicaoIdBody).trim() !== '' && !nextReqId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'requisicao_id inválido.' });
        }
        if (
          requisicaoItemIdInformado &&
          requisicaoItemIdBody !== null &&
          String(requisicaoItemIdBody).trim() !== '' &&
          !nextReqItemId
        ) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'requisicao_item_id inválido.' });
        }
        if (nextReqId) {
          const reqCheck = await client.query('SELECT id FROM requisicoes WHERE id = $1 LIMIT 1', [nextReqId]);
          if (!reqCheck.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'requisicao_id não encontrado.' });
          }
        }
        if (nextReqItemId) {
          const reqItemCheck = await client.query(
            'SELECT id, requisicao_id FROM requisicoes_itens WHERE id = $1 LIMIT 1',
            [nextReqItemId]
          );
          if (!reqItemCheck.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'requisicao_item_id não encontrado.' });
          }
          if (nextReqId && Number(reqItemCheck.rows[0].requisicao_id) !== Number(nextReqId)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'requisicao_item_id não pertence à requisicao_id informada.' });
          }
          if (!nextReqId) nextReqId = Number(reqItemCheck.rows[0].requisicao_id) || null;
        }

        let reservadoEm = before.reservado_em;
        let consumidoEm = before.consumido_em;
        if (nextStatus === STOCK_STATUS.DISPONIVEL) {
          nextReqId = null;
          nextReqItemId = null;
          reservadoEm = null;
          consumidoEm = null;
        } else if (nextStatus === STOCK_STATUS.RESERVADO) {
          reservadoEm = reservadoEm || new Date();
          consumidoEm = null;
        } else if (nextStatus === STOCK_STATUS.CONSUMIDO) {
          consumidoEm = consumidoEm || new Date();
        }

        await client.query(
          `UPDATE stock_serial
           SET status = $2,
               requisicao_id = $3,
               requisicao_item_id = $4,
               reservado_em = $5,
               consumido_em = $6,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [before.id, nextStatus, nextReqId, nextReqItemId, reservadoEm, consumidoEm]
        );
        await logStockMovimento({
          db: client,
          tipo: 'update_serial_manual',
          itemId: before.item_id,
          armazemId: before.armazem_id,
          localizacao: before.localizacao,
          lote: before.lote || null,
          serialnumber: before.serialnumber,
          quantidade: 1,
          requisicaoId: nextReqId,
          requisicaoItemId: nextReqItemId,
          usuarioId: req.user?.id || null,
          payload: {
            origem: 'stock-rastreavel-consulta',
            antes: {
              status: before.status,
              requisicao_id: before.requisicao_id,
              requisicao_item_id: before.requisicao_item_id,
            },
            depois: {
              status: nextStatus,
              requisicao_id: nextReqId,
              requisicao_item_id: nextReqItemId,
            },
          },
        });
      } else {
        const loteQ = await client.query(
          `SELECT id, item_id, armazem_id, localizacao, lote,
                  quantidade_disponivel, quantidade_reservada, quantidade_consumida
           FROM stock_lote
           WHERE item_id = $1
             AND armazem_id = $2
             AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
             AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))
           LIMIT 1
           FOR UPDATE`,
          [itemId, armazemId, localizacao, lote]
        );
        if (!loteQ.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Lote não encontrado para edição.' });
        }
        const before = loteQ.rows[0];
        const statusAtual = statusStockLoteFromQuantidades(
          before.quantidade_disponivel,
          before.quantidade_reservada
        );
        const nextStatus = statusInformado
          ? String(statusBody).trim().toLowerCase()
          : statusAtual;
        if (![STOCK_STATUS.DISPONIVEL, STOCK_STATUS.RESERVADO, STOCK_STATUS.CONSUMIDO].includes(nextStatus)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'status inválido. Use disponivel, reservado ou consumido.' });
        }

        let qDisp = Number(before.quantidade_disponivel) || 0;
        let qRes = Number(before.quantidade_reservada) || 0;
        let qCons = Number(before.quantidade_consumida) || 0;
        const qtyAtual =
          statusAtual === STOCK_STATUS.DISPONIVEL
            ? qDisp
            : statusAtual === STOCK_STATUS.RESERVADO
              ? qRes
              : qCons;
        const nextQty = quantidadeInformada ? Number(quantidadeBody) : qtyAtual;
        if (!Number.isFinite(nextQty) || nextQty < 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'quantidade inválida.' });
        }

        if (nextStatus !== statusAtual) {
          if (statusAtual === STOCK_STATUS.DISPONIVEL) qDisp = 0;
          else if (statusAtual === STOCK_STATUS.RESERVADO) qRes = 0;
          else qCons = 0;
        }
        if (nextStatus === STOCK_STATUS.DISPONIVEL) qDisp = nextQty;
        else if (nextStatus === STOCK_STATUS.RESERVADO) qRes = nextQty;
        else qCons = nextQty;

        await client.query(
          `UPDATE stock_lote
           SET quantidade_disponivel = $2,
               quantidade_reservada = $3,
               quantidade_consumida = $4,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [before.id, qDisp, qRes, qCons]
        );
        await logStockMovimento({
          db: client,
          tipo: 'update_lote_manual',
          itemId: before.item_id,
          armazemId: before.armazem_id,
          localizacao: before.localizacao,
          lote: before.lote,
          quantidade: nextQty,
          usuarioId: req.user?.id || null,
          payload: {
            origem: 'stock-rastreavel-consulta',
            antes: {
              status: statusAtual,
              quantidade_disponivel: Number(before.quantidade_disponivel) || 0,
              quantidade_reservada: Number(before.quantidade_reservada) || 0,
              quantidade_consumida: Number(before.quantidade_consumida) || 0,
            },
            depois: {
              status: nextStatus,
              quantidade_disponivel: qDisp,
              quantidade_reservada: qRes,
              quantidade_consumida: qCons,
            },
          },
        });
      }

      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ error: e.message || 'Erro ao editar registo de stock rastreável' });
    } finally {
      client.release();
    }
  });

  router.get('/caixas/:codigo', ...requisicaoAuth, async (req, res) => {
    try {
      const codigo = String(req.params.codigo || '').trim();
      if (!codigo) return res.status(400).json({ error: 'Código da caixa obrigatório' });
      const caixa = await pool.query(
        `SELECT c.*, i.codigo AS item_codigo, i.descricao AS item_descricao
         FROM stock_caixas c
         INNER JOIN itens i ON i.id = c.item_id
         WHERE c.codigo_caixa = $1
         LIMIT 1`,
        [codigo]
      );
      if (!caixa.rows.length) return res.status(404).json({ error: 'Caixa não encontrada' });
      const seriais = await pool.query(
        `SELECT s.id, s.serialnumber, s.status, s.lote
         FROM stock_caixa_seriais cs
         INNER JOIN stock_serial s ON s.id = cs.stock_serial_id
         WHERE cs.caixa_id = $1
         ORDER BY (
           CASE LOWER(TRIM(COALESCE(s.status::text, '')))
             WHEN 'reservado' THEN 0
             WHEN 'disponivel' THEN 1
             WHEN 'consumido' THEN 2
             ELSE 3
           END
         ), s.serialnumber`,
        [caixa.rows[0].id]
      );
      return res.json({
        caixa: caixa.rows[0],
        seriais: seriais.rows || [],
      });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao consultar caixa' });
    }
  });

  router.get('/seriais/:codigo', ...requisicaoAuth, async (req, res) => {
    try {
      const codigo = String(req.params.codigo || '').trim();
      const armazemId = Number(req.query.armazem_id || 0) || null;
      if (!codigo) return res.status(400).json({ error: 'Código do serial obrigatório' });
      if (armazemId && !requisicaoArmazemOrigemAcessoPermitido(req, armazemId)) {
        return res.status(403).json({ error: 'Sem acesso ao armazém informado.' });
      }
      const params = [codigo];
      let whereArmazem = '';
      if (armazemId) {
        params.push(armazemId);
        whereArmazem = ' AND s.armazem_id = $2';
      }
      const serialQ = await pool.query(
        `SELECT
           s.id, s.item_id, i.codigo AS item_codigo, i.descricao AS item_descricao,
           s.armazem_id, a.codigo AS armazem_codigo, a.descricao AS armazem_descricao,
           s.localizacao, s.serialnumber, s.lote, s.status,
           s.requisicao_id, s.requisicao_item_id, s.reservado_em, s.consumido_em,
           c.id AS caixa_id, c.codigo_caixa
         FROM stock_serial s
         INNER JOIN itens i ON i.id = s.item_id
         INNER JOIN armazens a ON a.id = s.armazem_id
         LEFT JOIN stock_caixa_seriais cs ON cs.stock_serial_id = s.id
         LEFT JOIN stock_caixas c ON c.id = cs.caixa_id
        WHERE UPPER(TRIM(s.serialnumber)) = UPPER(TRIM($1::text))${whereArmazem}
         ORDER BY s.atualizado_em DESC
         LIMIT 1`,
        params
      );
      if (!serialQ.rows.length) return res.status(404).json({ error: 'Serial não encontrado' });
      return res.json(serialQ.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao consultar serial' });
    }
  });

  return router;
}

module.exports = { createStockRemainingRouter };
