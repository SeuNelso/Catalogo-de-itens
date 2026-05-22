const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STOCK_STATUS,
  statusStockLoteFromQuantidades,
} = require('../../services/stock/loteStatus');

describe('statusStockLoteFromQuantidades', () => {
  it('reserva parcial → reservado', () => {
    assert.equal(statusStockLoteFromQuantidades(90, 10), STOCK_STATUS.RESERVADO);
  });

  it('só disponível → disponivel', () => {
    assert.equal(statusStockLoteFromQuantidades(50, 0), STOCK_STATUS.DISPONIVEL);
  });

  it('só reservado → reservado', () => {
    assert.equal(statusStockLoteFromQuantidades(0, 25), STOCK_STATUS.RESERVADO);
  });

  it('consumido → consumido', () => {
    assert.equal(statusStockLoteFromQuantidades(0, 0), STOCK_STATUS.CONSUMIDO);
  });
});
