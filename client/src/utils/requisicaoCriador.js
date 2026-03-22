/** Texto para exibir quem criou a requisição (API já devolve usuario_nome composto). */
export function formatCriadorRequisicao(req) {
  if (!req) return '—';
  const nome = req.usuario_nome != null ? String(req.usuario_nome).trim() : '';
  const n = req.criador_numero_colaborador;
  const nStr = n != null && String(n).trim() !== '' ? String(n).trim() : '';
  if (nome && nome !== '—') {
    return nStr ? `${nome} (nº ${nStr})` : nome;
  }
  const u = req.criador_username != null ? String(req.criador_username).trim() : '';
  if (u) return `@${u}`;
  if (nStr) return `nº ${nStr}`;
  return '—';
}

/** Utilizador que separou/preparou a requisição (API: separador_nome, separador_usuario_id). */
export function formatSeparadorRequisicao(req) {
  if (!req) return 'Não registado';
  const nome = req.separador_nome != null ? String(req.separador_nome).trim() : '';
  if (nome && nome !== '—') return nome;
  if (req.separador_usuario_id != null && String(req.separador_usuario_id).trim() !== '') {
    return `Utilizador #${req.separador_usuario_id}`;
  }
  return 'Não registado';
}

export function isRequisicaoDoUtilizadorAtual(req, user) {
  if (!req || !user || req.usuario_id == null || user.id == null) return false;
  return Number(req.usuario_id) === Number(user.id);
}

/** Edição de cabeçalho/itens (ecrã Editar) só enquanto a requisição está pendente. */
export function requisicaoPermiteEdicaoFormulario(status) {
  return String(status || '') === 'pendente';
}

/**
 * Reserva só enquanto a requisição está em separação ativa (`EM SEPARACAO`).
 * Depois de `separado` ou estados seguintes, `separador_usuario_id` serve só para exibir quem separou.
 * Admin/backoffice armazém/supervisor armazém podem intervir mesmo em `EM SEPARACAO`.
 */
export function preparacaoReservadaOutroUtilizador(req, user) {
  if (!req || !user) return false;
  if (String(req.status || '') !== 'EM SEPARACAO') return false;
  if (req.separador_usuario_id == null || req.separador_usuario_id === '') return false;
  if (['admin', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role)) return false;
  return Number(req.separador_usuario_id) !== Number(user.id);
}
