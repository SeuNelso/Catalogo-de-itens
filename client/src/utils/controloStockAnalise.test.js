import { analisarControloStock, stockEstaConciliado } from './controloStockAnalise';
import { podeUsarAnaliseControloStock } from './controloStock';

const stockRows = (items) => [
  ['Artigo', 'Descrição', 'Armazém', 'Stock'],
  ...items,
];

const movementRows = (items) => [
  ['Artigo', 'Tipo Movimento', 'Qtd. Mov.', 'Documento'],
  ...items,
];

describe('analisarControloStock', () => {
  test('soma stock por artigo e anula transferências entre localizações', () => {
    const result = analisarControloStock({
      stockAnteriorRows: stockRows([
        ['100', 'Artigo A', 'A', 10],
        ['100', 'Artigo A', 'B', 5],
      ]),
      movimentosRows: movementRows([
        ['100', 'Saldo Inicial', '', ''],
        ['100', 'Saída', 3, 'Transferência'],
        ['100', 'Entrada', 3, 'Transferência'],
        ['100', 'Entrada', 2, 'Receção'],
      ]),
      stockAtualRows: stockRows([
        ['100', 'Artigo A', 'A', 17],
        ['100', 'Artigo A', 'B', 3],
      ]),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      artigo: '100',
      stockAnterior: 15,
      quantidadeMovimentada: 2,
      stockEsperado: 17,
      stockAtual: 20,
      diferenca: 3,
    });
    expect(result[0].movimentos).toHaveLength(4);
    expect(stockEstaConciliado(result[0])).toBe(false);
  });

  test('considera conciliado um artigo sem divergência', () => {
    const [item] = analisarControloStock({
      stockAnteriorRows: stockRows([['200', 'Artigo B', 'A', 8]]),
      movimentosRows: movementRows([['200', 'Saída', 2, 'Requisição']]),
      stockAtualRows: stockRows([['200', 'Artigo B', 'A', 6]]),
    });

    expect(stockEstaConciliado(item)).toBe(true);
  });

  test('rejeita tipos de movimento que não consegue calcular', () => {
    expect(() => analisarControloStock({
      stockAnteriorRows: stockRows([['300', 'Artigo C', 'A', 1]]),
      movimentosRows: movementRows([['300', 'Ajuste', 1, 'Documento']]),
      stockAtualRows: stockRows([['300', 'Artigo C', 'A', 2]]),
    })).toThrow(/não suportado/);
  });
});

describe('podeUsarAnaliseControloStock', () => {
  test('permite admin/controller e utilizadores com permissão de controlo de stock', () => {
    expect(podeUsarAnaliseControloStock({ role: 'admin' })).toBe(true);
    expect(podeUsarAnaliseControloStock({ role: 'controller' })).toBe(true);
    expect(podeUsarAnaliseControloStock({ role: 'operador', pode_controlo_stock: true })).toBe(true);
  });

  test('não permite utilizadores sem permissão ou perfil autorizado', () => {
    expect(podeUsarAnaliseControloStock({ role: 'operador', pode_controlo_stock: false })).toBe(false);
    expect(podeUsarAnaliseControloStock(null)).toBe(false);
  });
});
