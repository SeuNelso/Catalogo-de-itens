const { quantidadeNecessariaStockPreparacao } = require('./preparacaoUtils');

/**
 * Serviço de preparação (atender-item). A lógica transacional permanece em requisicoes.js
 * até extração completa; utilitários e quantidades já vivem aqui.
 */
module.exports = {
  quantidadeNecessariaStockPreparacao,
};
