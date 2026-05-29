const express = require('express');
const fs = require('fs');
const { isAdmin } = require('../../utils/roles');
const {
  isFluxoDevolucaoViaturaCentral,
  requisicaoPerfilNegadoMiddleware,
} = require('../../middleware/requisicoesScope');
const { usuarioTemPermissaoControloStock } = require('../../utils/usuarioDbColumns');
const { quantidadeMonitorRececaoItem } = require('../../services/requisicoes/preparacaoUtils');

function createEstadosLogisticaRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    authenticateToken,
    requisicaoScopeMiddleware,
    excelUploadRequisicoes,
    denyOperador,
    denyBackofficeOperations,
    requisicaoArmazemOrigemAcessoPermitido,
    separadorImpedeAcao,
    respostaBloqueioSeparador,
    getRequisicaoComItens,
    attachSeriaisToRequisicaoItens,
    hasRecebimentoMarker,
    liberarReservasLotePorRequisicao,
    schedulePersistMovimentosHistoricoForRequisicoes,
    ensureMovimentosHistoricoDetachedSchema,
    persistMovimentosHistoricoForRequisicoes,
    extractPdfText,
    markerFlagAtivo,
    upsertMarkerFlag,
    getTaggedValue,
    getAutoFromReqId,
    aplicarStockDevolucaoEntradaRecebimento,
    aplicarStockTraApeadosDevolucao,
    aplicarStockTrflPendenteDevolucao,
    localizacaoArmazemPorTipoConn,
    computeDestLocFerrNormal,
    mergeRequisicaoItensSeriaisFromChildTable,
    makeStockPrepBizError,
    logStockMovimento,
    isTipoControloSerial,
    serialsNormalizadosList,
    extractSeriaisLinhasFromItemBody,
    dedupeSeriaisLinhasPorSerial,
    armazemMovimentacaoInternaTableExists,
    buildExcelReporte,
    buildRecebimentoMercadoriaReporteRows,
    buildRecebimentoMercadoriaReporteRowsDetalhado,
    formatarNumeroTraDev,
    LOCALIZACAO_RECEBIMENTO_FALLBACK,
    RECEBIMENTO_TRANSFERENCIA_MARKER,
    DEV_RECEBIMENTO_STOCK_APLICADO_MARKER,
    DEV_APEADOS_STOCK_PENDENTE_MARKER,
    DEV_TRFL_PENDENTE_STOCK_MARKER,
    TRFL_PENDENTE_LOC_TAG,
    RECEBIMENTO_MONITOR_CLEAR_TEST_MARKER,
  } = deps;
  const router = express.Router();

// Marcar como EM EXPEDICAO (após baixar o ficheiro TRFL)
router.patch('/:id/marcar-em-expedicao', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      `SELECT r.id, r.status, r.separacao_confirmada, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (check.rows[0].status !== 'separado') {
      return res.status(400).json({ error: 'Só pode marcar em expedição quando a requisição está separada.' });
    }
    if (!check.rows[0].separacao_confirmada) {
      return res.status(400).json({ error: 'Confirme a separação antes de marcar em expedição.' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['EM EXPEDICAO', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/Migrate/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao marcar em expedição:', error);
    res.status(500).json({ error: 'Erro ao marcar em expedição', details: error.message });
  }
});

// Marcar como Entregue (após baixar o ficheiro TRA)
router.patch('/:id/marcar-entregue', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const reqId = parseInt(String(id || ''), 10);
    if (!Number.isFinite(reqId)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }

    await client.query('BEGIN');

    // Lock apenas da linha da requisição (evita erro em LEFT JOIN + FOR UPDATE).
    const lock = await client.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id
              , COALESCE(r.cancelada_em_expedicao, false) AS cancelada_em_expedicao
       FROM requisicoes r
       WHERE r.id = $1
       FOR UPDATE`,
      [reqId]
    );
    if (lock.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    const meta = await client.query(
      `SELECT
         r.id,
         r.status,
         r.armazem_origem_id,
         r.armazem_id,
         r.separador_usuario_id,
         ao.tipo AS armazem_origem_tipo,
         a.tipo AS armazem_destino_tipo,
         COALESCE(a.recebimento_transferencia_digital, true) AS destino_recebimento_transferencia_digital
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [reqId]
    );
    const row = meta.rows[0];

    if (!requisicaoArmazemOrigemAcessoPermitido(req, row.armazem_origem_id, { requisicao: row })) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) {
      await client.query('ROLLBACK');
      return respostaBloqueioSeparador(res);
    }
    if (!['EM EXPEDICAO', 'APEADOS'].includes(String(row.status || ''))) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Só pode marcar como entregue quando a requisição está em expedição (EM EXPEDICAO) ou APEADOS.'
      });
    }
    if (Boolean(row.cancelada_em_expedicao)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Requisição cancelada em expedição. Gere a TRFL de cancelamento e conclua o cancelamento.'
      });
    }

    let recebimentoTransferenciaId = null;
    const origemTipo = String(row.armazem_origem_tipo || '').trim().toLowerCase();
    const destinoTipo = String(row.armazem_destino_tipo || '').trim().toLowerCase();
    const isCentralParaCentral = origemTipo === 'central' && destinoTipo === 'central';
    const destinoRecebimentoDigital = row.destino_recebimento_transferencia_digital !== false;
    const useMirrorRecebimentoCentral =
      isCentralParaCentral && destinoRecebimentoDigital;

    // Entregar central->central com receção digital no destino: criar recebimento no destino e manter origem em EM_EXPEDICAO (aguardando receção).
    if (useMirrorRecebimentoCentral) {
      const marker = `${RECEBIMENTO_TRANSFERENCIA_MARKER}: AUTO_FROM_REQ:${reqId} | DELIVERY_CONFIRMED:0 | TRA_CONFIRMED:0`;
      // convenção do recebimento existente:
      // armazem_origem_id = armazém de recebimento (destino da original)
      // armazem_id = armazém origem (origem da original)
      const recebimentoArmId = Number(row.armazem_id);
      const origemArmId = Number(row.armazem_origem_id);

      const existing = await client.query(
        `SELECT id
         FROM requisicoes
         WHERE armazem_origem_id = $1
           AND armazem_id = $2
           AND UPPER(COALESCE(observacoes, '')) LIKE UPPER($3)
         ORDER BY id DESC
         LIMIT 1`,
        [recebimentoArmId, origemArmId, `%AUTO_FROM_REQ:${reqId}%`]
      );

      if (existing.rows.length > 0) {
        recebimentoTransferenciaId = Number(existing.rows[0].id);
      } else {
        const created = await client.query(
          `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
           VALUES ($1, $2, $3, $4, 'pendente')
           RETURNING id`,
          [recebimentoArmId, origemArmId, marker, req.user.id]
        );
        recebimentoTransferenciaId = Number(created.rows[0]?.id || 0) || null;

        if (recebimentoTransferenciaId) {
          await client.query(
            `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
             SELECT
               $1 AS requisicao_id,
               ri.item_id,
               GREATEST(0, COALESCE(NULLIF(ri.quantidade_preparada, 0), ri.quantidade, 0))::numeric AS quantidade
             FROM requisicoes_itens ri
             WHERE ri.requisicao_id = $2
               AND GREATEST(0, COALESCE(NULLIF(ri.quantidade_preparada, 0), ri.quantidade, 0)) > 0
             ON CONFLICT (requisicao_id, item_id)
             DO UPDATE SET quantidade = EXCLUDED.quantidade`,
            [recebimentoTransferenciaId, reqId]
          );
        }
      }
      await client.query(
        `UPDATE requisicoes
         SET status = 'EM EXPEDICAO',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [reqId]
      );
    } else {
      await client.query(
        `UPDATE requisicoes
         SET status = 'Entregue',
             entregue_em = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [reqId]
      );
    }

    await client.query('COMMIT');
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [reqId]);
    return res.json({
      ...updated.rows[0],
      recebimento_transferencia_id: recebimentoTransferenciaId,
      aguardando_recepcao: Boolean(useMirrorRecebimentoCentral),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/Migrate/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao marcar como entregue:', error);
    return res.status(500).json({ error: 'Erro ao marcar como entregue', details: error.message });
  } finally {
    client.release();
  }
});

// Voltar de Entregue para EM EXPEDICAO (correção após entrega indevida)
router.patch('/:id/voltar-em-expedicao', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.tra_gerada_em,
         r.armazem_origem_id,
         r.armazem_id,
         r.separador_usuario_id,
         ao.tipo AS armazem_origem_tipo,
         a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    const row = check.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, row.armazem_origem_id, { requisicao: row })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) {
      return respostaBloqueioSeparador(res);
    }
    if (String(row.status || '') !== 'Entregue') {
      return res.status(400).json({ error: 'Só é possível voltar para Em expedição quando a requisição está Entregue.' });
    }
    if (row.tra_gerada_em) {
      return res.status(400).json({ error: 'Não é possível voltar para Em expedição após gerar a TRA.' });
    }

    await pool.query(
      `UPDATE requisicoes
       SET status = 'EM EXPEDICAO',
           entregue_em = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    return res.json(updated.rows[0]);
  } catch (error) {
    console.error('Erro ao voltar para Em expedição:', error);
    return res.status(500).json({ error: 'Erro ao voltar para Em expedição', details: error.message });
  }
});

// Cancelar requisição com regra por fase:
// - pendente / separado => status "cancelada"
// - EM_EXPEDICAO        => mantém status e marca flag de cancelamento
router.patch('/:id/cancelar', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.armazem_origem_id,
         r.armazem_id,
         r.separador_usuario_id,
         ao.tipo AS armazem_origem_tipo,
         a.tipo AS armazem_destino_tipo,
         COALESCE(r.cancelada_em_expedicao, false) AS cancelada_em_expedicao
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    const row = check.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, row.armazem_origem_id, { requisicao: row })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) {
      return respostaBloqueioSeparador(res);
    }

    const st = String(row.status || '');
    if (st === 'cancelada') {
      return res.status(400).json({ error: 'Requisição já está cancelada.' });
    }
    if (!['pendente', 'separado', 'EM EXPEDICAO'].includes(st)) {
      return res.status(400).json({
        error: 'Só é permitido cancelar requisições em Pendente, Separadas ou Em expedição.'
      });
    }

    if (st === 'EM EXPEDICAO') {
      await pool.query(
        `UPDATE requisicoes
         SET cancelada_em_expedicao = true,
             cancelada_em = CURRENT_TIMESTAMP,
             cancelada_por_usuario_id = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, req.user?.id || null]
      );
    } else {
      await pool.query(
        `UPDATE requisicoes
         SET status = 'cancelada',
             cancelada_em_expedicao = false,
             cancelada_em = CURRENT_TIMESTAMP,
             cancelada_por_usuario_id = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, req.user?.id || null]
      );
      await pool.query(
        `UPDATE stock_serial
         SET status = 'disponivel',
             requisicao_id = NULL,
             requisicao_item_id = NULL,
             reservado_em = NULL,
             atualizado_em = CURRENT_TIMESTAMP
         WHERE requisicao_id = $1
           AND status = 'reservado'`,
        [id]
      );
      await liberarReservasLotePorRequisicao(pool, {
        requisicaoId: Number(id),
        usuarioId: req.user?.id || null,
        origem: 'cancelar-requisicao',
      });
    }

    const updated = await getRequisicaoComItens(id);
    return res.json(updated);
  } catch (error) {
    if (error.code === '42703') {
      return res.status(503).json({
        error: 'Coluna cancelada_em_expedicao não existe no banco.',
        details: 'Execute a migração: server/Migrate/migrate-requisicoes-cancelamento-expedicao.sql'
      });
    }
    console.error('Erro ao cancelar requisição:', error);
    return res.status(500).json({ error: 'Erro ao cancelar requisição', details: error.message });
  }
});

// Após gerar TRFL de cancelamento em EM_EXPEDICAO, concluir o cancelamento:
// move para status "cancelada" e desliga a flag operacional.
router.patch('/:id/concluir-cancelamento-expedicao', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.armazem_origem_id,
         r.armazem_id,
         r.separador_usuario_id,
         COALESCE(r.cancelada_em_expedicao, false) AS cancelada_em_expedicao,
         ao.tipo AS armazem_origem_tipo,
         a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Requisição não encontrada' });
    const row = check.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, row.armazem_origem_id, { requisicao: row })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) return respostaBloqueioSeparador(res);
    if (String(row.status || '') !== 'EM EXPEDICAO' || !row.cancelada_em_expedicao) {
      return res.status(400).json({
        error: 'Só é possível concluir cancelamento para requisição em Em expedição marcada como cancelada.'
      });
    }

    await pool.query(
      `UPDATE requisicoes
       SET status = 'cancelada',
           cancelada_em_expedicao = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );
    await pool.query(
      `UPDATE stock_serial
       SET status = 'disponivel',
           requisicao_id = NULL,
           requisicao_item_id = NULL,
           reservado_em = NULL,
           atualizado_em = CURRENT_TIMESTAMP
       WHERE requisicao_id = $1
         AND status = 'reservado'`,
      [id]
    );
    await liberarReservasLotePorRequisicao(pool, {
      requisicaoId: Number(id),
      usuarioId: req.user?.id || null,
      origem: 'concluir-cancelamento-expedicao',
    });
    const updated = await getRequisicaoComItens(id);
    return res.json(updated);
  } catch (error) {
    console.error('Erro ao concluir cancelamento em expedição:', error);
    return res.status(500).json({ error: 'Erro ao concluir cancelamento', details: error.message });
  }
});

// Marcar como FINALIZADO (após baixar a TRA e concluir o processo)
router.patch('/:id/finalizar', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.armazem_id,
         r.armazem_origem_id,
         r.separador_usuario_id,
         r.tra_gerada_em,
         r.tra_numero,
         r.devolucao_tra_gerada_em,
         r.devolucao_trfl_gerada_em,
         r.devolucao_tra_apeados_gerada_em,
         r.devolucao_tra_apeados_numero,
         r.devolucao_trfl_pendente_gerada_em,
         ao.tipo AS origem_tipo,
         ad.tipo AS destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
       LEFT JOIN armazens ad ON ad.id = r.armazem_id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Requisição não encontrada' });
    const rowPre = check.rows[0];
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, rowPre.armazem_origem_id, {
        requisicao: {
          ...rowPre,
          armazem_origem_tipo: rowPre.origem_tipo,
          armazem_destino_tipo: rowPre.destino_tipo,
        },
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (check.rows[0].status === 'cancelada') return res.status(400).json({ error: 'Requisição cancelada' });
    const row = check.rows[0];
    const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(row.origem_tipo, row.destino_tipo);
    const fluxoCentralApeado =
      String(row.origem_tipo || '').trim().toLowerCase() === 'central' &&
      String(row.destino_tipo || '').trim().toLowerCase() === 'apeado';
    if (fluxoDevolucao) {
      const temMarcacaoDev = Boolean(row.devolucao_tra_gerada_em);
      const temNumeroDev = Boolean(String(row.tra_numero || '').trim());
      if (!temMarcacaoDev && !temNumeroDev) {
        return res.status(400).json({
          error: 'No fluxo de devolução, só é possível finalizar com DEV gerado.',
        });
      }
      if (!['EM EXPEDICAO', 'APEADOS', 'Entregue'].includes(String(row.status || ''))) {
        return res.status(400).json({
          error: 'No fluxo de devolução, finalize apenas em Em processo, APEADOS ou Entregue.',
        });
      }
      if (!String(row.tra_numero || '').trim()) {
        return res.status(400).json({ error: 'Preencha o número do DEV antes de finalizar a devolução.' });
      }
    } else if (fluxoCentralApeado) {
      if (!(['separado', 'Entregue'].includes(row.status) && Boolean(row.tra_gerada_em))) {
        return res.status(400).json({
          error: 'Para transferência Central -> APEADO, finalize apenas após gerar a TRA.'
        });
      }
      if (!String(row.tra_numero || '').trim()) {
        return res.status(400).json({ error: 'Preencha o número da TRA antes de finalizar a requisição.' });
      }
    } else if (row.status !== 'Entregue') {
      return res.status(400).json({ error: 'Só é possível finalizar requisições com status Entregue.' });
    } else if (!String(row.tra_numero || '').trim()) {
      return res.status(400).json({ error: 'Preencha o número da TRA antes de finalizar a requisição.' });
    }

    if (fluxoDevolucao) {
      const cFin = await pool.connect();
      try {
        await cFin.query('BEGIN');
        const lockFin = await cFin.query(
          `SELECT id, armazem_id, devolucao_apeado_destino_id, devolucao_trfl_gerada_em, observacoes
           FROM requisicoes
           WHERE id = $1
           FOR UPDATE`,
          [id]
        );
        if (!lockFin.rows.length) {
          await cFin.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada' });
        }
        const finRow = lockFin.rows[0];
        const requisicaoAtual = await getRequisicaoComItens(id);
        if (!requisicaoAtual) {
          await cFin.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada' });
        }
        const bobinasResult = await cFin.query(
          `SELECT b.*, ri.id AS requisicao_item_id, ri.item_id AS item_id, i.codigo AS item_codigo
           FROM requisicoes_itens_bobinas b
           INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
           INNER JOIN itens i ON ri.item_id = i.id
           WHERE ri.requisicao_id = $1
           ORDER BY ri.id, b.id`,
          [id]
        );
        const bobinasByRequisicaoItemId = new Map();
        for (const b of bobinasResult.rows || []) {
          const rid = Number(b.requisicao_item_id);
          if (!Number.isFinite(rid)) continue;
          if (!bobinasByRequisicaoItemId.has(rid)) bobinasByRequisicaoItemId.set(rid, []);
          bobinasByRequisicaoItemId.get(rid).push(b);
        }

        let observacoesFinal = String(finRow.observacoes || '');
        const podeControlarStock = usuarioTemPermissaoControloStock(req);
        if (!markerFlagAtivo(observacoesFinal, DEV_RECEBIMENTO_STOCK_APLICADO_MARKER)) {
          let entradaDevolucaoJaAplicada = false;
          try {
            const jaAplicadaQ = await cFin.query(
              `SELECT 1
               FROM stock_movimentos_auditoria
               WHERE requisicao_id = $1
                 AND tipo IN ('entrada_devolucao_lote', 'entrada_devolucao_serial')
               LIMIT 1`,
              [id]
            );
            entradaDevolucaoJaAplicada = jaAplicadaQ.rows.length > 0;
          } catch (stAuditErr) {
            if (stAuditErr.code !== '42P01') throw stAuditErr;
          }
          if (!entradaDevolucaoJaAplicada) {
            const centralId = finRow.armazem_id;
            if (centralId) {
              let locRecCentral = await localizacaoArmazemPorTipoConn(cFin, centralId, 'recebimento');
              if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;
              try {
                await aplicarStockDevolucaoEntradaRecebimento(cFin, {
                  centralId,
                  locRec: locRecCentral,
                  itensComFerramenta: requisicaoAtual.itens || [],
                  bobinas: bobinasResult.rows || [],
                });
              } catch (stEntrada) {
                if (stEntrada.code !== '42P01') throw stEntrada;
              }
            }
          }
          observacoesFinal = upsertMarkerFlag(observacoesFinal, DEV_RECEBIMENTO_STOCK_APLICADO_MARKER, true);
        }
        if (markerFlagAtivo(observacoesFinal, DEV_APEADOS_STOCK_PENDENTE_MARKER)) {
          if (podeControlarStock) {
            const centralId = finRow.armazem_id;
            const destinoApeadoId = Number(finRow.devolucao_apeado_destino_id || 0) || null;
            if (centralId && destinoApeadoId) {
              let locRecCentral = await localizacaoArmazemPorTipoConn(cFin, centralId, 'recebimento');
              if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;
              let locRecApeado = await localizacaoArmazemPorTipoConn(cFin, destinoApeadoId, 'recebimento');
              if (!locRecApeado) {
                const apeadoQ = await cFin.query('SELECT codigo FROM armazens WHERE id = $1', [destinoApeadoId]);
                locRecApeado = String(apeadoQ.rows?.[0]?.codigo || '').trim();
              }
              if (!locRecApeado) {
                throw makeStockPrepBizError(400, 'Localização de recebimento do armazém APEADO não encontrada.');
              }
              const apeadosItens = (requisicaoAtual.itens || []).filter((it) => (parseInt(it.quantidade_apeados ?? 0, 10) || 0) > 0);
              try {
                await aplicarStockTraApeadosDevolucao(cFin, {
                  centralId,
                  locOrigemCentral: locRecCentral,
                  destinoApeadoId,
                  locRecApeado,
                  apeadosItens,
                  bobinasByRequisicaoItemId,
                });
              } catch (stApe) {
                if (stApe.code !== '42P01') throw stApe;
              }
            }
          }
          observacoesFinal = upsertMarkerFlag(observacoesFinal, DEV_APEADOS_STOCK_PENDENTE_MARKER, false);
        }

        if (markerFlagAtivo(observacoesFinal, DEV_TRFL_PENDENTE_STOCK_MARKER)) {
          if (podeControlarStock) {
            const centralId = finRow.armazem_id;
            if (centralId) {
              let locRecCentral = await localizacaoArmazemPorTipoConn(cFin, centralId, 'recebimento');
              if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;
              const locRows = await cFin.query(
                'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
                [centralId]
              );
              const codigoCentral = String(requisicaoAtual.armazem_destino_codigo || '').trim() || 'E';
              const { localizacaoNormal } = computeDestLocFerrNormal(codigoCentral, locRows.rows || []);
              const locOrigemMovimento = finRow.devolucao_trfl_gerada_em ? localizacaoNormal : locRecCentral;
              const itemLocalizacoes = {};
              for (const it of requisicaoAtual.itens || []) {
                const rid = Number(it.id);
                if (!Number.isFinite(rid)) continue;
                const loc = getTaggedValue(it.observacoes, TRFL_PENDENTE_LOC_TAG);
                if (loc) itemLocalizacoes[String(rid)] = loc;
              }
              try {
                await aplicarStockTrflPendenteDevolucao(cFin, {
                  centralId,
                  locOrigemMovimento,
                  localizacaoDefault: null,
                  itemLocalizacoes,
                  itens: requisicaoAtual.itens || [],
                  bobinasByRequisicaoItemId,
                });
              } catch (stPend) {
                if (stPend.code !== '42P01') throw stPend;
              }
            }
          }
          observacoesFinal = upsertMarkerFlag(observacoesFinal, DEV_TRFL_PENDENTE_STOCK_MARKER, false);
        }

        await cFin.query(
          `UPDATE requisicoes
           SET status = 'FINALIZADO',
               devolucao_tra_gerada_em = COALESCE(devolucao_tra_gerada_em, CURRENT_TIMESTAMP),
               finalizado_em = CURRENT_TIMESTAMP,
               observacoes = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, observacoesFinal]
        );
        await cFin.query('COMMIT');
      } catch (eFin) {
        await cFin.query('ROLLBACK').catch(() => {});
        if (eFin.isStockPrepBiz) {
          return res.status(eFin.status).json(eFin.payload);
        }
        throw eFin;
      } finally {
        cFin.release();
      }
    } else {
      const cFinNormal = await pool.connect();
      try {
        await cFinNormal.query('BEGIN');
        await cFinNormal.query(
          'UPDATE requisicoes SET status = $1, finalizado_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['FINALIZADO', id]
        );
        // Fluxo normal: garantir consumo definitivo dos seriais reservados
        // mesmo quando a requisição foi finalizada sem exportar TRA.
        const consumed = await cFinNormal.query(
          `UPDATE stock_serial
           SET status = 'consumido',
               consumido_em = COALESCE(consumido_em, CURRENT_TIMESTAMP),
               atualizado_em = CURRENT_TIMESTAMP
           WHERE requisicao_id = $1
             AND status = 'reservado'
           RETURNING item_id, armazem_id, localizacao, lote, serialnumber, requisicao_item_id`,
          [id]
        );
        for (const row of consumed.rows || []) {
          // eslint-disable-next-line no-await-in-loop
          await logStockMovimento({
            db: cFinNormal,
            tipo: 'consumo_finalizar',
            itemId: row.item_id,
            armazemId: row.armazem_id,
            localizacao: row.localizacao,
            lote: row.lote,
            serialnumber: row.serialnumber,
            quantidade: 1,
            requisicaoId: parseInt(id, 10),
            requisicaoItemId: row.requisicao_item_id,
            usuarioId: req.user?.id || null,
            payload: { origem: 'finalizar' },
          });
        }
        // Fallback: consumir também seriais explicitamente associados aos itens da requisição,
        // mesmo que não estejam com status "reservado" no momento do fechamento.
        // Isto cobre cenários em que a seleção de seriais foi gravada em
        // requisicoes_itens_seriais, mas o vínculo de reserva em stock_serial não persistiu.
        try {
          const consumedAssociados = await cFinNormal.query(
            `WITH seriais_req AS (
               SELECT
                 ri.id AS requisicao_item_id,
                 ri.item_id,
                 UPPER(TRIM(ris.serialnumber)) AS sn_key
               FROM requisicoes_itens ri
               INNER JOIN requisicoes_itens_seriais ris ON ris.requisicao_item_id = ri.id
               WHERE ri.requisicao_id = $1
                 AND TRIM(COALESCE(ris.serialnumber, '')) <> ''
             )
             UPDATE stock_serial s
             SET status = 'consumido',
                 consumido_em = COALESCE(s.consumido_em, CURRENT_TIMESTAMP),
                 requisicao_id = COALESCE(s.requisicao_id, $1),
                 requisicao_item_id = COALESCE(s.requisicao_item_id, sr.requisicao_item_id),
                 atualizado_em = CURRENT_TIMESTAMP
             FROM seriais_req sr
             WHERE s.item_id = sr.item_id
               AND s.armazem_id = $2
               AND UPPER(TRIM(s.serialnumber)) = sr.sn_key
               AND s.status IN ('disponivel', 'reservado')
             RETURNING s.item_id, s.armazem_id, s.localizacao, s.lote, s.serialnumber, s.requisicao_item_id`,
            [id, row.armazem_origem_id]
          );
          for (const rowAssoc of consumedAssociados.rows || []) {
            // eslint-disable-next-line no-await-in-loop
            await logStockMovimento({
              db: cFinNormal,
              tipo: 'consumo_finalizar_assoc',
              itemId: rowAssoc.item_id,
              armazemId: rowAssoc.armazem_id,
              localizacao: rowAssoc.localizacao,
              lote: rowAssoc.lote,
              serialnumber: rowAssoc.serialnumber,
              quantidade: 1,
              requisicaoId: parseInt(id, 10),
              requisicaoItemId: rowAssoc.requisicao_item_id,
              usuarioId: req.user?.id || null,
              payload: { origem: 'finalizar-associado' },
            });
          }
        } catch (eAssoc) {
          if (eAssoc.code !== '42P01') throw eAssoc;
        }
        await cFinNormal.query('COMMIT');
      } catch (eFinNormal) {
        await cFinNormal.query('ROLLBACK').catch(() => {});
        throw eFinNormal;
      } finally {
        cFinNormal.release();
      }
    }
    schedulePersistMovimentosHistoricoForRequisicoes([id], 'finalizar requisição');
    res.json({ ok: true, id: parseInt(id, 10), status: 'FINALIZADO' });
  } catch (error) {
    console.error('Erro ao finalizar requisição:', error);
    res.status(500).json({ error: 'Erro ao finalizar requisição', details: error.message });
  }
});

router.patch('/:id/tra-numero', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const traNumeroRaw = String(req.body?.tra_numero || '').trim();
    if (!traNumeroRaw) {
      return res.status(400).json({ error: 'Número da TRA é obrigatório.' });
    }
    const check = await pool.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id, r.tra_gerada_em,
              r.devolucao_tra_gerada_em, r.tra_numero, r.observacoes,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Requisição não encontrada' });
    const row = check.rows[0];
    // Devolução: escopo é o armazém central (armazem_id).
    // Fluxo normal: escopo segue o armazém de origem (armazem_origem_id).
    const armazemScopeId = row.devolucao_tra_gerada_em ? row.armazem_id : row.armazem_origem_id;
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, armazemScopeId, {
        requisicao: row,
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) {
      return respostaBloqueioSeparador(res);
    }
    const isRecebimentoTransfer = hasRecebimentoMarker(row);
    if (
      !row.tra_gerada_em &&
      !row.devolucao_tra_gerada_em &&
      !isRecebimentoTransfer
    ) {
      return res.status(400).json({ error: 'Gere a TRA/DEV antes de informar o número.' });
    }
    const isDevolucaoFluxo = Boolean(row.devolucao_tra_gerada_em);
    const traJaDefinida = Boolean(String(row.tra_numero || '').trim());
    if (isDevolucaoFluxo && traJaDefinida && ['Entregue', 'FINALIZADO'].includes(String(row.status || ''))) {
      return res.status(400).json({ error: 'Número da DEV não pode ser alterado após encerrar a devolução.' });
    }
    const traNumero = formatarNumeroTraDev(traNumeroRaw, isDevolucaoFluxo ? 'DEV' : 'TRA');

    const statusDestino = row.status;
    const up = await pool.query(
      `UPDATE requisicoes
       SET tra_numero = $1,
           status = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, tra_numero, status`,
      [traNumero, statusDestino, id]
    );
    const reqIdNum = parseInt(id, 10);
    if (Number.isFinite(reqIdNum)) {
      schedulePersistMovimentosHistoricoForRequisicoes([reqIdNum], 'tra-numero');
    }
    const origemTipo = String(row.armazem_origem_tipo || '').trim().toLowerCase();
    const destinoTipo = String(row.armazem_destino_tipo || '').trim().toLowerCase();
    const fluxoCentralApeado = origemTipo === 'central' && destinoTipo === 'apeado';
    return res.json({
      ok: true,
      id: up.rows[0].id,
      tra_numero: up.rows[0].tra_numero,
      status: up.rows[0].status,
      movimentos_registados: fluxoCentralApeado,
    });
  } catch (error) {
    if (error && error.code === '42703') {
      return res.status(503).json({
        error: 'Coluna tra_numero em falta na base de dados.',
        details: 'Execute a migração que adiciona o número da TRA em requisicoes.'
      });
    }
    console.error('Erro ao guardar número da TRA:', error);
    return res.status(500).json({ error: 'Erro ao guardar número da TRA', details: error.message });
  }
});

router.patch('/:id/devolucao-tra-apeados-numero', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    return res.status(410).json({
      error:
        'Número de TRA APEADOS manual foi descontinuado. O fluxo APEADOS agora segue tickets de transferência.',
      code: 'APEADOS_NUMBER_DEPRECATED',
    });
  } catch (error) {
    if (error && error.code === '42703') {
      return res.status(503).json({
        error: 'Coluna devolucao_tra_apeados_numero em falta na base de dados.',
        details: 'Execute a migração que adiciona o número da TRA APEADOS em requisicoes.'
      });
    }
    console.error('Erro ao guardar número da TRA APEADOS:', error);
    return res.status(500).json({ error: 'Erro ao guardar número da TRA APEADOS', details: error.message });
  }
});

  // =========================================================
  // Recebimento de transferência entre armazéns (UI “cards”)
  // =========================================================

  // Parse da Guia de Transporte (PDF) enviada pelo armazém de origem.
  // Regras:
  // - PDF contém 3 cópias (ORIGINAL, DUPLICADO, TRIPLICADO)
  // - Usar apenas a tabela da cópia ORIGINAL
  // - Extrair código do artigo da coluna "Designação dos Bens" (apenas código)
  // - Quantidade na coluna ao lado (na extração textual aparece antes de "UN")
  router.post(
    '/transferencias/recebimento/parse-guia-transporte',
    authenticateToken,
    requisicaoPerfilNegadoMiddleware,
    denyOperador,
    requisicaoScopeMiddleware,
    excelUploadRequisicoes.single('arquivo'),
    async (req, res) => {
      let tempPath = null;
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'Arquivo PDF da guia é obrigatório.' });
        }
        tempPath = req.file.path;
        const mime = String(req.file.mimetype || '').toLowerCase();
        const ext = String(req.file.originalname || '').toLowerCase();
        if (!(mime.includes('pdf') || ext.endsWith('.pdf'))) {
          return res.status(400).json({ error: 'Formato inválido. Envie um PDF.' });
        }

        const buffer = fs.readFileSync(tempPath);
        const textRaw = await extractPdfText(buffer);
        if (!textRaw.trim()) {
          return res.status(400).json({ error: 'Não foi possível extrair texto do PDF.' });
        }

        // 1) Isolar cópia ORIGINAL
        const originalAnchor = textRaw.search(/guia\s+de\s+transporte[\s\r\n]*original/i);
        if (originalAnchor < 0) {
          return res.status(400).json({ error: 'Cópia ORIGINAL não encontrada no PDF.' });
        }
        let originalText = textRaw.slice(originalAnchor);
        const endCandidates = [
          originalText.search(/--\s*1\s+of\s+\d+\s*--/i),
          originalText.search(/guia\s+de\s+transporte[\s\r\n]*duplicado/i),
          originalText.search(/guia\s+de\s+transporte[\s\r\n]*triplicado/i),
        ].filter((x) => x > 0);
        if (endCandidates.length > 0) {
          originalText = originalText.slice(0, Math.min(...endCandidates));
        }

        // 2) Encontrar a tabela da ORIGINAL
        const lines = originalText
          .split(/\r?\n/)
          .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const headerIdx = lines.findIndex((l) => /designa[cç][aã]o\s+dos\s+bens/i.test(l));
        if (headerIdx < 0) {
          return res.status(400).json({ error: 'Tabela de artigos não encontrada na cópia ORIGINAL.' });
        }

        const stopRegex = /(n\.?\s*[ºo]\s*total\s+de|impresso\s+na\s+data|p[aá]gina\s+\d+\s*\/\s*\d+)/i;
        const tableLines = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const ln = lines[i];
          if (stopRegex.test(ln)) break;
          tableLines.push(ln);
        }
        if (tableLines.length === 0) {
          return res.status(400).json({ error: 'Sem linhas de artigos na tabela ORIGINAL.' });
        }

        // 3) Extrair código + quantidade (tolerante a quebra de linha/formato).
        // Quantidade: número antes de UN/UND/UNID ou Mt/METROS (GT em PT); fallback ignora o código inicial (≥4 dígitos).
        const parseLocaleNumber = (raw) => {
          const s = String(raw || '').replace(/\s+/g, '');
          if (!s) return NaN;
          const lastComma = s.lastIndexOf(',');
          const lastDot = s.lastIndexOf('.');
          if (lastComma !== -1 && lastDot !== -1) {
            const decimalSep = lastComma > lastDot ? ',' : '.';
            const thousandSep = decimalSep === ',' ? '.' : ',';
            const noThousand = s.split(thousandSep).join('');
            const normalized = decimalSep === ',' ? noThousand.replace(',', '.') : noThousand;
            return Number(normalized);
          }
          if (lastComma !== -1) return Number(s.replace(',', '.'));
          return Number(s);
        };
        const startsNewItemRow = (text) => /^\s*\d{4,}\b/.test(String(text || ''));
        const extractCodigo = (text) => {
          const m = /^\s*(\d{4,})\b/.exec(String(text || ''));
          return m ? String(m[1]).trim() : null;
        };
        /** Unidades de quantidade na GT (PDF): caixas/unidades e comprimentos em metros. */
        const unidadeQuantidadeGt = '(?:UN|UND\\.?|UNID(?:\\.|ADE)?S?|MT|METROS?|M\\.?\\s*T\\.?)';
        const extractQuantidade = (text) => {
          const ln = String(text || '');
          const mQtyAntesUnidade = new RegExp(
            `(\\d{1,3}(?:[.\\s]\\d{3})*(?:,\\d+)?|\\d+(?:[.,]\\d+)?)\\s*${unidadeQuantidadeGt}\\b`,
            'i'
          ).exec(ln);
          if (mQtyAntesUnidade) return parseLocaleNumber(mQtyAntesUnidade[1]);
          // Sem coluna de unidade visível: ignorar o código no início (\\d{4,}) para não confundir
          // "300" de "3001789" com a quantidade (ex.: cabos em Mt).
          const restoSemCodigo = ln.replace(/^\s*\d{4,}\b\s*/i, '').trim();
          const nums =
            restoSemCodigo.match(/\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?/g) || [];
          for (const raw of nums) {
            const n = parseLocaleNumber(raw);
            if (Number.isFinite(n) && n > 0) return n;
          }
          return NaN;
        };

        // Agrupar linhas com base em quebra visual da grelha:
        // uma nova linha de item começa apenas quando a linha inicia com código numérico.
        // Linhas seguintes (mesmo com tokens alfanuméricos) são continuação da descrição.
        const grouped = [];
        for (const ln of tableLines) {
          if (startsNewItemRow(ln) || grouped.length === 0) {
            grouped.push(ln);
          } else {
            grouped[grouped.length - 1] = `${grouped[grouped.length - 1]} ${ln}`.trim();
          }
        }

        const byCodigo = new Map();
        for (let i = 0; i < grouped.length; i++) {
          const line = grouped[i];
          const codigo = extractCodigo(line);
          if (!codigo) continue;

          let qtd = extractQuantidade(line);
          if (!Number.isFinite(qtd) || qtd <= 0) {
            // fallback: tenta próxima linha agrupada (há PDFs em que a qty cai na linha seguinte)
            const next = grouped[i + 1] || '';
            qtd = extractQuantidade(`${line} ${next}`);
          }
          if (!Number.isFinite(qtd) || qtd <= 0) continue;
          byCodigo.set(codigo, (byCodigo.get(codigo) || 0) + qtd);
        }

        const itens = Array.from(byCodigo.entries()).map(([codigo, quantidade]) => ({
          codigo,
          quantidade,
        }));
        if (itens.length === 0) {
          return res.status(400).json({ error: 'Nenhum artigo válido encontrado na cópia ORIGINAL.' });
        }

        // Enriquecer com descrição cadastrada no sistema (quando existir).
        const codigos = itens.map((x) => String(x.codigo || '').trim().toUpperCase()).filter(Boolean);
        const placeholders = codigos.map((_, i) => `$${i + 1}`).join(',');
        let descByCode = new Map();
        if (codigos.length > 0) {
          const lookup = await pool.query(
            `SELECT codigo, descricao
             FROM itens
             WHERE UPPER(TRIM(codigo)) = ANY(ARRAY[${placeholders}])`,
            codigos
          );
          descByCode = new Map(
            (lookup.rows || []).map((r) => [String(r.codigo || '').trim().toUpperCase(), String(r.descricao || '').trim()])
          );
        }
        const itensComDescricao = itens.map((it) => {
          const k = String(it.codigo || '').trim().toUpperCase();
          return {
            ...it,
            descricao: descByCode.get(k) || '',
          };
        });

        return res.json({ itens: itensComDescricao, total_itens: itensComDescricao.length });
      } catch (e) {
        console.error('Erro ao interpretar guia de transporte PDF:', e);
        return res.status(500).json({ error: 'Erro ao interpretar guia de transporte PDF', details: e.message });
      } finally {
        if (tempPath) {
          try {
            fs.unlinkSync(tempPath);
          } catch (_) {}
        }
      }
    }
  );

  // Criar “transferência a receber” a partir de uma lista de materiais.
  // Guarda marcador em `requisicoes.observacoes` e inicializa status em `pendente`.
  // Nesta implementação:
  // - requisicoes.armazem_origem_id = armazém destino (onde o utilizador recebe)
  // - requisicoes.armazem_id      = armazém origem (de onde vêm os bens)
    router.post(
    '/transferencias/recebimento',
    ...requisicaoAuth,
    denyOperador,
    async (req, res) => {
      const client = await pool.connect();
      let recebimentoTxCommitted = false;
      try {
        await client.query('BEGIN');

        const { origem_armazem_id, recebimento_armazem_id, origem_fornecedor, itens, observacoes } = req.body || {};

        const origemId = parseInt(String(origem_armazem_id || ''), 10);
        const recebimentoId = parseInt(String(recebimento_armazem_id || ''), 10);
        const origemFornecedor = origem_fornecedor === true || String(origem_fornecedor || '') === '1';
        if ((!origemFornecedor && !Number.isFinite(origemId)) || !Number.isFinite(recebimentoId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Campos obrigatórios: origem_armazem_id e recebimento_armazem_id.' });
        }
        if (!origemFornecedor && origemId === recebimentoId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Origem e recebimento devem ser armazéns diferentes.' });
        }

        if (!Array.isArray(itens) || itens.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Campo obrigatório: itens (array com pelo menos 1 linha).' });
        }

        // Scope: como a requisição será criada com armazem_origem_id = recebimentoId,
        // garantimos que o utilizador tem acesso a esse armazém (via requisicaoScopeMiddleware).
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(recebimentoId)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso ao armazém de recebimento.' });
          }
        }

        // Validar armazéns
        let origemIdFinal = origemId;
        let origemArm = null;
        if (origemFornecedor) {
          const origemFornecedorQ = await client.query(
            `SELECT id, tipo, ativo
             FROM armazens
             WHERE ativo = true
               AND (
                 UPPER(TRIM(codigo)) = 'FORNECEDOR'
                 OR UPPER(TRIM(descricao)) = 'FORNECEDOR'
               )
             ORDER BY id ASC
             LIMIT 1`
          );
          origemArm = origemFornecedorQ.rows[0] || null;
          if (!origemArm) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Armazém FORNECEDOR não encontrado. Cadastre um armazém com código ou descrição "FORNECEDOR".' });
          }
          origemIdFinal = Number(origemArm.id);
        } else {
          const origemArmQ = await client.query('SELECT id, tipo, codigo, descricao, ativo FROM armazens WHERE id = $1', [origemId]);
          origemArm = origemArmQ.rows[0] || null;
        }
        const recvArmQ = await client.query('SELECT id, tipo, codigo, descricao, ativo FROM armazens WHERE id = $1', [recebimentoId]);
        const recvArm = recvArmQ.rows[0];
        if (!origemArm || !recvArm || origemArm.ativo !== true || recvArm.ativo !== true) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Armazém origem/destino não encontrado ou inativo.' });
        }

        // Resolver itens por código -> item_id; fundir linhas com o mesmo código (qtd + seriais)
        const normalizeCode = (c) => String(c || '').trim();
        const mergedByCode = new Map();
        for (const x of itens || []) {
          const codigo = normalizeCode(x?.codigo);
          if (!codigo) continue;
          const k = codigo.toUpperCase();
          const q = Number(x?.quantidade);
          const linhasItem = extractSeriaisLinhasFromItemBody(x);
          if (!mergedByCode.has(k)) {
            mergedByCode.set(k, { codigo, quantidade: 0, seriais_linhas: [] });
          }
          const agg = mergedByCode.get(k);
          if (Number.isFinite(q) && q > 0) agg.quantidade += q;
          agg.seriais_linhas.push(...linhasItem);
        }
        for (const agg of mergedByCode.values()) {
          agg.seriais_linhas = dedupeSeriaisLinhasPorSerial(agg.seriais_linhas);
          agg.seriais = agg.seriais_linhas.map((r) => r.sn);
          const nSer = agg.seriais_linhas.length;
          const qNum = Number(agg.quantidade);
          if (nSer > 0 && (!Number.isFinite(qNum) || qNum < 1)) {
            agg.quantidade = nSer;
          }
        }

        const resolvedCodes = [...mergedByCode.values()].filter((l) => l.quantidade > 0);
        if (resolvedCodes.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Quantidades inválidas: cada linha tem de ter quantidade numérica > 0.' });
        }

        // SELECT por códigos normalizados (UPPER/TRIM)
        const codes = Array.from(new Set(resolvedCodes.map((x) => x.codigo))).slice(0, 500);
        const placeholders = codes.map((_, i) => `$${i + 1}`).join(',');
        const codeParams = codes.map((c) => String(c).trim().toUpperCase());
        const lookup = await client.query(
          `SELECT id, codigo, descricao, tipocontrolo
           FROM itens
           WHERE UPPER(TRIM(codigo)) = ANY(ARRAY[${placeholders}])`,
          codeParams
        );

        const byCode = new Map((lookup.rows || []).map((r) => [String(r.codigo || '').trim().toUpperCase(), r]));
        for (const l of resolvedCodes) {
          const k = String(l.codigo).trim().toUpperCase();
          if (!byCode.get(k)) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Código de artigo não encontrado no stock: ${l.codigo}` });
          }
        }

        for (const l of resolvedCodes) {
          const k = String(l.codigo).trim().toUpperCase();
          const itemRow = byCode.get(k);
          const tipo = String(itemRow.tipocontrolo || '').trim().toUpperCase();
          const ns = (l.seriais_linhas || l.seriais || []).length;
          if (ns > 0 && !isTipoControloSerial(tipo)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `O artigo ${l.codigo} não é controlado por S/N; remova os seriais indicados ou confirme o código.`,
            });
          }
          if (isTipoControloSerial(tipo) && ns > 0) {
            const qFloat = Number(l.quantidade);
            const qInt = Math.round(qFloat);
            if (!Number.isFinite(qFloat) || Math.abs(qFloat - qInt) > 1e-6) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: `Artigo ${l.codigo}: com lista de seriais a quantidade tem de ser inteira (recebido: ${l.quantidade}).`,
              });
            }
            if (qInt !== ns) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: `Artigo ${l.codigo}: quantidade (${qInt}) não coincide com o número de seriais (${ns}).`,
              });
            }
          }
        }

        // Inserir requisicao
        const obs = `${RECEBIMENTO_TRANSFERENCIA_MARKER}${observacoes ? `: ${observacoes}` : ''}`;
        const reqInsert = await client.query(
          `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
           VALUES ($1, $2, $3, $4, 'pendente')
           RETURNING id, status, armazem_origem_id, armazem_id, observacoes, created_at`,
          [recebimentoId, origemIdFinal, obs, req.user.id]
        );
        const requisicaoId = reqInsert.rows[0]?.id;

        let recebimentoFallbackSeriaisSemCodigoCaixa = false;

        // Inserir/atualizar itens e seriais esperados (requisicoes_itens_seriais)
        for (const l of resolvedCodes) {
          const k = String(l.codigo).trim().toUpperCase();
          const itemRow = byCode.get(k);
          await client.query(
            `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
             VALUES ($1, $2, $3)
             ON CONFLICT (requisicao_id, item_id)
             DO UPDATE SET quantidade = EXCLUDED.quantidade`,
            [requisicaoId, itemRow.id, l.quantidade]
          );
          const riRow = await client.query(
            `SELECT id FROM requisicoes_itens WHERE requisicao_id = $1 AND item_id = $2`,
            [requisicaoId, itemRow.id]
          );
          const riId = riRow.rows[0]?.id;
          if (riId && l.seriais_linhas && l.seriais_linhas.length > 0) {
            try {
              await client.query('DELETE FROM requisicoes_itens_seriais WHERE requisicao_item_id = $1', [riId]);
              const serialRowsJson = [];
              let ord = 0;
              for (const rowSn of l.seriais_linhas) {
                const sn = String(rowSn.sn || rowSn.serial || rowSn.serialnumber || '').trim();
                if (!sn) continue;
                ord += 1;
                const cxSrc = rowSn.caixa ?? rowSn.codigo_caixa;
                const caixaVal =
                  cxSrc != null && String(cxSrc).trim() ? String(cxSrc).trim() : null;
                const rowJ = { sn, ord };
                if (caixaVal) rowJ.caixa = caixaVal;
                serialRowsJson.push(rowJ);
              }
              if (serialRowsJson.length > 0) {
                const spBulk = `sp_bulk_sn_${riId}`.replace(/[^a-zA-Z0-9_]/g, '_');
                await client.query(`SAVEPOINT ${spBulk}`);
                try {
                  await client.query(
                    `INSERT INTO requisicoes_itens_seriais (requisicao_item_id, serialnumber, ordem, codigo_caixa)
                     SELECT $1::int, (e->>'sn')::text, (e->>'ord')::int,
                            NULLIF(TRIM(e->>'caixa'), '')::text
                     FROM jsonb_array_elements($2::jsonb) AS e`,
                    [riId, JSON.stringify(serialRowsJson)]
                  );
                  await client.query(`RELEASE SAVEPOINT ${spBulk}`);
                } catch (eBulk) {
                  await client.query(`ROLLBACK TO SAVEPOINT ${spBulk}`);
                  if (eBulk.code !== '42703') throw eBulk;
                  recebimentoFallbackSeriaisSemCodigoCaixa = true;
                  await client.query(
                    `INSERT INTO requisicoes_itens_seriais (requisicao_item_id, serialnumber, ordem)
                     SELECT $1::int, (e->>'sn')::text, (e->>'ord')::int
                     FROM jsonb_array_elements($2::jsonb) AS e`,
                    [riId, JSON.stringify(serialRowsJson)]
                  );
                }
              }
              const blobLinhas = l.seriais_linhas
                .map((rowSn) => {
                  const sn = String(rowSn.sn || rowSn.serial || rowSn.serialnumber || '').trim();
                  if (!sn) return null;
                  const cxSrc = rowSn.caixa ?? rowSn.codigo_caixa;
                  const cx =
                    cxSrc != null && String(cxSrc).trim() ? String(cxSrc).trim() : '';
                  return cx ? `${sn}\t${cx}` : sn;
                })
                .filter(Boolean)
                .join('\n');
              if (blobLinhas) {
                await client.query(`UPDATE requisicoes_itens SET serialnumber = $2 WHERE id = $1`, [
                  riId,
                  blobLinhas,
                ]);
              }
            } catch (eSer) {
              if (eSer.code === '42P01' || eSer.code === '42703') {
                await client.query('ROLLBACK');
                return res.status(503).json({
                  error: 'Tabela requisicoes_itens_seriais em falta ou desatualizada.',
                  details:
                    'Execute: npm run db:migrate:requisicoes-itens-seriais e npm run db:migrate:requisicoes-itens-seriais-caixa',
                });
              }
              throw eSer;
            }
          }
        }

        await client.query('COMMIT');
        recebimentoTxCommitted = true;

        const requisicao = await getRequisicaoComItens(requisicaoId);
        if (!requisicao) return res.status(500).json({ error: 'Erro ao recuperar requisição criada.' });
        // Garantir marker
        requisicao.itens = Array.isArray(requisicao.itens) ? requisicao.itens : [];
        if (recebimentoFallbackSeriaisSemCodigoCaixa) {
          requisicao.aviso_codigo_caixa =
            'A coluna codigo_caixa não existe na base de dados: as caixas não foram gravadas. Execute: npm run db:migrate:requisicoes-itens-seriais-caixa';
        }
        return res.status(201).json(requisicao);
      } catch (e) {
        if (!recebimentoTxCommitted) {
          await client.query('ROLLBACK').catch(() => {});
        }
        console.error('Erro ao criar recebimento transferência:', e);
        return res.status(500).json({ error: 'Erro ao criar recebimento transferência', details: e.message });
      } finally {
        client.release();
      }
    }
  );

  // Confirmar materiais (Pendente -> Em processo) marcando quantidades preparadas/confirmadas.
  router.patch(
    '/transferencias/recebimento/:id/confirmar',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const { itens } = req.body || {};
        if (!Array.isArray(itens) || itens.length === 0) {
          return res.status(400).json({ error: 'Campo obrigatório: itens (array).' });
        }

        const lock = await pool.query(
          `SELECT r.*
           FROM requisicoes r
           WHERE r.id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) return res.status(404).json({ error: 'Requisição não encontrada.' });
        const requisicao = lock.rows[0];

        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Esta requisição não é um recebimento de transferência.' });
        }

        if (String(requisicao.status || '') !== 'pendente') {
          return res.status(400).json({ error: 'Só é possível confirmar quando a requisição está pendente.' });
        }

        // Verificar acesso por armazem_origem_id (scope)
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(requisicao.armazem_origem_id)) {
            return res.status(403).json({ error: 'Sem acesso ao armazém de recebimento desta requisição.' });
          }
        }

        const ids = itens
          .map((x) => ({
            requisicao_item_id: parseInt(String(x?.requisicao_item_id || ''), 10),
            quantidade: Number(x?.quantidade_confirmada),
          }))
          .filter((x) => Number.isFinite(x.requisicao_item_id));

        if (!ids.length) return res.status(400).json({ error: 'Nenhuma linha válida de itens.' });

        // Garantir que confirmamos todos os itens da requisição
        const allItemsQ = await pool.query(
          `SELECT id FROM requisicoes_itens WHERE requisicao_id = $1`,
          [reqId]
        );
        const allItemIds = new Set((allItemsQ.rows || []).map((r) => r.id));
        const confirmedItemIds = new Set(ids.map((x) => x.requisicao_item_id));
        for (const iId of allItemIds) {
          if (!confirmedItemIds.has(iId)) {
            return res.status(400).json({
              error: 'Confirme todos os itens desta requisição.',
              missing_item_id: iId,
            });
          }
        }

        // Atualizar linhas e validar quantidades
        for (const l of ids) {
          const q = Number(l.quantidade);
          if (!Number.isFinite(q) || q <= 0) {
            return res.status(400).json({ error: `Quantidade inválida para item ${l.requisicao_item_id}.` });
          }
          await pool.query(
            `UPDATE requisicoes_itens
             SET quantidade_preparada = $1,
                 preparacao_confirmada = true,
                 quantidade_apeados = COALESCE(quantidade_apeados, 0)
             WHERE id = $2 AND requisicao_id = $3`,
            [q, l.requisicao_item_id, reqId]
          );
        }

        // Pendente -> Em processo (usamos EM EXPEDICAO como equivalente UI “Em processo”)
        await pool.query(
          `UPDATE requisicoes
           SET status = 'EM EXPEDICAO',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );

        const updated = await getRequisicaoComItens(reqId);
        return res.json(updated);
      } catch (e) {
        console.error('Erro ao confirmar recebimento transferência:', e);
        return res.status(500).json({ error: 'Erro ao confirmar recebimento transferência', details: e.message });
      }
    }
  );

  // Confirma entrega no recebimento e coloca destino em stand by de TRA da origem.
  router.patch(
    '/transferencias/recebimento/:id/confirmar-entrega',
    ...requisicaoAuth,
    async (req, res) => {
      const client = await pool.connect();
      try {
        const reqId = parseInt(String(req.params.id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        await client.query('BEGIN');
        const lock = await client.query(
          `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id
           FROM requisicoes r
           WHERE r.id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada.' });
        }
        const row = lock.rows[0];
        if (!hasRecebimentoMarker(row)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requisição não é do fluxo de recebimento de mercadoria.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(row.armazem_origem_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso a este recebimento.' });
          }
        }
        if (String(row.status || '') !== 'EM EXPEDICAO') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Só é possível confirmar entrega quando estiver Em processo.' });
        }

        const observacoesComEntrega = upsertMarkerFlag(row.observacoes, 'DELIVERY_CONFIRMED', true);
        const observacoesSemTraConfirmada = upsertMarkerFlag(observacoesComEntrega, 'TRA_CONFIRMED', false);
        await client.query(
          `UPDATE requisicoes
           SET status = 'EM EXPEDICAO',
               observacoes = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId, observacoesSemTraConfirmada]
        );

        // Se for recebimento automático ligado a transferência central->central,
        // reforça "Entregue" também na requisição de origem para permitir geração de TRA.
        const reqOrigemId = getAutoFromReqId(row);
        if (Number.isFinite(reqOrigemId)) {
          // Sincroniza as quantidades rececionadas no destino para a requisição de origem,
          // para que a TRA do armazém de origem use os valores efetivamente rececionados.
          const itensRecebQ = await client.query(
            `SELECT item_id, COALESCE(quantidade_preparada, quantidade, 0) AS quantidade_rececionada
             FROM requisicoes_itens
             WHERE requisicao_id = $1`,
            [reqId]
          );
          for (const it of itensRecebQ.rows || []) {
            const itemId = Number(it.item_id);
            const qRec = Number(it.quantidade_rececionada);
            if (!Number.isFinite(itemId) || !Number.isFinite(qRec)) continue;
            await client.query(
              `UPDATE requisicoes_itens
               SET quantidade_preparada = $1
               WHERE requisicao_id = $2 AND item_id = $3`,
              [qRec, reqOrigemId, itemId]
            );
          }

          await client.query(
            `UPDATE requisicoes
             SET status = 'Entregue',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [reqOrigemId]
          );
        }

        await client.query('COMMIT');
        const updated = await getRequisicaoComItens(reqId);
        return res.json({
          ...updated,
          requisicao_origem_id: Number.isFinite(reqOrigemId) ? reqOrigemId : null,
          aguardando_tra_origem: true,
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro ao confirmar entrega de recebimento:', e);
        return res.status(500).json({ error: 'Erro ao confirmar entrega', details: e.message });
      } finally {
        client.release();
      }
    }
  );

  // Confirma que o Nº TRA da origem foi validado no destino (libera finalização do recebimento).
  router.patch(
    '/transferencias/recebimento/:id/confirmar-tra',
    ...requisicaoAuth,
    async (req, res) => {
      const client = await pool.connect();
      try {
        const reqId = parseInt(String(req.params.id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        await client.query('BEGIN');
        const lock = await client.query(
          `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.tra_numero
           FROM requisicoes r
           WHERE r.id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada.' });
        }
        const row = lock.rows[0];
        if (!hasRecebimentoMarker(row)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requisição não é do fluxo de recebimento de mercadoria.' });
        }
        if (String(row.status || '') !== 'EM EXPEDICAO') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Só é possível confirmar TRA quando o recebimento estiver Em processo.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(row.armazem_origem_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso a este recebimento.' });
          }
        }
        if (!markerFlagAtivo(row.observacoes, 'DELIVERY_CONFIRMED')) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Confirme primeiro a entrega no recebimento.' });
        }
        const reqOrigemId = getAutoFromReqId(row);
        let traNumeroOrigem = '';
        if (Number.isFinite(reqOrigemId)) {
          const origemQ = await client.query(
            `SELECT id, tra_numero
             FROM requisicoes
             WHERE id = $1`,
            [reqOrigemId]
          );
          if (!origemQ.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Requisição de origem não encontrada.' });
          }
          traNumeroOrigem = String(origemQ.rows[0].tra_numero || '').trim();
          if (!traNumeroOrigem) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Aguardando Nº TRA do armazém de origem.' });
          }
        } else {
          // Fluxo manual/GT: sem vínculo de origem, validar Nº TRA salvo no próprio recebimento.
          traNumeroOrigem = String(row.tra_numero || '').trim();
          if (!traNumeroOrigem) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Guarde o Nº TRA neste recebimento antes de confirmar.' });
          }
        }

        const obsComTraConfirmada = upsertMarkerFlag(row.observacoes, 'TRA_CONFIRMED', true);
        await client.query(
          `UPDATE requisicoes
           SET observacoes = $2,
               tra_numero = COALESCE(NULLIF(TRIM(COALESCE(tra_numero, '')), ''), $3),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId, obsComTraConfirmada, traNumeroOrigem]
        );

        await client.query('COMMIT');
        const updated = await getRequisicaoComItens(reqId);
        return res.json({
          ...updated,
          requisicao_origem_id: reqOrigemId,
          requisicao_origem_tra_numero: traNumeroOrigem,
          recebimento_tra_confirmada: true,
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro ao confirmar TRA do recebimento:', e);
        return res.status(500).json({ error: 'Erro ao confirmar TRA', details: e.message });
      } finally {
        client.release();
      }
    }
  );

  router.get(
    '/transferencias/recebimento/monitor',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        let armazemId = parseInt(String(req.query.armazem_id || ''), 10);
        if (!Number.isFinite(armazemId) || armazemId <= 0) {
          const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
          if (allowed.length === 1) {
            armazemId = Number(allowed[0]);
          }
        }
        if (!Number.isFinite(armazemId) || armazemId <= 0) {
          return res.status(400).json({ error: 'armazem_id inválido.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
          if (!allowed.includes(armazemId)) {
            return res.status(403).json({ error: 'Sem acesso a este armazém.' });
          }
        }

        let limit = parseInt(String(req.query.limit || ''), 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = 40;
        limit = Math.min(200, limit);
        let offset = parseInt(String(req.query.offset || ''), 10);
        if (!Number.isFinite(offset) || offset < 0) offset = 0;

        const armazemQ = await pool.query(
          `SELECT codigo, descricao
           FROM armazens
           WHERE id = $1`,
          [armazemId]
        );
        const arm = armazemQ.rows[0] || {};
        const armCodigo = String(arm?.codigo || '').trim();
        const armDescricao = String(arm?.descricao || '').trim();
        const armazemLabel = armCodigo && armDescricao
          ? `${armCodigo} - ${armDescricao}`
          : (armCodigo || armDescricao);

        const targetLocation =
          String(req.query.localizacao || '').trim() ||
          (await localizacaoArmazemPorTipoConn(pool, armazemId, 'recebimento')) ||
          LOCALIZACAO_RECEBIMENTO_FALLBACK;
        const targetNorm = String(targetLocation || '').trim().toUpperCase();

        const reqQ = await pool.query(
          `SELECT r.id, r.status, r.created_at, r.updated_at, r.observacoes, r.tra_numero,
                  r.devolucao_tra_gerada_em, r.devolucao_tra_apeados_gerada_em,
                  r.armazem_id, r.armazem_origem_id
           FROM requisicoes r
           WHERE r.armazem_id = $1 OR r.armazem_origem_id = $1
           ORDER BY r.id DESC
           LIMIT 3000`,
          [armazemId]
        );
        const reqRows = reqQ.rows || [];
        const reqIds = reqRows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id));
        const itensByReqId = new Map();
        const rastreavelAggByReqItemId = new Map();
        const seriaisByReqItemId = new Map();
        const lotesByReqItemId = new Map();
        if (reqIds.length > 0) {
          const itensQ = await pool.query(
            `SELECT ri.id AS requisicao_item_id, ri.requisicao_id, ri.item_id, ri.quantidade, ri.quantidade_preparada, ri.quantidade_apeados,
                    ri.serialnumber, ri.lote,
                    i.codigo AS item_codigo, i.descricao AS item_descricao, i.tipocontrolo
             FROM requisicoes_itens ri
             INNER JOIN itens i ON i.id = ri.item_id
             WHERE ri.requisicao_id = ANY($1::int[])`,
            [reqIds]
          );
          for (const it of itensQ.rows || []) {
            const rid = Number(it.requisicao_id);
            if (!Number.isFinite(rid)) continue;
            if (!itensByReqId.has(rid)) itensByReqId.set(rid, []);
            itensByReqId.get(rid).push(it);
            const riId = Number(it.requisicao_item_id || 0);
            const loteRi = String(it?.lote || '').trim();
            if (Number.isFinite(riId) && loteRi) {
              if (!lotesByReqItemId.has(riId)) lotesByReqItemId.set(riId, []);
              const arrL = lotesByReqItemId.get(riId);
              if (!arrL.some((x) => String(x).trim().toUpperCase() === loteRi.toUpperCase())) arrL.push(loteRi);
            }
          }

          const bobinasQ = await pool.query(
            `SELECT b.requisicao_item_id, b.metros, b.serialnumber
             FROM requisicoes_itens_bobinas b
             INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
             WHERE ri.requisicao_id = ANY($1::int[])`,
            [reqIds]
          );
          for (const b of bobinasQ.rows || []) {
            const riId = Number(b.requisicao_item_id);
            if (!Number.isFinite(riId)) continue;
            const prev = rastreavelAggByReqItemId.get(riId) || { metros: 0, seriais: 0 };
            prev.metros += Number(b?.metros || 0) || 0;
            if (String(b?.serialnumber || '').trim()) prev.seriais += 1;
            rastreavelAggByReqItemId.set(riId, prev);
            const loteB = String(b?.lote || '').trim();
            if (loteB) {
              if (!lotesByReqItemId.has(riId)) lotesByReqItemId.set(riId, []);
              const arrL = lotesByReqItemId.get(riId);
              if (!arrL.some((x) => String(x).trim().toUpperCase() === loteB.toUpperCase())) arrL.push(loteB);
            }
          }

          const seriaisQ = await pool.query(
            `SELECT s.requisicao_item_id, s.serialnumber
             FROM requisicoes_itens_seriais s
             INNER JOIN requisicoes_itens ri ON ri.id = s.requisicao_item_id
             WHERE ri.requisicao_id = ANY($1::int[])`,
            [reqIds]
          );
          for (const s of seriaisQ.rows || []) {
            const riId = Number(s.requisicao_item_id);
            if (!Number.isFinite(riId)) continue;
            const sn = String(s?.serialnumber || '').trim();
            const prev = rastreavelAggByReqItemId.get(riId) || { metros: 0, seriais: 0 };
            if (sn) prev.seriais += 1;
            rastreavelAggByReqItemId.set(riId, prev);
            if (sn) {
              if (!seriaisByReqItemId.has(riId)) seriaisByReqItemId.set(riId, []);
              const arr = seriaisByReqItemId.get(riId);
              if (!arr.includes(sn)) arr.push(sn);
            }
          }
        }

        const pendenteEntries = [];
        const makeCategoriaKey = (categoria, codigo) =>
          `${String(categoria || 'devolucao').trim()}::${String(codigo || '').trim()}`;
        const addPendente = ({
          reqId,
          reqItemId,
          itemId,
          tipocontrolo,
          codigo,
          descricao,
          qtd,
          referencia,
          data,
          seriais = [],
          lotes = [],
          categoria = 'devolucao',
        }) => {
          const cod = String(codigo || '').trim();
          const q = Number(qtd || 0) || 0;
          if (!cod || q <= 0) return;
          const categoriaNorm = String(categoria || 'devolucao').trim() || 'devolucao';
          pendenteEntries.push({
            reqId: Number(reqId || 0) || null,
            reqItemId: Number(reqItemId || 0) || null,
            item_id: Number(itemId || 0) || null,
            tipocontrolo: String(tipocontrolo || '').trim(),
            codigo: cod,
            descricao: String(descricao || '').trim(),
            qtd: q,
            armazem: armazemLabel,
            referencia: String(referencia || '').trim(),
            data: String(data || '').trim(),
            seriais: Array.isArray(seriais) ? [...new Set(seriais.map((s) => String(s || '').trim()).filter(Boolean))] : [],
            lotes: Array.isArray(lotes) ? [...new Set(lotes.map((s) => String(s || '').trim()).filter(Boolean))] : [],
            categoria: categoriaNorm,
          });
        };

        for (const r of reqRows) {
          const itens = itensByReqId.get(Number(r.id)) || [];
          const obs = String(r?.observacoes || '');
          if (markerFlagAtivo(obs, RECEBIMENTO_MONITOR_CLEAR_TEST_MARKER)) continue;
          const isRecebimentoReq = hasRecebimentoMarker(r);
          const isRecebimento = isRecebimentoReq
            && markerFlagAtivo(obs, 'TRA_CONFIRMED')
            && Number(r?.armazem_origem_id) === armazemId
            && String(r?.status || '') === 'FINALIZADO';
          if (isRecebimento) {
            for (const it of itens) {
              const riId = Number(it?.requisicao_item_id || 0);
              const rastAgg = Number.isFinite(riId) ? rastreavelAggByReqItemId.get(riId) : null;
              const seriaisInline = serialsNormalizadosList(it?.serialnumber).length;
              const qtd = quantidadeMonitorRececaoItem(it, rastAgg, seriaisInline);
              addPendente({
                reqId: r?.id,
                reqItemId: it?.requisicao_item_id,
                itemId: it?.item_id,
                tipocontrolo: it?.tipocontrolo,
                codigo: it?.item_codigo,
                descricao: it?.item_descricao,
                qtd,
                referencia: String(r?.tra_numero || 'TRA confirmado').trim(),
                data: String(r?.updated_at || r?.created_at || '').trim(),
                seriais: Number.isFinite(riId) ? (seriaisByReqItemId.get(riId) || []) : [],
                lotes: Number.isFinite(riId) ? (lotesByReqItemId.get(riId) || []) : [],
                categoria: 'recebimento',
              });
            }
          }

          const isDevolucao = !isRecebimentoReq && (
            Boolean(r?.devolucao_tra_gerada_em)
            || Boolean(String(r?.tra_numero || '').trim())
          );
          const elegivelDevolucao = isDevolucao
            && Number(r?.armazem_id) === armazemId
            && String(r?.status || '') === 'FINALIZADO';
          if (elegivelDevolucao) {
            for (const it of itens) {
              const riId = Number(it?.requisicao_item_id || 0);
              const rastAgg = Number.isFinite(riId) ? rastreavelAggByReqItemId.get(riId) : null;
              const seriaisInline = serialsNormalizadosList(it?.serialnumber).length;
              const base = quantidadeMonitorRececaoItem(it, rastAgg, seriaisInline);
              if (base <= 0) continue;
              const qApeados = Math.max(0, Number(it?.quantidade_apeados ?? 0) || 0);
              const qtdDevolucao = Math.max(0, base - qApeados);
              const qtdApeados = Math.min(base, qApeados);
              addPendente({
                reqId: r?.id,
                reqItemId: it?.requisicao_item_id,
                itemId: it?.item_id,
                tipocontrolo: it?.tipocontrolo,
                codigo: it?.item_codigo,
                descricao: it?.item_descricao,
                qtd: qtdDevolucao,
                referencia: String(r?.tra_numero || 'DEV devolução').trim(),
                data: String(r?.updated_at || r?.devolucao_tra_gerada_em || r?.created_at || '').trim(),
                seriais: Number.isFinite(riId) ? (seriaisByReqItemId.get(riId) || []) : [],
                lotes: Number.isFinite(riId) ? (lotesByReqItemId.get(riId) || []) : [],
                categoria: 'devolucao',
              });
              addPendente({
                reqId: r?.id,
                reqItemId: it?.requisicao_item_id,
                itemId: it?.item_id,
                tipocontrolo: it?.tipocontrolo,
                codigo: it?.item_codigo,
                descricao: it?.item_descricao,
                qtd: qtdApeados,
                referencia: String(r?.tra_numero || 'DEV devolução').trim(),
                data: String(r?.updated_at || r?.devolucao_tra_gerada_em || r?.created_at || '').trim(),
                seriais: Number.isFinite(riId) ? (seriaisByReqItemId.get(riId) || []) : [],
                lotes: Number.isFinite(riId) ? (lotesByReqItemId.get(riId) || []) : [],
                categoria: 'apeados',
              });
            }
          }
        }

        const makeDeltaKey = (categoriaBucket, codigo) =>
          `${String(categoriaBucket || 'nao_apeados').trim()}::${String(codigo || '').trim()}`;
        const ticketDeltasByCategoriaCodigo = new Map();
        if (await armazemMovimentacaoInternaTableExists()) {
          const tkQ = await pool.query(
            `SELECT i.codigo AS item_codigo,
                    ami.quantidade::float AS quantidade,
                    ami.trfl_gerada_em,
                    ami.tra_apeado_gerada_em,
                    COALESCE(ami.trfl_gerada_em, ami.tra_apeado_gerada_em, ami.created_at) AS evento_em,
                    ami.created_at,
                    lo.localizacao AS origem_localizacao_label,
                    ld.localizacao AS destino_localizacao_label,
                    ao.tipo AS origem_armazem_tipo,
                    ad.tipo AS destino_armazem_tipo
             FROM armazem_movimentacao_interna ami
             INNER JOIN itens i ON i.id = ami.item_id
             INNER JOIN armazens_localizacoes lo ON lo.id = ami.origem_localizacao_id
             INNER JOIN armazens_localizacoes ld ON ld.id = ami.destino_localizacao_id
             INNER JOIN armazens ao ON ao.id = lo.armazem_id
             INNER JOIN armazens ad ON ad.id = ld.armazem_id
             WHERE ami.armazem_id = $1
             ORDER BY ami.created_at DESC, ami.id DESC
             LIMIT 5000`,
            [armazemId]
          );
          for (const t of tkQ.rows || []) {
            if (!t?.trfl_gerada_em && !t?.tra_apeado_gerada_em) continue;
            const cod = String(t?.item_codigo || '').trim();
            const qtd = Number(t?.quantidade || 0) || 0;
            if (!cod || qtd <= 0) continue;
            const origemNorm = String(t?.origem_localizacao_label || '').trim().toUpperCase();
            const destinoNorm = String(t?.destino_localizacao_label || '').trim().toUpperCase();
            let delta = 0;
            if (origemNorm === targetNorm) delta -= qtd;
            if (destinoNorm === targetNorm) delta += qtd;
            if (delta === 0) continue;
            const origemTipo = String(t?.origem_armazem_tipo || '').trim().toLowerCase();
            const destinoTipo = String(t?.destino_armazem_tipo || '').trim().toLowerCase();
            const categoriaBucket =
              origemTipo === 'apeado' || destinoTipo === 'apeado'
                ? 'apeados'
                : 'nao_apeados';
            const deltaKey = makeDeltaKey(categoriaBucket, cod);
            if (!ticketDeltasByCategoriaCodigo.has(deltaKey)) ticketDeltasByCategoriaCodigo.set(deltaKey, []);
            ticketDeltasByCategoriaCodigo.get(deltaKey).push({
              delta,
              ts: Date.parse(String(t?.evento_em || t?.created_at || '')) || 0,
            });
          }
        }

        const adjustedEntries = pendenteEntries
          .map((row) => ({ ...row, qtd: Number(row?.qtd || 0) || 0 }))
          .filter((row) => row.qtd > 0);
        const entriesByDeltaGroup = new Map();
        for (const row of adjustedEntries) {
          const categoriaBucket =
            String(row?.categoria || '').trim().toLowerCase() === 'apeados'
              ? 'apeados'
              : 'nao_apeados';
          const key = makeDeltaKey(categoriaBucket, String(row?.codigo || '').trim());
          if (!entriesByDeltaGroup.has(key)) entriesByDeltaGroup.set(key, []);
          entriesByDeltaGroup.get(key).push(row);
        }
        for (const [deltaKey, tkDeltasRaw] of ticketDeltasByCategoriaCodigo.entries()) {
          const tkDeltas = (tkDeltasRaw || [])
            .map((d) => ({
              delta: Number(d?.delta || 0) || 0,
              ts: Number(d?.ts || 0) || 0,
            }))
            .filter((d) => d.delta !== 0)
            .sort((a, b) => a.ts - b.ts);
          if (!tkDeltas.length) continue;
          const group = entriesByDeltaGroup.get(deltaKey) || [];
          if (!group.length) continue;
          const withTsBase = group
            .map((g) => ({ g, ts: Date.parse(String(g?.data || '')) || 0 }))
            .sort((a, b) => (a.ts - b.ts) || (Number(a.g.reqId || 0) - Number(b.g.reqId || 0)));

          for (const d of tkDeltas) {
            const delta = d.delta;
            const ticketTs = Number(d.ts || 0) || 0;
            if (delta < 0) {
              let restante = Math.abs(delta);
              const elegiveis = withTsBase
                .filter((w) => ticketTs <= 0 || w.ts <= ticketTs)
                .sort((a, b) => a.ts - b.ts);
              for (const w of elegiveis) {
                if (restante <= 0) break;
                const atual = Number(w.g.qtd || 0) || 0;
                if (atual <= 0) continue;
                const consumo = Math.min(atual, restante);
                w.g.qtd = atual - consumo;
                restante -= consumo;
              }
              continue;
            }
            const elegiveisPos = withTsBase
              .filter((w) => ticketTs <= 0 || w.ts <= ticketTs)
              .sort((a, b) => a.ts - b.ts);
            const alvo = (elegiveisPos[elegiveisPos.length - 1] || withTsBase[withTsBase.length - 1])?.g;
            if (alvo) alvo.qtd = (Number(alvo.qtd || 0) || 0) + delta;
          }
        }
        const rowsByCategoriaCodigo = new Map();
        for (const row of adjustedEntries) {
          const qtd = Number(row?.qtd || 0) || 0;
          if (qtd <= 0) continue;
          const key = makeCategoriaKey(row?.categoria, row?.codigo);
          const prev = rowsByCategoriaCodigo.get(key) || {
            item_id: Number(row?.item_id || 0) || null,
            tipocontrolo: String(row?.tipocontrolo || '').trim(),
            codigo: String(row?.codigo || '').trim(),
            descricao: String(row?.descricao || '').trim(),
            qtd: 0,
            armazem: armazemLabel,
            referencia: String(row?.referencia || '').trim(),
            data: String(row?.data || '').trim(),
            seriais: Array.isArray(row?.seriais) ? row.seriais.slice(0, 400) : [],
            lotes: Array.isArray(row?.lotes) ? row.lotes.slice(0, 400) : [],
            categoria: String(row?.categoria || 'devolucao').trim() || 'devolucao',
          };
          prev.qtd += qtd;
          if (!prev.descricao && row?.descricao) prev.descricao = String(row.descricao).trim();
          if (!prev.item_id && Number(row?.item_id || 0) > 0) prev.item_id = Number(row.item_id);
          if (!prev.tipocontrolo && row?.tipocontrolo) prev.tipocontrolo = String(row.tipocontrolo).trim();
          if (!prev.referencia && row?.referencia) prev.referencia = String(row.referencia).trim();
          if (Array.isArray(row?.seriais) && row.seriais.length > 0) {
            const merged = [...new Set([...(prev.seriais || []), ...row.seriais].map((s) => String(s || '').trim()).filter(Boolean))];
            prev.seriais = merged.slice(0, 400);
          }
          if (Array.isArray(row?.lotes) && row.lotes.length > 0) {
            const mergedL = [...new Set([...(prev.lotes || []), ...row.lotes].map((s) => String(s || '').trim()).filter(Boolean))];
            prev.lotes = mergedL.slice(0, 400);
          }
          const prevTs = Date.parse(String(prev?.data || '')) || 0;
          const rowTs = Date.parse(String(row?.data || '')) || 0;
          if (rowTs > prevTs && row?.data) prev.data = String(row.data).trim();
          rowsByCategoriaCodigo.set(key, prev);
        }

        const allRows = [...rowsByCategoriaCodigo.values()]
          .sort((a, b) => {
            const q = Number(b.qtd || 0) - Number(a.qtd || 0);
            if (q !== 0) return q;
            const c = String(a.categoria || '').localeCompare(String(b.categoria || ''));
            if (c !== 0) return c;
            return String(a.codigo || '').localeCompare(String(b.codigo || ''));
          });

        const rows = allRows.slice(offset, offset + limit);
        const prefillByItemPart = new Map();
        for (const row of adjustedEntries) {
          const qtd = Number(row?.qtd || 0) || 0;
          if (qtd <= 0) continue;
          const categoria = String(row?.categoria || '').trim().toLowerCase();
          const particao = categoria === 'apeados' ? 'apeado' : 'normal';
          const key = [
            Number(row?.item_id || 0) || 0,
            String(row?.codigo || '').trim().toUpperCase(),
            particao,
          ].join('::');
          const prev = prefillByItemPart.get(key) || {
            item_id: Number(row?.item_id || 0) || null,
            codigo: String(row?.codigo || '').trim(),
            descricao: String(row?.descricao || '').trim(),
            tipocontrolo: String(row?.tipocontrolo || '').trim(),
            particao,
            quantidade: 0,
            seriais: [],
            referencias: [],
            lotes: [],
          };
          prev.quantidade += qtd;
          if (!prev.descricao && row?.descricao) prev.descricao = String(row.descricao).trim();
          if (!prev.tipocontrolo && row?.tipocontrolo) prev.tipocontrolo = String(row.tipocontrolo).trim();
          if (Array.isArray(row?.seriais) && row.seriais.length > 0) {
            prev.seriais = [...new Set([...(prev.seriais || []), ...row.seriais].map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 400);
          }
          if (Array.isArray(row?.lotes) && row.lotes.length > 0) {
            prev.lotes = [...new Set([...(prev.lotes || []), ...row.lotes].map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 400);
          }
          const ref = String(row?.referencia || '').trim();
          if (ref && !prev.referencias.includes(ref)) prev.referencias.push(ref);
          prefillByItemPart.set(key, prev);
        }
        const prefillItems = [...prefillByItemPart.values()]
          .sort((a, b) => {
            const c = String(a.codigo || '').localeCompare(String(b.codigo || ''));
            if (c !== 0) return c;
            return String(a.particao || '').localeCompare(String(b.particao || ''));
          });
        const totaisPorCategoria = allRows.reduce((acc, row) => {
          const key = String(row?.categoria || 'devolucao').trim() || 'devolucao';
          acc[key] = Number(acc[key] || 0) + Number(row?.qtd || 0);
          return acc;
        }, {});
        const contagensPorCategoria = allRows.reduce((acc, row) => {
          const key = String(row?.categoria || 'devolucao').trim() || 'devolucao';
          acc[key] = Number(acc[key] || 0) + 1;
          return acc;
        }, {});
        return res.json({
          total: allRows.length,
          limit,
          offset,
          updated_at: new Date().toISOString(),
          armazem_id: armazemId,
          armazem: armazemLabel,
          localizacao: targetLocation,
          totais_por_categoria: totaisPorCategoria,
          contagens_por_categoria: contagensPorCategoria,
          prefill_items: prefillItems,
          rows,
        });
      } catch (e) {
        console.error('Erro ao obter monitor de receção:', e);
        return res.status(500).json({ error: 'Erro ao obter monitor de receção', details: e.message });
      }
    }
  );

  router.post(
    '/transferencias/recebimento/monitor/limpar-teste',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        if (!isAdmin(req.user?.role)) {
          return res.status(403).json({ error: 'Ação permitida apenas para admin.' });
        }
        let armazemId = parseInt(String(req.body?.armazem_id || req.query?.armazem_id || ''), 10);
        if (!Number.isFinite(armazemId) || armazemId <= 0) {
          return res.status(400).json({ error: 'armazem_id inválido.' });
        }
        const reqQ = await pool.query(
          `SELECT id, observacoes
           FROM requisicoes
           WHERE status = 'FINALIZADO'
             AND (armazem_id = $1 OR armazem_origem_id = $1)
           ORDER BY id DESC
           LIMIT 4000`,
          [armazemId]
        );
        let updated = 0;
        for (const row of reqQ.rows || []) {
          const id = Number(row?.id || 0);
          if (!Number.isFinite(id) || id <= 0) continue;
          const nextObs = upsertMarkerFlag(row?.observacoes, RECEBIMENTO_MONITOR_CLEAR_TEST_MARKER, true);
          if (String(nextObs || '') === String(row?.observacoes || '')) continue;
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            `UPDATE requisicoes
             SET observacoes = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id, nextObs]
          );
          updated += 1;
        }
        return res.json({ ok: true, updated });
      } catch (e) {
        console.error('Erro ao limpar monitor de receção para teste:', e);
        return res.status(500).json({ error: 'Erro ao limpar zona de receção para teste', details: e.message });
      }
    }
  );

  router.get(
    '/transferencias/recebimento/:id/reporte-dados',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const requisicao = await getRequisicaoComItens(reqId);
        if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada.' });
        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Requisição não é um recebimento de transferência.' });
        }
        if (String(requisicao.status || '') !== 'EM EXPEDICAO') {
          return res.status(400).json({ error: 'Reporte só está disponível quando o recebimento está em processo.' });
        }

        const { columns, rows } = await buildRecebimentoMercadoriaReporteRows(pool, requisicao);
        return res.json({ columns, rows });
      } catch (e) {
        console.error('Erro ao obter dados do reporte de recebimento:', e);
        return res.status(500).json({ error: 'Erro ao obter reporte', details: e.message });
      }
    }
  );

  router.get(
    '/transferencias/recebimento/:id/reporte-dados-detalhado',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const requisicao = await getRequisicaoComItens(reqId);
        if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada.' });
        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Requisição não é um recebimento de transferência.' });
        }
        if (String(requisicao.status || '') !== 'EM EXPEDICAO') {
          return res.status(400).json({ error: 'Reporte só está disponível quando o recebimento está em processo.' });
        }

        const { columns, rows } = await buildRecebimentoMercadoriaReporteRowsDetalhado(pool, requisicao);
        return res.json({ columns, rows });
      } catch (e) {
        console.error('Erro ao obter dados do reporte detalhado de recebimento:', e);
        return res.status(500).json({ error: 'Erro ao obter reporte detalhado', details: e.message });
      }
    }
  );

  // Exportar report de material recebido
  router.get(
    '/transferencias/recebimento/:id/export-reporte',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const requisicao = await getRequisicaoComItens(reqId);
        if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada.' });
        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Requisição não é um recebimento de transferência.' });
        }
        if (String(requisicao.status || '') !== 'EM EXPEDICAO') {
          return res.status(400).json({ error: 'Reporte só está disponível quando o recebimento está em processo.' });
        }

        const { rows } = await buildRecebimentoMercadoriaReporteRows(pool, requisicao);

        await pool.query(
          `UPDATE requisicoes
           SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );

        const filename = `MATERIAL_RECEBIDO_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        await buildExcelReporte(rows, res, filename, { recebimentoMercadoria: true });
      } catch (e) {
        console.error('Erro ao exportar report material recebido:', e);
        return res.status(500).json({ error: 'Erro ao exportar report', details: e.message });
      }
    }
  );

  router.get(
    '/transferencias/recebimento/:id/export-reporte-detalhado',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const requisicao = await getRequisicaoComItens(reqId);
        if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada.' });
        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Requisição não é um recebimento de transferência.' });
        }
        if (String(requisicao.status || '') !== 'EM EXPEDICAO') {
          return res.status(400).json({ error: 'Reporte só está disponível quando o recebimento está em processo.' });
        }

        const { rows } = await buildRecebimentoMercadoriaReporteRowsDetalhado(pool, requisicao);

        await pool.query(
          `UPDATE requisicoes
           SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );

        const filename = `MATERIAL_RECEBIDO_detalhado_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        await buildExcelReporte(rows, res, filename, { recebimentoMercadoria: true });
      } catch (e) {
        console.error('Erro ao exportar report detalhado de recebimento:', e);
        return res.status(500).json({ error: 'Erro ao exportar report detalhado', details: e.message });
      }
    }
  );

  router.patch(
    '/transferencias/recebimento/:id/receber-stock',
    ...requisicaoAuth,
    denyOperador,
    async (req, res) => {
      const client = await pool.connect();
      try {
        if (!usuarioTemPermissaoControloStock(req)) {
          return res.status(403).json({ error: 'Sem permissão de controlo de stock.' });
        }
        const reqId = parseInt(String(req.params.id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        await client.query('BEGIN');
        const lock = await client.query(
          `SELECT id, status, observacoes, armazem_origem_id, tra_gerada_em, tra_baixa_expedicao_aplicada_em
           FROM requisicoes
           WHERE id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada.' });
        }
        const row = lock.rows[0];
        if (!hasRecebimentoMarker(row)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requisição não é do fluxo de recebimento de mercadoria.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(row.armazem_origem_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso a este recebimento.' });
          }
        }
        if (String(row.status || '') !== 'EM EXPEDICAO') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Só é possível receber stock quando estiver Em processo.' });
        }
        if (!row.tra_gerada_em) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Gere o report antes de receber stock.' });
        }
        if (row.tra_baixa_expedicao_aplicada_em) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Stock já recebido para esta requisição.' });
        }

        const itensQ = await client.query(
          `SELECT ri.id, ri.requisicao_id, ri.item_id, ri.quantidade, ri.quantidade_preparada,
                  ri.serialnumber, ri.lote, i.codigo AS item_codigo, i.tipocontrolo
           FROM requisicoes_itens ri
           INNER JOIN itens i ON i.id = ri.item_id
           WHERE ri.requisicao_id = $1`,
          [reqId]
        );
        const requisicaoItemIds = (itensQ.rows || []).map((x) => Number(x.id)).filter(Number.isFinite);
        const bobinasQ = requisicaoItemIds.length > 0
          ? await client.query(
              `SELECT b.requisicao_item_id, ri.item_id, b.lote, b.serialnumber, b.metros
               FROM requisicoes_itens_bobinas b
               INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
               WHERE b.requisicao_item_id = ANY($1::int[])`,
              [requisicaoItemIds]
            )
          : { rows: [] };
        const serialsByReqItemId = new Map();
        for (const b of bobinasQ.rows || []) {
          const rid = Number(b.requisicao_item_id);
          const sn = String(b.serialnumber || '').trim();
          if (!Number.isFinite(rid) || !sn) continue;
          if (!serialsByReqItemId.has(rid)) serialsByReqItemId.set(rid, []);
          serialsByReqItemId.get(rid).push(sn);
        }
        const itensComSeriaisBobinas = (itensQ.rows || []).map((ri) => {
          const snRi = String(ri.serialnumber || '').trim();
          if (snRi) return ri;
          const fromBobinas = serialsByReqItemId.get(Number(ri.id)) || [];
          if (!fromBobinas.length) return ri;
          return { ...ri, serialnumber: fromBobinas.join('\n') };
        });
        const itensComSeriais = await mergeRequisicaoItensSeriaisFromChildTable(client, itensComSeriaisBobinas);

        const locRec =
          (await localizacaoArmazemPorTipoConn(client, row.armazem_origem_id, 'recebimento')) ||
          LOCALIZACAO_RECEBIMENTO_FALLBACK;
        await aplicarStockDevolucaoEntradaRecebimento(client, {
          centralId: row.armazem_origem_id,
          locRec,
          itensComFerramenta: itensComSeriais,
          bobinas: bobinasQ.rows || [],
        });

        await client.query(
          `UPDATE requisicoes
           SET tra_baixa_expedicao_aplicada_em = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );
        await client.query('COMMIT');
        const updated = await getRequisicaoComItens(reqId);
        return res.json(updated);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro ao receber stock de recebimento:', e);
        return res.status(500).json({ error: 'Erro ao receber stock', details: e.message });
      } finally {
        client.release();
      }
    }
  );

  router.patch(
    '/transferencias/recebimento/:id/finalizar',
    ...requisicaoAuth,
    denyOperador,
    async (req, res) => {
      const client = await pool.connect();
      try {
        const reqId = parseInt(String(req.params.id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        await client.query('BEGIN');
        const lock = await client.query(
          `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.tra_baixa_expedicao_aplicada_em
           FROM requisicoes r
           WHERE r.id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada.' });
        }
        const row = lock.rows[0];
        if (!hasRecebimentoMarker(row)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requisição não é do fluxo de recebimento de mercadoria.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(row.armazem_origem_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso a este recebimento.' });
          }
        }
        if (String(row.status || '') !== 'EM EXPEDICAO') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Só é possível finalizar quando estiver Em processo.' });
        }
        if (!markerFlagAtivo(row.observacoes, 'TRA_CONFIRMED')) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Confirme a TRA do armazém de origem antes de finalizar.' });
        }
        const reqOrigemId = getAutoFromReqId(row);
        if (Number.isFinite(reqOrigemId)) {
          const origemQ = await client.query('SELECT tra_numero FROM requisicoes WHERE id = $1', [reqOrigemId]);
          const traNumeroOrigem = String(origemQ.rows?.[0]?.tra_numero || '').trim();
          if (!traNumeroOrigem) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Aguardando Nº TRA do armazém de origem para finalizar.' });
          }
        }

        // No recebimento, a entrada efetiva no stock acontece no finalizar.
        // Mantemos idempotência via tra_baixa_expedicao_aplicada_em para evitar duplicidade.
        if (!row.tra_baixa_expedicao_aplicada_em) {
          const itensQ = await client.query(
            `SELECT ri.id, ri.requisicao_id, ri.item_id, ri.quantidade, ri.quantidade_preparada,
                    ri.serialnumber, ri.lote, i.codigo AS item_codigo, i.tipocontrolo
             FROM requisicoes_itens ri
             INNER JOIN itens i ON i.id = ri.item_id
             WHERE ri.requisicao_id = $1`,
            [reqId]
          );
          const requisicaoItemIds = (itensQ.rows || []).map((x) => Number(x.id)).filter(Number.isFinite);
          const bobinasQ = requisicaoItemIds.length > 0
            ? await client.query(
                `SELECT b.requisicao_item_id, ri.item_id, b.lote, b.serialnumber, b.metros
                 FROM requisicoes_itens_bobinas b
                 INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
                 WHERE b.requisicao_item_id = ANY($1::int[])`,
                [requisicaoItemIds]
              )
            : { rows: [] };
          const serialsByReqItemId = new Map();
          for (const b of bobinasQ.rows || []) {
            const rid = Number(b.requisicao_item_id);
            const sn = String(b.serialnumber || '').trim();
            if (!Number.isFinite(rid) || !sn) continue;
            if (!serialsByReqItemId.has(rid)) serialsByReqItemId.set(rid, []);
            serialsByReqItemId.get(rid).push(sn);
          }
          const itensComSeriaisBobinas = (itensQ.rows || []).map((ri) => {
            const snRi = String(ri.serialnumber || '').trim();
            if (snRi) return ri;
            const fromBobinas = serialsByReqItemId.get(Number(ri.id)) || [];
            if (!fromBobinas.length) return ri;
            return { ...ri, serialnumber: fromBobinas.join('\n') };
          });
          const itensComSeriais = await mergeRequisicaoItensSeriaisFromChildTable(client, itensComSeriaisBobinas);
          const locRec =
            (await localizacaoArmazemPorTipoConn(client, row.armazem_origem_id, 'recebimento')) ||
            LOCALIZACAO_RECEBIMENTO_FALLBACK;
          await aplicarStockDevolucaoEntradaRecebimento(client, {
            centralId: row.armazem_origem_id,
            locRec,
            itensComFerramenta: itensComSeriais,
            bobinas: bobinasQ.rows || [],
          });
        }

        await client.query(
          `UPDATE requisicoes
           SET status = 'FINALIZADO',
               tra_baixa_expedicao_aplicada_em = COALESCE(tra_baixa_expedicao_aplicada_em, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );
        await client.query('COMMIT');
        schedulePersistMovimentosHistoricoForRequisicoes([reqId], 'finalizar recebimento');
        const updated = await getRequisicaoComItens(reqId);
        return res.json(updated);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro ao finalizar recebimento de mercadoria:', e);
        return res.status(500).json({ error: 'Erro ao finalizar recebimento', details: e.message });
      } finally {
        client.release();
      }
    }
  );


  return router;
}

module.exports = { createEstadosLogisticaRouter };
