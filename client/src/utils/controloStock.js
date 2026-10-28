/** Alinhado à API: sem bypass por role; exige `pode_controlo_stock` no utilizador/JWT. */
export function podeUsarControloStock(user) {
  if (!user) return false;
  return user.pode_controlo_stock === true;
}

/** Admin/controller podem analisar ficheiros de stock, tal como podem importar stock nacional. */
export function podeUsarAnaliseControloStock(user) {
  if (!user) return false;
  return podeUsarControloStock(user) || ['admin', 'controller'].includes(user.role);
}

/** Permissão explícita para aceder à lista de movimentos (sem vínculo fixo à role). */
export function podeUsarConsultaMovimentos(user) {
  if (!user) return false;
  return user.pode_consulta_movimentos === true;
}
