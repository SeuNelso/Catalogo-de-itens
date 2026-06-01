function isTipoControloSerialLocal(tipoControlo) {
  const raw = String(tipoControlo || '').trim().toUpperCase();
  if (!raw) return false;
  const norm = raw.replace(/\s+/g, '');
  return norm === 'S/N' || norm === 'SN' || norm === 'SERIAL';
}

function quantidadeNecessariaStockPreparacao({
  isZero,
  tipoControlo,
  quantidade_preparada,
  bobinas,
  serialsNormalizados,
}) {
  if (isZero) return 0;
  const t = (tipoControlo || '').toUpperCase();
  if (t === 'LOTE' && Array.isArray(bobinas) && bobinas.length > 0) {
    return bobinas.reduce((sum, b) => sum + (Number(b.metros) || 0), 0);
  }
  if (isTipoControloSerialLocal(tipoControlo) && Array.isArray(serialsNormalizados) && serialsNormalizados.length > 0) {
    return serialsNormalizados.length;
  }
  return Number(quantidade_preparada) || 0;
}

/** Quantidade efectiva na preparação (0 explícito não cai na quantidade requisitada). */
function quantidadePreparadaEfetiva(requisicaoItem) {
  const ri = requisicaoItem;
  if (!ri) return 0;
  if (ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined) {
    const n = Number(ri.quantidade_preparada);
    return Number.isFinite(n) ? n : 0;
  }
  return Number(ri.quantidade) || 0;
}

/** Artigo preparado com quantidade > 0 — entra em TRFL/TRA e movimentos de stock associados. */
function itemTemSaidaTrflTra(requisicaoItem) {
  return quantidadePreparadaEfetiva(requisicaoItem) > 0;
}

/**
 * Quantidade para o monitor da zona de receção (pendente de armazenar).
 * Alinha com reporte/stock: LOTE em metros (bobinas); S/N em unidades; resto preparação efectiva.
 */
/** Máximo entre coluna `quantidade_apeados` e marcações em bobinas/seriais (devoluções antigas). */
function quantidadeApeadosMonitorItem(requisicaoItem, requisicaoItemId, apeadosChildByReqItemId) {
  const fromCol = Math.max(0, Number(requisicaoItem?.quantidade_apeados ?? 0) || 0);
  const riId = Number(requisicaoItemId || requisicaoItem?.requisicao_item_id || 0);
  const fromChild = Number.isFinite(riId)
    ? Math.max(0, Number(apeadosChildByReqItemId?.get(riId) ?? 0) || 0)
    : 0;
  return Math.max(fromCol, fromChild);
}

function quantidadeMonitorRececaoItem(requisicaoItem, rastAgg, seriaisInline = 0) {
  const t = String(requisicaoItem?.tipocontrolo || '').trim().toUpperCase();
  if (t === 'LOTE') {
    const metrosBobinas = Number(rastAgg?.metros || 0) || 0;
    if (metrosBobinas > 0) return metrosBobinas;
  }
  if (isTipoControloSerialLocal(t)) {
    const nSer = Number(rastAgg?.seriais || 0) || 0;
    if (nSer > 0) return nSer;
    const inline = Number(seriaisInline) || 0;
    if (inline > 0) return inline;
  }
  return quantidadePreparadaEfetiva(requisicaoItem);
}

module.exports = {
  quantidadeNecessariaStockPreparacao,
  isTipoControloSerialLocal,
  quantidadePreparadaEfetiva,
  itemTemSaidaTrflTra,
  quantidadeMonitorRececaoItem,
  quantidadeApeadosMonitorItem,
};
