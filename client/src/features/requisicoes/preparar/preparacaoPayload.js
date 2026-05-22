export function isTipoControloSerial(tipoControlo) {
  const raw = String(tipoControlo || '').trim().toUpperCase();
  if (!raw) return false;
  const norm = raw.replace(/\s+/g, '');
  return norm === 'S/N' || norm === 'SN' || norm === 'SERIAL';
}

export function formatArtigoExibicao(codigo, descricao) {
  const c = String(codigo || '').trim();
  const d = String(descricao || '').trim();
  if (c && d) return `${c} — ${d}`;
  return c || d || '';
}

export function metrosTotalFromBobinas(bobinas) {
  if (!Array.isArray(bobinas) || bobinas.length === 0) return 0;
  return bobinas.reduce((sum, b) => sum + (Number(b?.metros) || 0), 0);
}

export function quantidadePreparadaPayload({ tipoControlo, quantidadePreparada, bobinasPayload, isTipoControloSerial }) {
  const t = String(tipoControlo || '').toUpperCase();
  if (t === 'LOTE' && Array.isArray(bobinasPayload)) {
    return metrosTotalFromBobinas(bobinasPayload);
  }
  if (isTipoControloSerial(tipoControlo) && Array.isArray(bobinasPayload)) {
    return bobinasPayload.length;
  }
  return Number(quantidadePreparada) || 0;
}
