/**
 * Fluxo novo de devolução:
 * - DEV continua obrigatório.
 * - Não depende mais de documentos "pendentes" legados (TRA APEADOS/TRFL PENDENTE).
 * - A conclusão logística acontece via tickets de transferência de localização.
 */

export function podeFinalizarDevolucaoTransferenciasPendentes(requisicao) {
  const temMarcacaoDev = Boolean(requisicao?.devolucao_tra_gerada_em);
  const temNumeroDev = Boolean(String(requisicao?.tra_numero || '').trim());
  if (!temMarcacaoDev && !temNumeroDev) return false;
  if (!temNumeroDev) return false;
  const status = String(requisicao?.status || '').trim().toUpperCase();
  return ['EM EXPEDICAO', 'APEADOS', 'ENTREGUE'].includes(status);
}

/** Texto curto para title/tooltip quando o botão Finalizar está desativado. */
export function mensagemDocumentosEmFaltaFinalizarDevolucao(requisicao) {
  const temMarcacaoDev = Boolean(requisicao?.devolucao_tra_gerada_em);
  const temNumeroDev = Boolean(String(requisicao?.tra_numero || '').trim());
  if (!temMarcacaoDev && !temNumeroDev) return 'Gere primeiro o DEV.';
  if (!String(requisicao?.tra_numero || '').trim()) {
    return 'Guarde o número do DEV antes de finalizar.';
  }
  const status = String(requisicao?.status || '').trim().toUpperCase();
  if (!['EM EXPEDICAO', 'APEADOS', 'ENTREGUE'].includes(status)) {
    return 'A devolução precisa estar em Em processo, APEADOS ou Entregue para finalizar.';
  }
  return '';
}
