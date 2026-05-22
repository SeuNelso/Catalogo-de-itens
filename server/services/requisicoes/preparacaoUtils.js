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

module.exports = {
  quantidadeNecessariaStockPreparacao,
  isTipoControloSerialLocal,
  quantidadePreparadaEfetiva,
  itemTemSaidaTrflTra,
};
