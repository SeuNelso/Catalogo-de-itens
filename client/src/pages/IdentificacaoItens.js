import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Toast from '../components/Toast';
import PesquisaComLeitorQr from '../components/PesquisaComLeitorQr';
import QrScannerModal from '../components/QrScannerModal';
import { FORMATOS_QR_BARCODE, Html5QrcodeSupportedFormats } from '../utils/qrBarcodeFormats';
import {
  gerarPdfIdentificacao,
  MAX_QTD_DIGITOS,
  MODOS_PDF
} from '../utils/identificacaoItemPdf';

const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** Texto na caixa de pesquisa após seleção: «código — descrição». */
function formatArtigoExibicao(codigo, descricao) {
  const cod = String(codigo || '').trim();
  const desc = String(descricao || '').trim();
  if (!cod) return '';
  if (!desc || desc === cod) return cod;
  return `${cod} — ${desc}`;
}

/** Termo enviado à API (só o que o utilizador está a digitar). */
function termoPesquisaArtigo(busca) {
  const s = String(busca || '').trim();
  const sep = s.indexOf(' — ');
  if (sep > 0) return s.slice(0, sep).trim();
  return s;
}

function artigoJaSelecionado(busca, codigo, descricao) {
  return Boolean(codigo) && busca === formatArtigoExibicao(codigo, descricao);
}

const novaLinhaArtigo = () => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  busca: '',
  codigo: '',
  descricao: '',
  localizacao: '',
  quantidade: ''
});

const IdentificacaoItens = () => {
  const [modo, setModo] = useState(MODOS_PDF.FOLHA_INTEIRA);

  const [linhas, setLinhas] = useState([novaLinhaArtigo()]);
  const [linhaSugAtiva, setLinhaSugAtiva] = useState(null);
  const [sugestoesLinha, setSugestoesLinha] = useState([]);
  const [locOpenIdx, setLocOpenIdx] = useState(null);

  const [loadingSug, setLoadingSug] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [toast, setToast] = useState(null);

  const [localizacoesOpts, setLocalizacoesOpts] = useState([]);

  const [scannerItemOpen, setScannerItemOpen] = useState(false);
  const [scannerLocOpen, setScannerLocOpen] = useState(false);
  const [scannerLinhaIdx, setScannerLinhaIdx] = useState(null);
  const [scannerLocLinhaIdx, setScannerLocLinhaIdx] = useState(null);

  const isTres = modo === MODOS_PDF.TRES_POR_FOLHA;

  useEffect(() => {
    const loadLocs = async () => {
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/armazens?ativo=true&consulta_estoque_localizacao=1', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const armazens = Array.isArray(data) ? data : [];
        const centrais = armazens.filter((a) => String(a?.tipo || '').trim().toLowerCase() === 'central');
        const alvo = centrais[0];
        const locs = (alvo?.localizacoes || [])
          .map((l) => String(l?.localizacao || '').trim())
          .filter(Boolean);
        setLocalizacoesOpts([...new Set(locs)].sort((a, b) => a.localeCompare(b, 'pt')));
      } catch {
        setLocalizacoesOpts([]);
      }
    };
    loadLocs();
  }, []);

  useEffect(() => {
    if (linhaSugAtiva == null) return undefined;
    const linha = linhas[linhaSugAtiva];
    if (artigoJaSelecionado(linha?.busca, linha?.codigo, linha?.descricao)) {
      setSugestoesLinha([]);
      return undefined;
    }
    const term = termoPesquisaArtigo(linha?.busca);
    if (term.length < 2) {
      setSugestoesLinha([]);
      return undefined;
    }
    const t = setTimeout(async () => {
      setLoadingSug(true);
      try {
        const params = new URLSearchParams({ search: term, limit: '12', page: '1' });
        const res = await fetch(`/api/itens?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Erro na pesquisa');
        setSugestoesLinha(Array.isArray(data.itens) ? data.itens : []);
      } catch {
        setSugestoesLinha([]);
      } finally {
        setLoadingSug(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [linhaSugAtiva, linhas]);

  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest('[data-ident-sug]') && !e.target.closest('[data-ident-loc]')) {
        setLinhaSugAtiva(null);
        setLocOpenIdx(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const localizacoesFiltradasLinha = useMemo(() => {
    if (locOpenIdx == null) return [];
    const termo = linhas[locOpenIdx]?.localizacao || '';
    const q = normalize(termo);
    if (!q) return localizacoesOpts.slice(0, 30);
    return localizacoesOpts.filter((l) => normalize(l).includes(q)).slice(0, 30);
  }, [localizacoesOpts, locOpenIdx, linhas]);

  const selecionarItemLinha = (idx, item) => {
    const cod = String(item.codigo || '').trim();
    const desc = String(item.descricao || item.nome || '').trim();
    setLinhas((prev) =>
      prev.map((l, i) =>
        i === idx
          ? { ...l, codigo: cod, descricao: desc, busca: formatArtigoExibicao(cod, desc) }
          : l
      )
    );
    setLinhaSugAtiva(null);
    setSugestoesLinha([]);
  };

  const limparLinha = (idx) => {
    setLinhas((prev) => prev.map((l, i) => (i === idx ? { ...novaLinhaArtigo(), id: l.id } : l)));
  };

  const removerLinha = (idx) => {
    setLinhas((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== idx);
    });
    setLinhaSugAtiva(null);
    setLocOpenIdx(null);
  };

  const adicionarLinha = () => {
    setLinhas((prev) => [...prev, novaLinhaArtigo()]);
  };

  const mudarModo = (novoModo) => {
    setModo(novoModo);
    setLinhaSugAtiva(null);
    setLocOpenIdx(null);
  };

  const aplicarCodigoLido = useCallback(async (valor, linhaIdx) => {
    const v = String(valor || '').trim();
    if (!v || linhaIdx == null) return;

    const preencher = (cod, desc) => {
      const exib = formatArtigoExibicao(cod, desc) || cod || v;
      setLinhas((prev) =>
        prev.map((l, i) =>
          i === linhaIdx ? { ...l, busca: exib, codigo: cod, descricao: desc } : l
        )
      );
    };

    preencher(v, '');
    try {
      const params = new URLSearchParams({ search: v, limit: '5', page: '1' });
      const res = await fetch(`/api/itens?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      const itens = Array.isArray(data.itens) ? data.itens : [];
      const exact = itens.find((i) => String(i.codigo || '').trim() === v);
      const pick = exact || itens[0];
      if (pick) {
        preencher(
          String(pick.codigo || v).trim(),
          String(pick.descricao || pick.nome || '').trim()
        );
      }
    } catch {
      /* mantém valor lido */
    }
  }, []);

  const aplicarLocalizacaoLida = (valor, linhaIdx) => {
    const v = String(valor || '').trim();
    if (!v || linhaIdx == null) return;
    setLinhas((prev) =>
      prev.map((l, i) => (i === linhaIdx ? { ...l, localizacao: v } : l))
    );
    setLocOpenIdx(null);
  };

  const linhasPreenchidas = useMemo(
    () =>
      linhas
        .map((l) => ({
          codigo: String(l.codigo || '').trim(),
          descricao: String(l.descricao || '').trim(),
          localizacao: String(l.localizacao || '').trim(),
          quantidade: String(l.quantidade || '').trim()
        }))
        .filter((l) => l.codigo),
    [linhas]
  );

  const podeGerar = useMemo(() => {
    if (gerando) return false;
    return (
      linhasPreenchidas.length >= 1 &&
      linhasPreenchidas.every((l) => l.localizacao)
    );
  }, [gerando, linhasPreenchidas]);

  const handleGerarPdf = async () => {
    if (!isTres) {
      for (let i = 0; i < linhasPreenchidas.length; i += 1) {
        const qtdRaw = linhasPreenchidas[i].quantidade;
        if (qtdRaw && !/^\d{1,6}$/.test(qtdRaw.replace(/\s/g, ''))) {
          setToast({
            type: 'error',
            message: `Quantidade inválida no artigo ${i + 1}. Use até ${MAX_QTD_DIGITOS} dígitos.`
          });
          return;
        }
      }
    }

    try {
      setGerando(true);
      const itens = linhasPreenchidas.map((l) => ({
        codigo: l.codigo,
        descricao: l.descricao,
        localizacao: l.localizacao,
        quantidade: isTres ? undefined : l.quantidade || undefined
      }));

      await gerarPdfIdentificacao({
        modo,
        localizacao: '',
        itens
      });
      setToast({ type: 'success', message: 'PDF gerado com sucesso.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao gerar PDF.' });
    } finally {
      setGerando(false);
    }
  };

  const listaSugestoes = (itens, onPick) => (
    <ul className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
      {itens.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0"
            onClick={() => onPick(item)}
          >
            <span className="font-mono font-semibold text-gray-900">{item.codigo}</span>
            <span className="text-gray-600 ml-2 truncate">{item.descricao || item.nome}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Identificação de itens</h1>
        <p className="text-gray-600 mt-1 mb-6">
          PDF em A4 (horizontal ou vertical conforme o formato). QR = localização; código de barras = código do artigo.
        </p>

        <section className="bg-white rounded-2xl shadow-lg border border-gray-200 p-4 sm:p-6 space-y-5">
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 mb-3">Formato da folha</legend>
            <div className="flex flex-col sm:flex-row gap-2">
              <label className="flex-1 flex items-start gap-2 p-3 border rounded-lg cursor-pointer has-[:checked]:border-[#0915FF] has-[:checked]:bg-blue-50/50">
                <input
                  type="radio"
                  name="modo-pdf"
                  className="mt-1"
                  checked={modo === MODOS_PDF.FOLHA_INTEIRA}
                  onChange={() => mudarModo(MODOS_PDF.FOLHA_INTEIRA)}
                />
                <span className="text-sm font-semibold text-gray-800">Folha inteira</span>
              </label>
              <label className="flex-1 flex items-start gap-2 p-3 border rounded-lg cursor-pointer has-[:checked]:border-[#0915FF] has-[:checked]:bg-blue-50/50">
                <input
                  type="radio"
                  name="modo-pdf"
                  className="mt-1"
                  checked={modo === MODOS_PDF.TRES_POR_FOLHA}
                  onChange={() => mudarModo(MODOS_PDF.TRES_POR_FOLHA)}
                />
                <span className="text-sm font-semibold text-gray-800">Multiplos por folha</span>
              </label>
            </div>
          </fieldset>

          <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {isTres
                  ? 'Adicione quantos artigos precisar (3 por página A4; novas páginas são criadas automaticamente). Cada etiqueta usa a localização do respetivo artigo no QR.'
                  : 'Adicione quantos artigos precisar (1 etiqueta por página A4 horizontal). Todos entram num único PDF com várias folhas.'}
              </p>
              {linhas.map((linha, idx) => (
                <div
                  key={linha.id}
                  className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-gray-800">Artigo {idx + 1}</span>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => limparLinha(idx)}
                        className="text-xs text-gray-500 hover:text-red-600"
                      >
                        Limpar
                      </button>
                      {linhas.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removerLinha(idx)}
                          className="text-xs text-gray-500 hover:text-red-600"
                        >
                          Remover
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="relative" data-ident-sug>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Artigo (código ou descrição)
                    </label>
                    <PesquisaComLeitorQr
                      value={linha.busca}
                      onChange={(e) => {
                        const v = e.target.value;
                        setLinhas((prev) =>
                          prev.map((l, i) => {
                            if (i !== idx) return l;
                            const limparSel = !artigoJaSelecionado(v, l.codigo, l.descricao);
                            return {
                              ...l,
                              busca: v,
                              codigo: limparSel ? '' : l.codigo,
                              descricao: limparSel ? '' : l.descricao
                            };
                          })
                        );
                        setLinhaSugAtiva(idx);
                      }}
                      onFocus={() => setLinhaSugAtiva(idx)}
                      onLerClick={() => {
                        setScannerLinhaIdx(idx);
                        setScannerItemOpen(true);
                      }}
                      placeholder="Pesquisar por código ou descrição…"
                    />
                    {linhaSugAtiva === idx &&
                      sugestoesLinha.length > 0 &&
                      listaSugestoes(sugestoesLinha, (item) => selecionarItemLinha(idx, item))}
                    {linhaSugAtiva === idx && loadingSug && (
                      <p className="text-xs text-gray-500 mt-1">A pesquisar…</p>
                    )}
                  </div>
                  {!isTres && (
                    <div>
                      <label
                        className="block text-xs font-medium text-gray-600 mb-1"
                        htmlFor={`quantidade-ident-${linha.id}`}
                      >
                        Quantidade
                      </label>
                      <input
                        id={`quantidade-ident-${linha.id}`}
                        type="text"
                        inputMode="numeric"
                        maxLength={MAX_QTD_DIGITOS}
                        value={linha.quantidade}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, '').slice(0, MAX_QTD_DIGITOS);
                          setLinhas((prev) =>
                            prev.map((l, i) => (i === idx ? { ...l, quantidade: v } : l))
                          );
                        }}
                        placeholder={`Opcional — máx. ${MAX_QTD_DIGITOS} dígitos`}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0915FF]/30 focus:border-[#0915FF]"
                      />
                    </div>
                  )}
                  <div className="relative" data-ident-loc>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Localização (QR)
                    </label>
                    <PesquisaComLeitorQr
                      value={linha.localizacao}
                      onChange={(e) => {
                        const v = e.target.value;
                        setLinhas((prev) =>
                          prev.map((l, i) => (i === idx ? { ...l, localizacao: v } : l))
                        );
                        setLocOpenIdx(idx);
                      }}
                      onFocus={() => setLocOpenIdx(idx)}
                      onLerClick={() => {
                        setScannerLocLinhaIdx(idx);
                        setScannerLocOpen(true);
                      }}
                      placeholder="Ex.: GERAL.E.R"
                      fontMono
                      lerTitle="Ler QR da localização"
                    />
                    {locOpenIdx === idx && localizacoesFiltradasLinha.length > 0 && (
                      <ul className="absolute z-20 left-0 right-0 mt-1 max-h-48 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
                        {localizacoesFiltradasLinha.map((loc) => (
                          <li key={loc}>
                            <button
                              type="button"
                              className="w-full text-left px-3 py-2 hover:bg-gray-50 font-mono border-b border-gray-100 last:border-0"
                              onClick={() => {
                                setLinhas((prev) =>
                                  prev.map((l, i) =>
                                    i === idx ? { ...l, localizacao: loc } : l
                                  )
                                );
                                setLocOpenIdx(null);
                              }}
                            >
                              {loc}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={adicionarLinha}
                className="w-full py-2.5 rounded-lg text-sm font-medium border border-dashed border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                + Adicionar artigo
              </button>
          </div>

          <button
            type="button"
            onClick={handleGerarPdf}
            disabled={!podeGerar}
            className="w-full py-3 rounded-lg text-sm font-semibold bg-[#0915FF] text-white hover:bg-[#0712cc] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {gerando
              ? 'A gerar PDF…'
              : isTres
                ? 'Gerar PDF (A4 vertical)'
                : 'Gerar PDF (A4 horizontal)'}
          </button>
        </section>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <QrScannerModal
        open={scannerItemOpen}
        onClose={() => {
          setScannerItemOpen(false);
          setScannerLinhaIdx(null);
        }}
        onScan={(text) => {
          setScannerItemOpen(false);
          const idx = scannerLinhaIdx;
          setScannerLinhaIdx(null);
          aplicarCodigoLido(text, idx);
        }}
        title="Ler código do artigo"
        readerId="qr-reader-ident-item"
        formatsToSupport={FORMATOS_QR_BARCODE}
      />
      <QrScannerModal
        open={scannerLocOpen}
        onClose={() => {
          setScannerLocOpen(false);
          setScannerLocLinhaIdx(null);
        }}
        onScan={(text) => {
          setScannerLocOpen(false);
          const idx = scannerLocLinhaIdx;
          setScannerLocLinhaIdx(null);
          aplicarLocalizacaoLida(text, idx);
        }}
        title="Ler QR da localização"
        readerId="qr-reader-ident-loc"
        formatsToSupport={[Html5QrcodeSupportedFormats.QR_CODE]}
      />
    </div>
  );
};

export default IdentificacaoItens;
