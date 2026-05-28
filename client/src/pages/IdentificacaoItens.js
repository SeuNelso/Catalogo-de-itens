import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { FaWarehouse } from 'react-icons/fa';
import Toast from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';
import { isAdmin } from '../utils/roles';
import { getRequisicoesArmazemOrigemIds } from '../utils/requisicoesArmazemOrigem';
import PesquisaComLeitorQr from '../components/PesquisaComLeitorQr';
import QrScannerModal from '../components/QrScannerModal';
import { FORMATOS_QR_BARCODE, Html5QrcodeSupportedFormats } from '../utils/qrBarcodeFormats';
import {
  gerarPdfIdentificacao,
  MAX_QTD_DIGITOS,
  MODOS_PDF,
  TIPO_ETIQUETA
} from '../utils/identificacaoItemPdf';

const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

function isItemControloLote(item) {
  return String(item?.tipocontrolo || '')
    .trim()
    .toUpperCase() === 'LOTE';
}

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

function agruparLotesStock(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const lote = String(row?.lote || '').trim().toUpperCase();
    if (!lote) continue;
    const prev = map.get(lote) || {
      lote,
      quantidade_disponivel: 0,
      quantidade_reservada: 0
    };
    prev.quantidade_disponivel += Number(row?.quantidade_disponivel) || 0;
    prev.quantidade_reservada += Number(row?.quantidade_reservada) || 0;
    map.set(lote, prev);
  }
  return [...map.values()].sort((a, b) => a.lote.localeCompare(b.lote, 'pt'));
}

/** Quantidade em stock do lote para preencher a etiqueta. */
function quantidadeEtiquetaLote(row) {
  const disp = Number(row?.quantidade_disponivel) || 0;
  const res = Number(row?.quantidade_reservada) || 0;
  if (res > 0 && disp <= 0) return Math.trunc(res);
  return Math.trunc(disp) || Math.trunc(res) || 0;
}

function quantidadeParaCampoIdent(n) {
  const v = Math.trunc(Number(n) || 0);
  if (v <= 0) return '';
  const max = 10 ** MAX_QTD_DIGITOS - 1;
  return String(Math.min(v, max));
}

function rotuloQtdLoteSugestao(row) {
  const disp = Number(row?.quantidade_disponivel) || 0;
  const res = Number(row?.quantidade_reservada) || 0;
  if (disp > 0 && res > 0) return `${disp} disp. / ${res} res.`;
  if (res > 0) return `${res} res.`;
  if (disp > 0) return `${disp} disp.`;
  return '';
}

const novaLinhaArtigo = () => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  busca: '',
  codigo: '',
  descricao: '',
  item_id: '',
  localizacao: '',
  lote: '',
  quantidade: ''
});

const IdentificacaoItens = () => {
  const { user } = useAuth();
  const [modo, setModo] = useState(MODOS_PDF.FOLHA_INTEIRA);
  const [etiquetaComLote, setEtiquetaComLote] = useState(false);

  const [linhas, setLinhas] = useState([novaLinhaArtigo()]);
  const [linhaSugAtiva, setLinhaSugAtiva] = useState(null);
  const [sugestoesLinha, setSugestoesLinha] = useState([]);
  const [locOpenIdx, setLocOpenIdx] = useState(null);
  const [loteOpenIdx, setLoteOpenIdx] = useState(null);
  const [lotesStockRows, setLotesStockRows] = useState([]);
  const [loadingLotesSug, setLoadingLotesSug] = useState(false);

  const [loadingSug, setLoadingSug] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [toast, setToast] = useState(null);

  const [armazens, setArmazens] = useState([]);
  const [loadingArmazens, setLoadingArmazens] = useState(true);
  const [armazemId, setArmazemId] = useState('');
  const [localizacoesOpts, setLocalizacoesOpts] = useState([]);

  const [scannerItemOpen, setScannerItemOpen] = useState(false);
  const [scannerLocOpen, setScannerLocOpen] = useState(false);
  const [scannerLinhaIdx, setScannerLinhaIdx] = useState(null);
  const [scannerLocLinhaIdx, setScannerLocLinhaIdx] = useState(null);

  const isTres = modo === MODOS_PDF.TRES_POR_FOLHA;
  const modoLoteAtivo = !isTres && etiquetaComLote;

  useEffect(() => {
    const loadArmazens = async () => {
      try {
        setLoadingArmazens(true);
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/armazens?ativo=true&consulta_estoque_localizacao=1', {
          headers: { Authorization: `Bearer ${token}` }
        });
        setArmazens(Array.isArray(data) ? data : []);
      } catch {
        setArmazens([]);
      } finally {
        setLoadingArmazens(false);
      }
    };
    loadArmazens();
  }, []);

  const armazensIdentificacao = useMemo(() => {
    const list = Array.isArray(armazens) ? armazens : [];
    const sorted = [...list].sort((a, b) =>
      String(a?.codigo || '').localeCompare(String(b?.codigo || ''), 'pt')
    );
    if (isAdmin(user?.role)) return sorted;
    const ids = new Set(getRequisicoesArmazemOrigemIds(user));
    if (!ids.size) return [];
    return sorted.filter((a) => ids.has(Number(a.id)));
  }, [armazens, user]);

  useEffect(() => {
    if (armazensIdentificacao.length === 1) {
      setArmazemId(String(armazensIdentificacao[0].id));
      return;
    }
    if (
      armazemId &&
      !armazensIdentificacao.some((a) => String(a.id) === String(armazemId))
    ) {
      setArmazemId('');
    }
  }, [armazensIdentificacao, armazemId]);

  const armazemSelecionado = useMemo(
    () => armazensIdentificacao.find((a) => String(a.id) === String(armazemId)),
    [armazensIdentificacao, armazemId]
  );

  useEffect(() => {
    const locs = (armazemSelecionado?.localizacoes || [])
      .map((l) => String(l?.localizacao || '').trim())
      .filter(Boolean);
    setLocalizacoesOpts([...new Set(locs)].sort((a, b) => a.localeCompare(b, 'pt')));
    setLocOpenIdx(null);
    setLoteOpenIdx(null);
    setLotesStockRows([]);
  }, [armazemSelecionado]);

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
        if (modoLoteAtivo) params.set('tipocontrolo', 'LOTE');
        const res = await fetch(`/api/itens?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Erro na pesquisa');
        let itens = Array.isArray(data.itens) ? data.itens : [];
        if (modoLoteAtivo) {
          itens = itens.filter(isItemControloLote);
        }
        setSugestoesLinha(itens);
      } catch {
        setSugestoesLinha([]);
      } finally {
        setLoadingSug(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [linhaSugAtiva, linhas, modoLoteAtivo]);

  const lotesSugestoesFiltradas = useMemo(() => {
    if (loteOpenIdx == null) return [];
    const termo = String(linhas[loteOpenIdx]?.lote || '').trim();
    const q = normalize(termo);
    let list = lotesStockRows;
    if (q) list = list.filter((r) => normalize(r.lote).includes(q));
    return list.slice(0, 40);
  }, [lotesStockRows, loteOpenIdx, linhas]);

  const aplicarLoteNaLinha = useCallback((idx, loteRow) => {
    const lote = String(loteRow?.lote || '').trim().toUpperCase();
    if (!lote) return;
    const qtd = quantidadeParaCampoIdent(quantidadeEtiquetaLote(loteRow));
    setLinhas((prev) =>
      prev.map((l, i) =>
        i === idx ? { ...l, lote, quantidade: qtd } : l
      )
    );
  }, []);

  const procurarLoteStock = useCallback(
    (loteTexto) => {
      const alvo = String(loteTexto || '').trim().toUpperCase();
      if (!alvo) return null;
      return (
        lotesStockRows.find((r) => String(r.lote || '').trim().toUpperCase() === alvo) || null
      );
    },
    [lotesStockRows]
  );

  useEffect(() => {
    if (!modoLoteAtivo || loteOpenIdx == null) {
      setLotesStockRows([]);
      return undefined;
    }
    const linha = linhas[loteOpenIdx];
    const itemId = Number(linha?.item_id || 0);
    const aid = Number(armazemId || 0);
    if (!itemId || !aid) {
      setLotesStockRows([]);
      return undefined;
    }
    const idxAtivo = loteOpenIdx;
    const termoLote = String(linha?.lote || '').trim().toUpperCase();
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoadingLotesSug(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/requisicoes/stock/disponibilidade', {
          params: { item_id: itemId, armazem_id: aid, localizacao: '' },
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        const agregados = agruparLotesStock(data?.lotes);
        setLotesStockRows(agregados);
        if (termoLote) {
          const hit = agregados.find(
            (r) => String(r.lote || '').trim().toUpperCase() === termoLote
          );
          if (hit) {
            setLinhas((prev) =>
              prev.map((l, i) =>
                i === idxAtivo
                  ? {
                      ...l,
                      quantidade: quantidadeParaCampoIdent(quantidadeEtiquetaLote(hit))
                    }
                  : l
              )
            );
          }
        }
      } catch {
        if (!cancelled) setLotesStockRows([]);
      } finally {
        if (!cancelled) setLoadingLotesSug(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [modoLoteAtivo, loteOpenIdx, linhas, armazemId]);

  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest('[data-ident-sug]') && !e.target.closest('[data-ident-loc]') && !e.target.closest('[data-ident-lote]')) {
        setLinhaSugAtiva(null);
        setLocOpenIdx(null);
        setLoteOpenIdx(null);
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
    if (modoLoteAtivo && !isItemControloLote(item)) {
      setToast({
        type: 'error',
        message: 'Selecione um artigo com controlo de stock por Lote.'
      });
      return;
    }
    const cod = String(item.codigo || '').trim();
    const desc = String(item.descricao || item.nome || '').trim();
    const itemId = Number(item.id || item.item_id || 0) || '';
    setLinhas((prev) =>
      prev.map((l, i) =>
        i === idx
          ? {
              ...l,
              codigo: cod,
              descricao: desc,
              item_id: itemId,
              busca: formatArtigoExibicao(cod, desc),
              lote: '',
              quantidade: ''
            }
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
    setLoteOpenIdx(null);
  };

  const adicionarLinha = () => {
    setLinhas((prev) => [...prev, novaLinhaArtigo()]);
  };

  const mudarModo = (novoModo) => {
    setModo(novoModo);
    if (novoModo === MODOS_PDF.TRES_POR_FOLHA) {
      setEtiquetaComLote(false);
    }
    setLinhaSugAtiva(null);
    setLocOpenIdx(null);
    setLoteOpenIdx(null);
  };

  const ativarEtiquetaComLote = (ativo) => {
    setEtiquetaComLote(ativo);
    setLinhas((prev) =>
      prev.map((l) => ({
        ...l,
        localizacao: ativo ? '' : l.localizacao,
        lote: ativo ? l.lote : ''
      }))
    );
    setLocOpenIdx(null);
    setLoteOpenIdx(null);
    setLinhaSugAtiva(null);
  };

  const aplicarCodigoLido = useCallback(
    async (valor, linhaIdx) => {
      const v = String(valor || '').trim();
      if (!v || linhaIdx == null) return;

      const preencher = (cod, desc, itemId = '') => {
        const exib = formatArtigoExibicao(cod, desc) || cod || v;
        setLinhas((prev) =>
          prev.map((l, i) =>
            i === linhaIdx
              ? { ...l, busca: exib, codigo: cod, descricao: desc, item_id: itemId || '' }
              : l
          )
        );
      };

      preencher(v, '', '');
      try {
        const params = new URLSearchParams({ search: v, limit: '8', page: '1' });
        if (modoLoteAtivo) params.set('tipocontrolo', 'LOTE');
        const res = await fetch(`/api/itens?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        let itens = Array.isArray(data.itens) ? data.itens : [];
        if (modoLoteAtivo) itens = itens.filter(isItemControloLote);
        const exact = itens.find((i) => String(i.codigo || '').trim() === v);
        const pick = exact || itens[0];
        if (pick) {
          preencher(
            String(pick.codigo || v).trim(),
            String(pick.descricao || pick.nome || '').trim(),
            Number(pick.id || 0) || ''
          );
        } else if (modoLoteAtivo) {
          setToast({
            type: 'error',
            message: 'Artigo não encontrado ou não é de controlo por Lote.'
          });
        }
      } catch {
        /* mantém valor lido */
      }
    },
    [modoLoteAtivo]
  );

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
          item_id: String(l.item_id || '').trim(),
          localizacao: String(l.localizacao || '').trim(),
          lote: String(l.lote || '').trim(),
          quantidade: String(l.quantidade || '').trim()
        }))
        .filter((l) => l.codigo),
    [linhas]
  );

  const precisaSelecionarArmazem =
    armazensIdentificacao.length > 1 && !armazemId;

  const podeGerar = useMemo(() => {
    if (gerando || loadingArmazens || precisaSelecionarArmazem) return false;
    if (armazensIdentificacao.length === 0) return false;
    if (linhasPreenchidas.length < 1) return false;
    if (modoLoteAtivo) {
      return (
        Boolean(armazemId) &&
        linhasPreenchidas.every((l) => l.lote)
      );
    }
    return linhasPreenchidas.every((l) => l.localizacao);
  }, [
    gerando,
    linhasPreenchidas,
    loadingArmazens,
    precisaSelecionarArmazem,
    armazensIdentificacao.length,
    modoLoteAtivo,
    armazemId
  ]);

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

    if (modoLoteAtivo) {
      for (let i = 0; i < linhasPreenchidas.length; i += 1) {
        if (!linhasPreenchidas[i].lote) {
          setToast({
            type: 'error',
            message: `Indique o lote no artigo ${i + 1}.`
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
        localizacao: modoLoteAtivo ? undefined : l.localizacao,
        lote: modoLoteAtivo ? l.lote : undefined,
        quantidade: isTres ? undefined : l.quantidade || undefined,
        tipoEtiqueta: modoLoteAtivo ? TIPO_ETIQUETA.LOTE : TIPO_ETIQUETA.LOCALIZACAO
      }));

      await gerarPdfIdentificacao({
        modo,
        tipoEtiqueta: modoLoteAtivo ? TIPO_ETIQUETA.LOTE : TIPO_ETIQUETA.LOCALIZACAO,
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
            {modoLoteAtivo && (
              <span className="ml-2 text-[10px] uppercase text-indigo-600 font-medium">Lote</span>
            )}
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
          PDF em A4 (horizontal ou vertical conforme o formato).
          {modoLoteAtivo
            ? ' QR = lote; código de barras = artigo.'
            : ' QR = localização; código de barras = código do artigo.'}
        </p>

        <section className="bg-white rounded-2xl shadow-lg border border-gray-200 p-4 sm:p-6 space-y-5">
          {loadingArmazens ? (
            <p className="text-sm text-gray-500">A carregar armazéns…</p>
          ) : armazensIdentificacao.length === 0 ? (
            <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-3">
              Não há armazéns atribuídos ao seu utilizador para identificação de itens. Peça a um
              administrador para associar armazéns em <strong>Utilizadores</strong>.
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <FaWarehouse className="inline mr-2 text-[#0915FF]" />
                Armazém da identificação
              </label>
              {armazensIdentificacao.length > 1 ? (
                <select
                  value={armazemId}
                  onChange={(e) => setArmazemId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0915FF]/30 focus:border-[#0915FF]"
                >
                  <option value="">Selecione o armazém…</option>
                  {armazensIdentificacao.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.codigo} — {a.descricao}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-gray-800 font-medium px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                  {armazemSelecionado?.codigo} — {armazemSelecionado?.descricao}
                </p>
              )}
              {precisaSelecionarArmazem && (
                <p className="text-xs text-amber-800 mt-1.5">
                  Selecione o armazém
                  {modoLoteAtivo ? ' para sugerir lotes em stock.' : ' para carregar as localizações disponíveis.'}
                </p>
              )}
              {armazemId && !modoLoteAtivo && localizacoesOpts.length === 0 && (
                <p className="text-xs text-amber-800 mt-1.5">
                  Este armazém não tem localizações registadas. Edite o armazém em Armazéns.
                </p>
              )}
            </div>
          )}

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

          {!isTres && (
            <fieldset>
              <legend className="text-sm font-medium text-gray-700 mb-3">Tipo de etiqueta (folha inteira)</legend>
              <div className="flex flex-col sm:flex-row gap-2">
                <label className="flex-1 flex items-start gap-2 p-3 border rounded-lg cursor-pointer has-[:checked]:border-[#0915FF] has-[:checked]:bg-blue-50/50">
                  <input
                    type="radio"
                    name="tipo-etiqueta"
                    className="mt-1"
                    checked={!etiquetaComLote}
                    onChange={() => ativarEtiquetaComLote(false)}
                  />
                  <span className="text-sm text-gray-800">
                    <span className="font-semibold block">Localização</span>
                    <span className="text-xs text-gray-500">QR da localização + quantidade opcional</span>
                  </span>
                </label>
                <label className="flex-1 flex items-start gap-2 p-3 border rounded-lg cursor-pointer has-[:checked]:border-[#0915FF] has-[:checked]:bg-blue-50/50">
                  <input
                    type="radio"
                    name="tipo-etiqueta"
                    className="mt-1"
                    checked={etiquetaComLote}
                    onChange={() => ativarEtiquetaComLote(true)}
                  />
                  <span className="text-sm text-gray-800">
                    <span className="font-semibold block">Artigo com lote</span>
                    <span className="text-xs text-gray-500">Só artigos Lote · QR do lote · LOTE + QTD</span>
                  </span>
                </label>
              </div>
            </fieldset>
          )}

          <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {isTres
                  ? 'Adicione quantos artigos precisar (3 por página A4; novas páginas são criadas automaticamente). Cada etiqueta usa a localização do respetivo artigo no QR.'
                  : modoLoteAtivo
                    ? 'Adicione artigos com controlo por Lote (1 etiqueta por página A4 horizontal). Pesquise só artigos Lote; o número de lote pode ser escolhido entre os registados no seu armazém.'
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
                      {modoLoteAtivo
                        ? 'Artigo Lote (código ou descrição)'
                        : 'Artigo (código ou descrição)'}
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
                              descricao: limparSel ? '' : l.descricao,
                              item_id: limparSel ? '' : l.item_id,
                              lote: limparSel && modoLoteAtivo ? '' : l.lote
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
                      placeholder={
                        modoLoteAtivo
                          ? 'Pesquisar artigo com controlo Lote…'
                          : 'Pesquisar por código ou descrição…'
                      }
                    />
                    {linhaSugAtiva === idx &&
                      sugestoesLinha.length > 0 &&
                      listaSugestoes(sugestoesLinha, (item) => selecionarItemLinha(idx, item))}
                    {linhaSugAtiva === idx && loadingSug && (
                      <p className="text-xs text-gray-500 mt-1">A pesquisar…</p>
                    )}
                  </div>

                  {modoLoteAtivo ? (
                    <>
                      <div className="relative" data-ident-lote>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Lote
                        </label>
                        <input
                          type="text"
                          value={linha.lote}
                          onChange={(e) => {
                            const v = e.target.value.toUpperCase();
                            setLinhas((prev) =>
                              prev.map((l, i) => {
                                if (i !== idx) return l;
                                const next = { ...l, lote: v };
                                if (!v.trim()) next.quantidade = '';
                                return next;
                              })
                            );
                            setLoteOpenIdx(idx);
                          }}
                          onFocus={() => setLoteOpenIdx(idx)}
                          onBlur={() => {
                            const hit = procurarLoteStock(linha.lote);
                            if (hit) aplicarLoteNaLinha(idx, hit);
                          }}
                          disabled={!linha.codigo || !armazemId}
                          placeholder={
                            !linha.codigo
                              ? 'Selecione o artigo primeiro'
                              : !armazemId
                                ? 'Selecione o armazém'
                                : 'Número de lote (sugestões do armazém)'
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[#0915FF]/30 focus:border-[#0915FF] disabled:bg-gray-100"
                        />
                        {loteOpenIdx === idx && lotesSugestoesFiltradas.length > 0 && (
                          <ul className="absolute z-20 left-0 right-0 mt-1 max-h-48 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
                            {lotesSugestoesFiltradas.map((row) => (
                              <li key={row.lote}>
                                <button
                                  type="button"
                                  className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0 flex items-center justify-between gap-2"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    aplicarLoteNaLinha(idx, row);
                                    setLoteOpenIdx(null);
                                  }}
                                >
                                  <span className="font-mono">{row.lote}</span>
                                  {rotuloQtdLoteSugestao(row) ? (
                                    <span className="text-xs text-gray-500 shrink-0">
                                      {rotuloQtdLoteSugestao(row)}
                                    </span>
                                  ) : null}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {loteOpenIdx === idx && loadingLotesSug && (
                          <p className="text-xs text-gray-500 mt-1">A carregar lotes…</p>
                        )}
                        {loteOpenIdx === idx &&
                          !loadingLotesSug &&
                          linha.codigo &&
                          armazemId &&
                          lotesSugestoesFiltradas.length === 0 &&
                          String(linha.lote || '').trim().length >= 1 && (
                            <p className="text-xs text-gray-500 mt-1">
                              Sem lotes em stock neste armazém para este artigo (pode escrever um lote novo).
                            </p>
                          )}
                      </div>
                      <div>
                        <label
                          className="block text-xs font-medium text-gray-600 mb-1"
                          htmlFor={`quantidade-ident-lote-${linha.id}`}
                        >
                          Quantidade
                        </label>
                        <input
                          id={`quantidade-ident-lote-${linha.id}`}
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
                          placeholder={`Preenchida ao escolher o lote — máx. ${MAX_QTD_DIGITOS} dígitos`}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0915FF]/30 focus:border-[#0915FF]"
                        />
                      </div>
                    </>
                  ) : (
                    <>
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
                          disabled={!armazemId || armazensIdentificacao.length === 0}
                          lerDisabled={!armazemId || armazensIdentificacao.length === 0}
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
                                        i === idx ? { ...l, localizacao: loc } : l)
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
                    </>
                  )}
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
