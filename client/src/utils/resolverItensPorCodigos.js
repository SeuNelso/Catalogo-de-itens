/**
 * Resolve códigos de artigo via GET /api/itens (match exato no código, senão único resultado).
 */
export async function resolverItensPorCodigos(codigos, opts = {}) {
  const { incluirInativos = true, onProgress, signal } = opts;
  const list = Array.isArray(codigos) ? codigos : [];
  const results = [];
  const BATCH = 10;

  for (let i = 0; i < list.length; i += BATCH) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const chunk = list.slice(i, i + BATCH);
    const chunkResults = await Promise.all(
      chunk.map(async (codigo) => {
        const cod = String(codigo || '').trim();
        if (!cod) {
          return { codigo: cod, encontrado: false, item: null };
        }
        try {
          const params = new URLSearchParams({
            search: cod,
            limit: '50',
            page: '1'
          });
          if (incluirInativos) params.set('incluirInativos', 'true');
          const res = await fetch(`/api/itens?${params.toString()}`, { signal });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            return { codigo: cod, encontrado: false, item: null, erro: data.error };
          }
          const itens = Array.isArray(data.itens) ? data.itens : [];
          const codNorm = cod.toLocaleUpperCase('pt-PT');
          const exact = itens.find(
            (it) => String(it.codigo || '').trim().toLocaleUpperCase('pt-PT') === codNorm
          );
          const pick = exact || (itens.length === 1 ? itens[0] : null);
          if (pick) {
            return { codigo: cod, encontrado: true, item: pick };
          }
          return { codigo: cod, encontrado: false, item: null };
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          return { codigo: cod, encontrado: false, item: null, erro: e?.message };
        }
      })
    );
    results.push(...chunkResults);
    onProgress?.(Math.min(list.length, i + chunk.length), list.length);
  }
  return results;
}
