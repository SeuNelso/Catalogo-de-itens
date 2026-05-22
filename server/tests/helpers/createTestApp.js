const express = require('express');
const multer = require('multer');
const { loadTestEnv } = require('./loadTestEnv');

loadTestEnv();

const { pool } = require('../../db/pool');
const { createAuthenticateToken } = require('../../middleware/auth');
const {
  createRequisicaoAuth,
  requisicaoScopeMiddleware,
  requisicaoArmazemOrigemAcessoPermitido,
  assertIdsRequisicoesPermitidas,
} = require('../../middleware/requisicoesScope');
const { JWT_SECRET } = require('../../config/secrets');
const { armazemMovimentacaoInternaTableExists } = require('../../utils/usuarioDbColumns');
const { createRequisicoesRouter } = require('../../routes/requisicoes');

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const authenticateToken = createAuthenticateToken(JWT_SECRET);
  const requisicaoAuth = createRequisicaoAuth(authenticateToken);
  const excelUploadRequisicoes = multer({ dest: 'uploads/' });
  app.use(
    '/api/requisicoes',
    createRequisicoesRouter({
      pool,
      requisicaoAuth,
      authenticateToken,
      requisicaoScopeMiddleware,
      requisicaoArmazemOrigemAcessoPermitido,
      assertIdsRequisicoesPermitidas,
      excelUploadRequisicoes,
      armazemMovimentacaoInternaTableExists,
    })
  );
  return app;
}

module.exports = { createTestApp, pool };
