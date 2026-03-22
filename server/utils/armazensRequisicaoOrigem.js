/**
 * Tipos de armazém que podem ser usados como origem em requisições e atribuídos ao utilizador.
 * Alinhado a client/src/utils/armazensRequisicaoOrigem.js
 */
const TIPOS_ARMAZEM_ORIGEM_REQUISICAO = Object.freeze(['central', 'viatura', 'apeado', 'epi']);

function isTipoArmazemOrigemRequisicao(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  return TIPOS_ARMAZEM_ORIGEM_REQUISICAO.includes(t);
}

/** Parâmetro para SQL: LOWER(TRIM(COALESCE(tipo,''))) = ANY($n::text[]) */
function tiposArmazemOrigemRequisicaoSqlArray() {
  return [...TIPOS_ARMAZEM_ORIGEM_REQUISICAO];
}

module.exports = {
  TIPOS_ARMAZEM_ORIGEM_REQUISICAO,
  isTipoArmazemOrigemRequisicao,
  tiposArmazemOrigemRequisicaoSqlArray,
};
