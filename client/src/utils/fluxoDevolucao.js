/** Alinhado com server/middleware/requisicoesScope.js */

export function isFluxoDevolucaoViaturaCentral(origemTipo, destTipo) {
  return (
    String(origemTipo || '').trim().toLowerCase() === 'viatura' &&
    String(destTipo || '').trim().toLowerCase() === 'central'
  );
}

export function isFluxoDevolucaoEpiCentral(origemTipo, destTipo) {
  return (
    String(origemTipo || '').trim().toLowerCase() === 'epi' &&
    String(destTipo || '').trim().toLowerCase() === 'central'
  );
}

export function isFluxoDevolucaoParaCentral(origemTipo, destTipo) {
  return isFluxoDevolucaoViaturaCentral(origemTipo, destTipo) || isFluxoDevolucaoEpiCentral(origemTipo, destTipo);
}

export function getEpiColaboradorFromObs(obsRaw) {
  const obs = String(obsRaw || '');
  if (!obs) return { nome: '', numero: '' };
  const nomeMatch = /(?:^|\|)\s*Colaborador:\s*([^|]+)/i.exec(obs);
  const numeroMatch = /(?:^|\|)\s*Nr\.?\s*Colab\.?:\s*([^|]+)/i.exec(obs);
  return {
    nome: (nomeMatch?.[1] || '').trim(),
    numero: (numeroMatch?.[1] || '').trim()
  };
}
