/**
 * Finalização no fluxo devolução (transferências pendentes / APEADOS).
 * Alinhado a PATCH /api/requisicoes/:id/finalizar.
 *
 * - Sem quantidade APEADOS: DEV + TRFL interna (devolucao_trfl_gerada_em) ou TRFL PENDENTE
 *   (devolucao_trfl_pendente_gerada_em) — na prática quem só usa a secção amarela gera só a pendente.
 * - Tudo para APEADOS (sem remanescente no central): DEV + TRA APEADOS.
 * - Misto: DEV + TRA APEADOS + TRFL PENDENTE.
 */

function flagsApeadosPendente(itens) {
  let temApeados = false;
  let temPendenteArmazenagem = false;
  for (const it of itens || []) {
    const total = Number(it?.quantidade_preparada ?? it?.quantidade ?? 0) || 0;
    const ape = Number(it?.quantidade_apeados ?? 0) || 0;
    if (ape > 0) temApeados = true;
    if (Math.max(0, total - ape) > 0) temPendenteArmazenagem = true;
  }
  return { temApeados, temPendenteArmazenagem };
}

export function podeFinalizarDevolucaoTransferenciasPendentes(requisicao) {
  if (!requisicao?.devolucao_tra_gerada_em) return false;
  const { temApeados, temPendenteArmazenagem } = flagsApeadosPendente(requisicao.itens);
  if (!temApeados) {
    return Boolean(
      requisicao.devolucao_trfl_gerada_em || requisicao.devolucao_trfl_pendente_gerada_em
    );
  }
  if (!temPendenteArmazenagem) {
    return Boolean(requisicao.devolucao_tra_apeados_gerada_em);
  }
  return (
    Boolean(requisicao.devolucao_tra_apeados_gerada_em) &&
    Boolean(requisicao.devolucao_trfl_pendente_gerada_em)
  );
}

/** Texto curto para title/tooltip quando o botão Finalizar está desativado. */
export function mensagemDocumentosEmFaltaFinalizarDevolucao(requisicao) {
  if (!requisicao?.devolucao_tra_gerada_em) return 'Gere primeiro o DEV.';
  const { temApeados, temPendenteArmazenagem } = flagsApeadosPendente(requisicao.itens);
  if (!temApeados) {
    return requisicao.devolucao_trfl_gerada_em || requisicao.devolucao_trfl_pendente_gerada_em
      ? ''
      : 'Sem APEADOS: gere a TRFL interna ou a TRFL PENDENTE antes de finalizar.';
  }
  if (!temPendenteArmazenagem) {
    return requisicao.devolucao_tra_apeados_gerada_em
      ? ''
      : 'Só APEADOS: gere TRA APEADOS antes de finalizar.';
  }
  if (!requisicao.devolucao_tra_apeados_gerada_em || !requisicao.devolucao_trfl_pendente_gerada_em) {
    return 'Gere TRA APEADOS e TRFL PENDENTE antes de finalizar.';
  }
  return '';
}
