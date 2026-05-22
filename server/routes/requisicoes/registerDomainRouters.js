const { createStockRouter } = require('./stock');
const { createStockRemainingRouter } = require('./stockRemaining');
const { createPreparacaoStockRouter } = require('./preparacaoStock');
const { createEstadosSeparacaoRouter } = require('./estadosSeparacao');
const { createPreparacaoRouter } = require('./preparacao');
const { createEstadosLogisticaRouter } = require('./estadosLogistica');
const { createCrudRouter } = require('./crud');
const { createDocumentosRouter } = require('./documentos');
const { createDashboardViaturasRouter } = require('./dashboardViaturas');

/**
 * Monta sub-routers por domínio em /api/requisicoes.
 * Fases 3+: documentos (TRFL/TRA/CLOG), CRUD listagem, estados logística pós-separação.
 */
function registerDomainRouters(router, deps) {
  router.use('/stock', createStockRouter(deps));
  router.use('/stock', createStockRemainingRouter(deps));
  router.use(createPreparacaoStockRouter(deps));
  router.use(createPreparacaoRouter(deps));
  router.use(createEstadosSeparacaoRouter(deps));
  router.use(createEstadosLogisticaRouter(deps));
  router.use(createDashboardViaturasRouter(deps));
  router.use(createCrudRouter(deps));
  router.use(createDocumentosRouter(deps));
}

module.exports = { registerDomainRouters };
