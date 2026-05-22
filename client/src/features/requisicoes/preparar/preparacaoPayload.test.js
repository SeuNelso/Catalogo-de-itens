import {
  formatArtigoExibicao,
  metrosTotalFromBobinas,
  quantidadePreparadaPayload,
  isTipoControloSerial,
} from './preparacaoPayload';

describe('preparacaoPayload', () => {
  it('formatArtigoExibicao junta código e descrição', () => {
    expect(formatArtigoExibicao('ABC', 'Parafuso')).toBe('ABC — Parafuso');
  });

  it('metrosTotalFromBobinas soma metros', () => {
    expect(metrosTotalFromBobinas([{ metros: 10 }, { metros: 5 }])).toBe(15);
  });

  it('quantidadePreparadaPayload para LOTE usa bobinas', () => {
    expect(
      quantidadePreparadaPayload({
        tipoControlo: 'LOTE',
        quantidadePreparada: 1,
        bobinasPayload: [{ metros: 25 }],
        isTipoControloSerial,
      })
    ).toBe(25);
  });

  it('isTipoControloSerial reconhece S/N e variantes', () => {
    expect(isTipoControloSerial('S/N')).toBe(true);
    expect(isTipoControloSerial('sn')).toBe(true);
    expect(isTipoControloSerial('LOTE')).toBe(false);
  });

  it('quantidadePreparadaPayload para S/N sem bobinas usa quantidade digitada (ex.: 0)', () => {
    expect(
      quantidadePreparadaPayload({
        tipoControlo: 'S/N',
        quantidadePreparada: 0,
        bobinasPayload: undefined,
        isTipoControloSerial,
      })
    ).toBe(0);
  });
});
