/** Alinhado à API: admin ignora; restantes precisam de `pode_controlo_stock` no utilizador/JWT. */
export function podeUsarControloStock(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.pode_controlo_stock === true;
}

/** Permissão explícita para aceder à lista de movimentos (sem vínculo fixo à role). */
export function podeUsarConsultaMovimentos(user) {
  if (!user) return false;
  return user.pode_consulta_movimentos === true;
}
