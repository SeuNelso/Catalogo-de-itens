const express = require('express');

function createCrudRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    usuarioEscopadoSemArmazensAtribuidos,
    SQL_LISTA_CRIADOR_E_SEPARADOR,
    RECEBIMENTO_TRANSFERENCIA_MARKER,
    attachSeriaisToRequisicaoItens,
    hasRecebimentoMarker,
    getAutoFromReqId,
    markerFlagAtivo,
  } = deps;
  const router = express.Router();

router.get('/', ...requisicaoAuth, async (req, res) => {
  try {
    if (usuarioEscopadoSemArmazensAtribuidos(req)) {
      return res.json([]);
    }
    const { status, armazem_id, item_id, devolucoes, transferencias } = req.query;
    let itemIdParsed = null;
    if (item_id != null && String(item_id).trim() !== '') {
      const iid = parseInt(String(item_id), 10);
      if (Number.isFinite(iid)) itemIdParsed = iid;
    }
    const minhas =
      req.query.minhas === '1' ||
      req.query.minhas === 'true' ||
      String(req.query.minhas || '').toLowerCase() === 'sim';

    const devolucoesParaCentral = ['1', 'true', 'yes', 'sim'].includes(
      String(devolucoes || '').toLowerCase()
    );
    const transferenciasFluxo = ['1', 'true', 'yes', 'sim'].includes(
      String(transferencias || '').toLowerCase()
    );

    // Buscar requisições (armazem destino + armazem origem)
    let query = `
      SELECT 
        r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        a.tipo as armazem_destino_tipo,
        ao.tipo as armazem_origem_tipo,
        ${SQL_LISTA_CRIADOR_E_SEPARADOR}
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      LEFT JOIN usuarios su ON r.separador_usuario_id = su.id
      LEFT JOIN usuarios cu ON r.cancelada_por_usuario_id = cu.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` AND r.status = $${paramCount++}`;
      params.push(String(status));
    }

    if (transferenciasFluxo) {
      // Página "Transferências": central <-> APEADO e central -> central.
      query += ` AND (
        (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
      )`;
      params.push('central', 'apeado', 'apeado', 'central', 'central', 'central');
      // Recebimento de mercadoria usa os mesmos tipos no JOIN, mas convenção invertida
      // (armazem_origem_id = onde se recebe). Não contar como transferência "centrais".
      query += ` AND UPPER(COALESCE(r.observacoes, '')) NOT LIKE $${paramCount++}`;
      params.push(`${RECEBIMENTO_TRANSFERENCIA_MARKER}%`);
    } else if (devolucoesParaCentral) {
      // Devolução: viatura ou EPI → central
      query += ` AND (
        (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
      )`;
      params.push('viatura', 'central', 'epi', 'central');
    } else {
      // Página "Requisições": excluir fluxos dedicados de Devoluções e Transferências.
      // Devoluções: viatura/epi -> central
      // Transferências: central <-> apeado e central -> central (exceto recebimento mercadoria)
      query += ` AND NOT (
        (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (
          (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
          AND UPPER(COALESCE(r.observacoes, '')) NOT LIKE $${paramCount++}
        )
      )`;
      params.push(
        'viatura',
        'central',
        'epi',
        'central',
        'central',
        'apeado',
        'apeado',
        'central',
        'central',
        'central',
        `${RECEBIMENTO_TRANSFERENCIA_MARKER}%`
      );
    }

    if (armazem_id != null && String(armazem_id).trim() !== '') {
      const aid = parseInt(String(armazem_id), 10);
      if (Number.isFinite(aid)) {
        query += ` AND r.armazem_id = $${paramCount++}`;
        params.push(aid);
      }
    }

    if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
      if (devolucoesParaCentral) {
        query += ` AND r.armazem_id = ANY($${paramCount++}::int[])`;
      } else {
        query += ` AND r.armazem_origem_id = ANY($${paramCount++}::int[])`;
      }
      params.push(req.requisicaoArmazemOrigemIds);
    }

    if (minhas) {
      if (!req.user || req.user.id == null) {
        return res.status(401).json({ error: 'Sessão inválida.' });
      }
      query += ` AND r.usuario_id = $${paramCount++}`;
      params.push(req.user.id);
    }

    query += ` ORDER BY r.created_at DESC`;

    const limParsed = parseInt(req.query.limit, 10);
    if (!Number.isNaN(limParsed) && limParsed > 0) {
      const lim = Math.min(2000, limParsed);
      const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
      query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params.push(lim, off);
    }

    let requisicoesResult;
    try {
      requisicoesResult = await pool.query(query, params);
    } catch (qErr) {
      const transientDbConnErr =
        qErr?.code === 'ECONNRESET'
        || qErr?.code === '57P01'
        || /Connection terminated unexpectedly/i.test(String(qErr?.message || ''));
      if (transientDbConnErr) {
        console.warn('[requisicoes/list] falha transitória de conexão ao DB; retry 1x');
        requisicoesResult = await pool.query(query, params);
      } else if (qErr.code === '42703') {
        let fallbackQuery = `
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
            a.tipo as armazem_destino_tipo,
            ao.tipo as armazem_origem_tipo,
            ${SQL_LISTA_CRIADOR_E_SEPARADOR}
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          LEFT JOIN usuarios su ON r.separador_usuario_id = su.id
          LEFT JOIN usuarios cu ON r.cancelada_por_usuario_id = cu.id
          WHERE 1=1
        `;
        const fbParams = [];
        let pc = 1;
        if (status) {
          fallbackQuery += ` AND r.status = $${pc++}`;
          fbParams.push(String(status));
        }

        if (transferenciasFluxo) {
          fallbackQuery += ` AND (
            (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
          )`;
          fbParams.push('central', 'apeado', 'apeado', 'central', 'central', 'central');
          fallbackQuery += ` AND UPPER(COALESCE(r.observacoes, '')) NOT LIKE $${pc++}`;
          fbParams.push(`${RECEBIMENTO_TRANSFERENCIA_MARKER}%`);
        } else if (devolucoesParaCentral) {
          fallbackQuery += ` AND (
            (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
          )`;
          fbParams.push('viatura', 'central', 'epi', 'central');
        } else {
          fallbackQuery += ` AND NOT (
            (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (
              (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
              AND UPPER(COALESCE(r.observacoes, '')) NOT LIKE $${pc++}
            )
          )`;
          fbParams.push(
            'viatura',
            'central',
            'epi',
            'central',
            'central',
            'apeado',
            'apeado',
            'central',
            'central',
            'central',
            `${RECEBIMENTO_TRANSFERENCIA_MARKER}%`
          );
        }
        if (armazem_id != null && String(armazem_id).trim() !== '') {
          const aid = parseInt(String(armazem_id), 10);
          if (Number.isFinite(aid)) {
            fallbackQuery += ` AND r.armazem_id = $${pc++}`;
            fbParams.push(aid);
          }
        }
        if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
          if (devolucoesParaCentral) {
            fallbackQuery += ` AND r.armazem_id = ANY($${pc++}::int[])`;
          } else {
            fallbackQuery += ` AND r.armazem_origem_id = ANY($${pc++}::int[])`;
          }
          fbParams.push(req.requisicaoArmazemOrigemIds);
        }
        if (minhas) {
          if (!req.user || req.user.id == null) {
            return res.status(401).json({ error: 'Sessão inválida.' });
          }
          fallbackQuery += ` AND r.usuario_id = $${pc++}`;
          fbParams.push(req.user.id);
        }
        fallbackQuery += ` ORDER BY r.created_at DESC`;
        if (!Number.isNaN(limParsed) && limParsed > 0) {
          const lim = Math.min(2000, limParsed);
          const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
          fallbackQuery += ` LIMIT $${pc} OFFSET $${pc + 1}`;
          fbParams.push(lim, off);
        }
        requisicoesResult = await pool.query(fallbackQuery, fbParams);
      } else {
        throw qErr;
      }
    }
    const requisicoes = requisicoesResult.rows;

    // Otimização: buscar todos os itens das requisições em uma única consulta (evita N+1 queries)
    if (requisicoes.length > 0) {
      const reqIds = requisicoes.map(r => r.id).filter(Boolean);
      let itensQuery = `
        SELECT
          ri.*,
          i.codigo as item_codigo,
          i.descricao as item_descricao
        FROM requisicoes_itens ri
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = ANY($1::int[])
      `;
      const itensParams = [reqIds];
      if (itemIdParsed != null) {
        itensQuery += ' AND ri.item_id = $2';
        itensParams.push(itemIdParsed);
      }
      itensQuery += ' ORDER BY ri.requisicao_id, ri.id';

      const itensResult = await pool.query(itensQuery, itensParams);
      const itensPorRequisicao = new Map();
      for (const row of itensResult.rows) {
        const list = itensPorRequisicao.get(row.requisicao_id) || [];
        list.push(row);
        itensPorRequisicao.set(row.requisicao_id, list);
      }

      for (const req of requisicoes) {
        req.itens = itensPorRequisicao.get(req.id) || [];
      }

      const allItensList = [];
      for (const rq of requisicoes) {
        for (const it of rq.itens || []) allItensList.push(it);
      }
      await attachSeriaisToRequisicaoItens(pool, allItensList);
    }

    // Enriquecer fluxo central->central com estado de receção no destino.
    if (requisicoes.length > 0) {
      const recebimentoByOrigemReqId = new Map();
      const origemReqIdsDosRecebimentos = new Set();
      const origemReqIdsVisiveis = new Set();
      for (const reqRow of requisicoes) {
        if (hasRecebimentoMarker(reqRow)) {
          const origemReqId = getAutoFromReqId(reqRow);
          if (!origemReqId) continue;
          origemReqIdsDosRecebimentos.add(Number(origemReqId));
          const prev = recebimentoByOrigemReqId.get(origemReqId);
          if (!prev || Number(reqRow.id) > Number(prev.id)) {
            recebimentoByOrigemReqId.set(origemReqId, reqRow);
          }
          continue;
        }
        origemReqIdsVisiveis.add(Number(reqRow.id));
      }

      // Garante vínculo origem->recebimento mesmo quando o recebimento não está no scope da listagem atual.
      if (origemReqIdsVisiveis.size > 0) {
        const linkedRows = await pool.query(
          `SELECT
             r.id,
             r.status,
             r.observacoes,
             ((regexp_match(r.observacoes, 'AUTO_FROM_REQ:\\s*([0-9]+)'))[1])::int AS origem_req_id
           FROM requisicoes r
           WHERE UPPER(COALESCE(r.observacoes, '')) LIKE UPPER($2)
             AND regexp_match(r.observacoes, 'AUTO_FROM_REQ:\\s*([0-9]+)') IS NOT NULL
             AND ((regexp_match(r.observacoes, 'AUTO_FROM_REQ:\\s*([0-9]+)'))[1])::int = ANY($1::int[])
           ORDER BY r.id DESC`,
          [[...origemReqIdsVisiveis], `${RECEBIMENTO_TRANSFERENCIA_MARKER}%`]
        );
        for (const row of linkedRows.rows || []) {
          const origemReqId = Number(row.origem_req_id);
          if (!Number.isFinite(origemReqId)) continue;
          if (!origemReqIdsDosRecebimentos.has(origemReqId)) origemReqIdsDosRecebimentos.add(origemReqId);
          const prev = recebimentoByOrigemReqId.get(origemReqId);
          if (!prev || Number(row.id) > Number(prev.id)) {
            recebimentoByOrigemReqId.set(origemReqId, {
              ...row,
              itens: [],
            });
          }
        }
      }

      const origemById = new Map();
      if (origemReqIdsDosRecebimentos.size > 0) {
        const origemRows = await pool.query(
          `SELECT id, status, tra_numero
           FROM requisicoes
           WHERE id = ANY($1::int[])`,
          [[...origemReqIdsDosRecebimentos]]
        );
        for (const r of origemRows.rows || []) {
          origemById.set(Number(r.id), r);
        }
      }

      const linkedReqIds = [...new Set(
        [...recebimentoByOrigemReqId.values()]
          .map((x) => Number(x?.id))
          .filter(Number.isFinite)
      )];
      if (linkedReqIds.length > 0) {
        const linkedItens = await pool.query(
          `SELECT requisicao_id, item_id, quantidade, quantidade_preparada
           FROM requisicoes_itens
           WHERE requisicao_id = ANY($1::int[])`,
          [linkedReqIds]
        );
        const itensByLinkedId = new Map();
        for (const it of linkedItens.rows || []) {
          const k = Number(it.requisicao_id);
          const arr = itensByLinkedId.get(k) || [];
          arr.push(it);
          itensByLinkedId.set(k, arr);
        }
        for (const [origemReqId, linked] of recebimentoByOrigemReqId.entries()) {
          recebimentoByOrigemReqId.set(origemReqId, {
            ...linked,
            itens: Array.isArray(linked?.itens) && linked.itens.length > 0
              ? linked.itens
              : (itensByLinkedId.get(Number(linked.id)) || []),
          });
        }
      }

      const qtyByItem = (reqRow) => {
        const map = new Map();
        for (const it of reqRow?.itens || []) {
          const itemId = Number(it.item_id);
          if (!Number.isFinite(itemId)) continue;
          const q = Number(it.quantidade_preparada ?? it.quantidade ?? 0) || 0;
          map.set(itemId, q);
        }
        return map;
      };

      for (const reqRow of requisicoes) {
        if (hasRecebimentoMarker(reqRow)) {
          const origemReqId = getAutoFromReqId(reqRow);
          reqRow.requisicao_origem_id = origemReqId || null;
          const entregaConfirmada = markerFlagAtivo(reqRow.observacoes, 'DELIVERY_CONFIRMED');
          const traConfirmada = markerFlagAtivo(reqRow.observacoes, 'TRA_CONFIRMED');
          reqRow.recebimento_entrega_confirmada = entregaConfirmada;
          reqRow.recebimento_tra_confirmada = traConfirmada;
          if (origemReqId) {
            const origemReq = origemById.get(Number(origemReqId));
            reqRow.requisicao_origem_tra_numero = String(origemReq?.tra_numero || '').trim();
          } else {
            // Recebimento manual/GT não tem AUTO_FROM_REQ: usar o Nº TRA guardado no próprio recebimento.
            reqRow.requisicao_origem_tra_numero = String(reqRow.tra_numero || '').trim();
          }
          reqRow.aguardando_tra_origem =
            Boolean(entregaConfirmada) &&
            !String(reqRow.requisicao_origem_tra_numero || '').trim();
          reqRow.pode_confirmar_tra =
            Boolean(entregaConfirmada) &&
            Boolean(String(reqRow.requisicao_origem_tra_numero || '').trim()) &&
            !Boolean(traConfirmada);
          reqRow.pode_finalizar_recebimento =
            Boolean(entregaConfirmada) &&
            Boolean(traConfirmada) &&
            String(reqRow.status || '') === 'EM EXPEDICAO';
          continue;
        }
        const linked = recebimentoByOrigemReqId.get(Number(reqRow.id));
        if (!linked) continue;
        reqRow.recepcao_req_id = Number(linked.id);

        const linkedStatus = String(linked.status || '');
        if (
          ['pendente', 'EM EXPEDICAO'].includes(linkedStatus) &&
          String(reqRow.status || '') === 'EM EXPEDICAO' &&
          !markerFlagAtivo(linked.observacoes, 'DELIVERY_CONFIRMED')
        ) {
          reqRow.recepcao_status = 'AGUARDANDO_RECECAO';
          continue;
        }

        if (
          ['Entregue', 'FINALIZADO'].includes(String(reqRow.status || '')) &&
          ['Entregue', 'FINALIZADO'].includes(linkedStatus)
        ) {
          const origemQty = qtyByItem(reqRow);
          const recQty = qtyByItem(linked);
          const itemIds = new Set([...origemQty.keys(), ...recQty.keys()]);
          let allMatch = itemIds.size > 0;
          for (const itemId of itemIds) {
            const qOrig = Number(origemQty.get(itemId) ?? 0);
            const qRec = Number(recQty.get(itemId) ?? 0);
            if (Math.abs(qOrig - qRec) > 1e-9) {
              allMatch = false;
              break;
            }
          }
          reqRow.recepcao_status = allMatch ? 'RECECIONADA_TOTAL' : 'RECECIONADA_PARCIAL';
        }
      }
    }

    // Filtrar requisições que não têm o item_id especificado (se filtro aplicado)
    const filteredRequisicoes =
      itemIdParsed != null ? requisicoes.filter((r) => r.itens && r.itens.length > 0) : requisicoes;

    res.json(filteredRequisicoes);
  } catch (error) {
    // Tabelas de requisições ainda não criadas - retornar lista vazia
    if (error.code === '42P01') {
      console.warn('⚠️ Tabelas "requisicoes" ou "armazens" não existem. Execute: server/create-armazens-requisicoes-v2.sql');
      return res.json([]);
    }
    console.error('Erro ao listar requisições:', error);
    res.status(500).json({ error: 'Erro ao listar requisições', details: error.message });
  }
});
  return router;
}

module.exports = { createCrudRouter };
