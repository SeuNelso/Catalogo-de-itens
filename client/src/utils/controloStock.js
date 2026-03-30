/** Alinhado à API: admin ignora; restantes precisam de `pode_controlo_stock` no utilizador/JWT. */
export function podeUsarControloStock(user) {
  if (!user) return false;
  return user.pode_controlo_stock === true;
}
