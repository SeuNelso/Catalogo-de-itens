/** Ids de armazéns de origem (central, viatura, APEADO, EPI) com acesso a requisições (escopo). Compatível com token antigo (só *_id). */
export function getRequisicoesArmazemOrigemIds(user) {
  if (!user) return [];
  let ids = user.requisicoes_armazem_origem_ids;
  if (Array.isArray(ids)) {
    return [...new Set(ids.map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
  }
  if (user.requisicoes_armazem_origem_id != null && user.requisicoes_armazem_origem_id !== '') {
    const n = parseInt(user.requisicoes_armazem_origem_id, 10);
    return Number.isNaN(n) ? [] : [n];
  }
  return [];
}
