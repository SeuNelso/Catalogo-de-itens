const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDateRange,
  DEFAULT_RANGE_DAYS,
} = require('../../services/requisicoes/dashboardViaturas');

test('resolveDateRange aplica últimos N dias quando datas vazias', () => {
  const { dataInicio, dataFim } = resolveDateRange('', '');
  assert.match(dataInicio, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(dataFim, /^\d{4}-\d{2}-\d{2}$/);
  const ini = new Date(`${dataInicio}T12:00:00`);
  const fim = new Date(`${dataFim}T12:00:00`);
  const diffDays = Math.round((fim - ini) / (24 * 60 * 60 * 1000));
  assert.ok(diffDays >= DEFAULT_RANGE_DAYS - 2 && diffDays <= DEFAULT_RANGE_DAYS + 2);
});

test('resolveDateRange respeita datas explícitas', () => {
  const { dataInicio, dataFim } = resolveDateRange('2024-01-01', '2024-06-30');
  assert.equal(dataInicio, '2024-01-01');
  assert.equal(dataFim, '2024-06-30');
});
