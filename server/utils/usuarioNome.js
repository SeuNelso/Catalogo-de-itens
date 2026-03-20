/** Nome público: nome + sobrenome (compatível sem coluna sobrenome). */
function nomeCompletoUsuario(row) {
  if (!row) return '';
  const n = row.nome != null ? String(row.nome).trim() : '';
  const s = row.sobrenome != null ? String(row.sobrenome).trim() : '';
  const full = [n, s].filter(Boolean).join(' ').trim();
  return full || n || '';
}

module.exports = { nomeCompletoUsuario };
