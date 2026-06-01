/**
 * Extrai códigos de artigo de texto colado ou CSV/TSV (primeira coluna por linha).
 * Remove duplicados (comparação case-insensitive), preserva a capitalização da 1.ª ocorrência.
 */
export function parseCodigosImportados(text) {
  const seen = new Set();
  const codes = [];
  const raw = String(text || '');
  for (const line of raw.split(/\r?\n/)) {
    let part = String(line || '').trim();
    if (!part) continue;
    if (part.includes('\t')) part = part.split('\t')[0].trim();
    else if (part.includes(';')) part = part.split(';')[0].trim();
    else if (part.includes(',')) part = part.split(',')[0].trim();
    const cod = part.replace(/^["']|["']$/g, '').trim();
    if (!cod) continue;
    const key = cod.toLocaleUpperCase('pt-PT');
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push(cod);
  }
  return codes;
}

export const MAX_CODIGOS_IMPORT_IDENT = 500;
