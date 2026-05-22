const express = require('express');
const {
  confirmarSeparacao: confirmarSeparacaoService,
  completarSeparacao: completarSeparacaoService,
} = require('../../services/requisicoes/estadosSeparacao');

function createEstadosSeparacaoRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    denyBackofficeOperations,
    requisicaoArmazemOrigemAcessoPermitido,
    separadorImpedeAcao,
    respostaBloqueioSeparador,
    hasRecebimentoMarker,
    getRequisicaoComItens,
  } = deps;

  const router = express.Router();

  router.patch('/:id/completar-separacao', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
    try {
      const { id } = req.params;
      const check = await pool.query(
        `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
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
      await completarSeparacaoService(pool, {
        requisicaoId: id,
        hasRecebimentoMarker,
      });
      const fullReq = await getRequisicaoComItens(id);
      if (!fullReq) {
        return res.status(500).json({ error: 'Erro ao recarregar requisição após completar separação.' });
      }
      return res.json(fullReq);
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      if (error.code === '23514') {
        return res.status(400).json({
          error:
            'Status inválido no servidor. Execute: npm run db:migrate:em-separacao (e migrações de fases de requisição se ainda não aplicou).',
        });
      }
      console.error('Erro ao completar separação:', error);
      return res.status(500).json({ error: 'Erro ao completar separação', details: error.message });
    }
  });

  router.patch('/:id/confirmar-separacao', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
    try {
      const { id } = req.params;
      const check = await pool.query(
        `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
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
        return res.status(400).json({
          error:
            'Só é possível confirmar separação quando a requisição está separada (todos os itens preparados).',
        });
      }
      const row = await confirmarSeparacaoService(pool, id);
      return res.json(row);
    } catch (error) {
      if (error.code === '42703') {
        return res.status(503).json({
          error: 'Colunas de confirmação de separação não existem no banco.',
          details: 'Execute a migração: server/Migrate/migrate-requisicoes-separacao-confirmada.sql',
        });
      }
      console.error('Erro ao confirmar separação:', error);
      return res.status(500).json({ error: 'Erro ao confirmar separação', details: error.message });
    }
  });

  return router;
}

module.exports = { createEstadosSeparacaoRouter };
