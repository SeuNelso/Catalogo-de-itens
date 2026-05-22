const express = require('express');
const { isAdmin } = require('../../utils/roles');
const { usuarioTemPermissaoConsultaMovimentos } = require('../../utils/usuarioDbColumns');
const {
  buildDashboardViaturasPayload,
  fetchItensResumoRequisicao,
} = require('../../services/requisicoes/dashboardViaturas');

function createDashboardViaturasRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    denyOnlyOperador,
    requisicaoArmazemOrigemAcessoPermitido,
    attachSeriaisToRequisicaoItens,
    movimentosHistoricoTableExists,
    isFluxoDevolucaoViaturaCentral,
    RECEBIMENTO_TRANSFERENCIA_MARKER,
  } = deps;
  const router = express.Router();

  router.get('/dashboard-viaturas', ...requisicaoAuth, denyOnlyOperador, async (req, res) => {
    try {
      const roleNorm = String(req.user?.role || '').trim().toLowerCase();
      const roleTemAcessoDashboardOp = roleNorm === 'admin' || roleNorm === 'backoffice_operations';
      if (!usuarioTemPermissaoConsultaMovimentos(req) && !roleTemAcessoDashboardOp) {
        return res.status(403).json({ error: 'Sem permissão para o Dashboard OP.' });
      }

      const armazemIdRaw = parseInt(String(req.query?.armazem_id || ''), 10);
      const armazemIdFiltro =
        Number.isFinite(armazemIdRaw) && armazemIdRaw > 0 ? armazemIdRaw : null;

      if (
        !isAdmin(req.user?.role) &&
        armazemIdFiltro &&
        Array.isArray(req.requisicaoArmazemOrigemIds) &&
        !req.requisicaoArmazemOrigemIds.includes(armazemIdFiltro)
      ) {
        const allowed = req.requisicaoArmazemOrigemIds;
        const okDevolucaoScope = allowed.includes(armazemIdFiltro);
        if (!okDevolucaoScope) {
          return res.status(403).json({ error: 'Viatura fora do escopo do utilizador.' });
        }
      }

      const payload = await buildDashboardViaturasPayload(pool, {
        movimentosHistoricoTableExists,
        isFluxoDevolucaoViaturaCentral,
        RECEBIMENTO_TRANSFERENCIA_MARKER,
      }, {
        dataInicio: req.query?.data_inicio,
        dataFim: req.query?.data_fim,
        armazemIdFiltro,
        isAdmin: isAdmin(req.user?.role),
        allowedScopeIds: Array.isArray(req.requisicaoArmazemOrigemIds)
          ? req.requisicaoArmazemOrigemIds
          : [],
      });

      return res.json(payload);
    } catch (e) {
      console.error('Erro no dashboard viaturas:', e);
      return res.status(500).json({
        error: 'Erro ao carregar dashboard de viaturas',
        details: e.message,
      });
    }
  });

  router.get('/:id/itens-resumo', ...requisicaoAuth, denyOnlyOperador, async (req, res) => {
    try {
      const roleNorm = String(req.user?.role || '').trim().toLowerCase();
      const roleTemAcessoDashboardOp = roleNorm === 'admin' || roleNorm === 'backoffice_operations';
      if (!usuarioTemPermissaoConsultaMovimentos(req) && !roleTemAcessoDashboardOp) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }

      const reqId = parseInt(String(req.params.id || ''), 10);
      if (!Number.isFinite(reqId) || reqId <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
      }

      const payload = await fetchItensResumoRequisicao(pool, { attachSeriaisToRequisicaoItens }, reqId);
      if (!payload) {
        return res.status(404).json({ error: 'Requisição não encontrada.' });
      }
      if (
        !requisicaoArmazemOrigemAcessoPermitido(req, payload.requisicao.armazem_origem_id, {
          requisicao: payload.requisicao,
        })
      ) {
        return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
      }

      return res.json({ itens: payload.itens });
    } catch (e) {
      console.error('Erro itens-resumo dashboard:', e);
      return res.status(500).json({
        error: 'Erro ao carregar itens da requisição',
        details: e.message,
      });
    }
  });

  return router;
}

module.exports = { createDashboardViaturasRouter };
