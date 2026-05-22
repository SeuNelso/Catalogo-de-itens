const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  quantidadeNecessariaStockPreparacao,
  quantidadePreparadaEfetiva,
  itemTemSaidaTrflTra,
} = require('../../services/requisicoes/preparacaoUtils');

describe('quantidadeNecessariaStockPreparacao', () => {
  it('LOTE com bobinas soma metros', () => {
    assert.equal(
      quantidadeNecessariaStockPreparacao({
        isZero: false,
        tipoControlo: 'LOTE',
        quantidade_preparada: 1,
        bobinas: [{ metros: 30 }, { metros: 20 }],
        serialsNormalizados: [],
      }),
      50
    );
  });

  it('SN com seriais usa contagem', () => {
    assert.equal(
      quantidadeNecessariaStockPreparacao({
        isZero: false,
        tipoControlo: 'S/N',
        quantidade_preparada: 99,
        bobinas: [],
        serialsNormalizados: ['A', 'B', 'C'],
      }),
      3
    );
  });

  it('zero preparado → 0', () => {
    assert.equal(
      quantidadeNecessariaStockPreparacao({
        isZero: true,
        tipoControlo: 'LOTE',
        quantidade_preparada: 0,
        bobinas: [{ metros: 10 }],
        serialsNormalizados: [],
      }),
      0
    );
  });
});

describe('quantidadePreparadaEfetiva / itemTemSaidaTrflTra', () => {
  it('quantidade_preparada 0 não usa quantidade requisitada', () => {
    assert.equal(quantidadePreparadaEfetiva({ quantidade_preparada: 0, quantidade: 5 }), 0);
    assert.equal(itemTemSaidaTrflTra({ quantidade_preparada: 0, quantidade: 5 }), false);
  });

  it('sem preparação usa quantidade requisitada', () => {
    assert.equal(quantidadePreparadaEfetiva({ quantidade: 3 }), 3);
    assert.equal(itemTemSaidaTrflTra({ quantidade: 3 }), true);
  });
});
