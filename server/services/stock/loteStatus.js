/** Status derivado de quantidades em stock_lote (reserva parcial conta como reservado). */
const STOCK_STATUS = Object.freeze({
  DISPONIVEL: 'disponivel',
  RESERVADO: 'reservado',
  CONSUMIDO: 'consumido',
});

const SQL_STOCK_LOTE_STATUS =
  `(CASE WHEN l.quantidade_reservada > 0 THEN 'reservado' WHEN l.quantidade_disponivel > 0 THEN 'disponivel' ELSE 'consumido' END)`;

function statusStockLoteFromQuantidades(qDisp, qRes) {
  const disp = Number(qDisp) || 0;
  const res = Number(qRes) || 0;
  if (res > 0) return STOCK_STATUS.RESERVADO;
  if (disp > 0) return STOCK_STATUS.DISPONIVEL;
  return STOCK_STATUS.CONSUMIDO;
}

module.exports = {
  STOCK_STATUS,
  SQL_STOCK_LOTE_STATUS,
  statusStockLoteFromQuantidades,
};
