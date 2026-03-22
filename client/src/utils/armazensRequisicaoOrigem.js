/**
 * Tipos de armazém elegíveis como origem em requisições (atribuição admin + dropdowns).
 * Alinhado a server/utils/armazensRequisicaoOrigem.js
 */
export const TIPOS_ARMAZEM_ORIGEM_REQUISICAO = Object.freeze([
  'central',
  'viatura',
  'apeado',
  'epi',
]);

export function isTipoArmazemOrigemRequisicao(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  return TIPOS_ARMAZEM_ORIGEM_REQUISICAO.includes(t);
}

/** Lista de armazéns (objetos com .tipo) que podem ser origem */
export function filtrarArmazensOrigemRequisicao(lista) {
  return (lista || []).filter((a) => isTipoArmazemOrigemRequisicao(a.tipo));
}

export function isTipoArmazemCentral(tipo) {
  return String(tipo || '').trim().toLowerCase() === 'central';
}

/** Lista armazéns com tipo «central» (ex.: atribuição em Admin utilizadores). */
export function filtrarArmazensCentrais(lista) {
  return (lista || []).filter((a) => isTipoArmazemCentral(a.tipo));
}
