import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { FaFileImport, FaWarehouse } from 'react-icons/fa';
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
import {
  MAX_CODIGOS_IMPORT_IDENT,
  parseCodigosImportados
} from '../utils/parseCodigosImportados';
import { resolverItensPorCodigos } from '../utils/resolverItensPorCodigos';

const MODO_ENTRADA = Object.freeze({
  MANUAL: 'manual',
  IMPORTAR: 'importar'
});

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
  const [modoEntrada, setModoEntrada] = useState(MODO_ENTRADA.MANUAL);
  const [modo, setModo] = useState(MODOS_PDF.FOLHA_INTEIRA);
  const [etiquetaComLote, setEtiquetaComLote] = useState(false);

  const [importTexto, setImportTexto] = useState('');
  const [importResolvendo, setImportResolvendo] = useState(false);
  const [importProgresso, setImportProgresso] = useState({ feito: 0, total: 0 });
  const [importResultados, setImportResultados] = useState([]);
  const importAbortRef = useRef(null);
  const importFileRef = useRef(null);

  const [linhas, setLinhas] = useState([novaLinhaArtigo()]);
  const [linhaSugAtiva, setLinhaSugAtiva] = useState(null);
  const [sugestoesLinha, setSugestoesLinha] = useState([]);
  const [locOpenIdx, setLocOpenIdx] = useState(null);
  const [loteOpenIdx, setLoteOpenIdx] = useState(null);
  const [lotesStockRows, setLotesStockRows] = useState([]);
  const [loadingLotesSug, setLoadingLotesSug] = useState(false);
  const [locStockRows, setLocStockRows] = useState([]);
  const [loadingLocStockSug, setLoadingLocStockSug] = useState(false);

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
  const isImportar = modoEntrada === MODO_ENTRADA.IMPORTAR;

  const importCodigosParsed = useMemo(
    () => parseCodigosImportados(importTexto),
    [importTexto]
  );

  const importEncontrados = useMemo(
    () => (importResultados || []).filter((r) => r.encontrado && r.item),
    [importResultados]
  );

  const importNaoEncontrados = useMemo(
    () => (importResultados || []).filter((r) => !r.encontrado),
    [importResultados]
  );

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

  const carregarLocalizacoesStockLinha = useCallback(
    async (idx, itemId, { preencherUnica = false } = {}) => {
      const aid = Number(armazemId || 0);
      const iid = Number(itemId || 0);
      if (!aid || !iid) {
        setLocStockRows([]);
        return;
      }
      setLoadingLocStockSug(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get(
          `/api/armazens/${aid}/itens/${iid}/localizacoes-com-stock`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const locs = Array.isArray(data?.localizacoes) ? data.localizacoes : [];
        setLocStockRows(locs);
        if (preencherUnica && locs.length === 1) {
          const loc = String(locs[0]?.localizacao || '').trim();
          if (loc) {
            setLinhas((prev) =>
              prev.map((l, i) => (i === idx ? { ...l, localizacao: loc } : l))
            );
          }
        }
      } catch {
        setLocStockRows([]);
      } finally {
        setLoadingLocStockSug(false);
      }
    },
    [armazemId]
  );

  useEffect(() => {
    if (modoLoteAtivo || locOpenIdx == null) {
      setLocStockRows([]);
      return undefined;
    }
    const linha = linhas[locOpenIdx];
    const itemId = Number(linha?.item_id || 0);
    if (!itemId || !armazemId) {
      setLocStockRows([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      carregarLocalizacoesStockLinha(locOpenIdx, itemId).then(() => {
        if (cancelled) return;
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [modoLoteAtivo, locOpenIdx, linhas, armazemId, carregarLocalizacoesStockLinha]);

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
    const fromStock = (locStockRows || [])
      .map((r) => ({
        localizacao: String(r?.localizacao || '').trim(),
        quantidade: Number(r?.quantidade) || 0
      }))
      .filter((r) => r.localizacao);
    const base =
      fromStock.length > 0
        ? fromStock
        : localizacoesOpts.map((loc) => ({ localizacao: loc, quantidade: null }));
    const filtradas = q
      ? base.filter((r) => normalize(r.localizacao).includes(q))
      : base;
    return filtradas.slice(0, 30);
  }, [localizacoesOpts, locOpenIdx, linhas, locStockRows]);

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
              quantidade: '',
              localizacao: ''
            }
          : l
      )
    );
    setLinhaSugAtiva(null);
    setSugestoesLinha([]);
    if (!modoLoteAtivo && itemId && armazemId) {
      carregarLocalizacoesStockLinha(idx, itemId, { preencherUnica: false });
    }
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
    if (ativo) setModoEntrada(MODO_ENTRADA.MANUAL);
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
          const itemIdPick = Number(pick.id || 0) || '';
          preencher(
            String(pick.codigo || v).trim(),
            String(pick.descricao || pick.nome || '').trim(),
            itemIdPick
          );
          if (!modoLoteAtivo && itemIdPick && armazemId) {
            carregarLocalizacoesStockLinha(linhaIdx, itemIdPick, { preencherUnica: false });
          }
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
    [modoLoteAtivo, armazemId, carregarLocalizacoesStockLinha]
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

  const precisaArmazemParaGerar =
    !isImportar && (modoLoteAtivo || precisaSelecionarArmazem);

  const podeGerarManual = useMemo(() => {
    if (gerando || loadingArmazens) return false;
    if (armazensIdentificacao.length === 0) return false;
    if (precisaArmazemParaGerar && !armazemId) return false;
    if (linhasPreenchidas.length < 1) return false;
    if (modoLoteAtivo) {
      return linhasPreenchidas.every((l) => l.lote);
    }
    return true;
  }, [
    gerando,
    linhasPreenchidas,
    loadingArmazens,
    precisaArmazemParaGerar,
    armazensIdentificacao.length,
    modoLoteAtivo,
    armazemId
  ]);

  const podeGerarImport = useMemo(() => {
    if (gerando || importResolvendo || loadingArmazens) return false;
    if (armazensIdentificacao.length === 0) return false;
    if (modoLoteAtivo) return false;
    if (importCodigosParsed.length < 1) return false;
    if (importResultados.length > 0) return importEncontrados.length > 0;
    return true;
  }, [
    gerando,
    importResolvendo,
    loadingArmazens,
    armazensIdentificacao.length,
    modoLoteAtivo,
    importCodigosParsed.length,
    importResultados.length,
    importEncontrados.length
  ]);

  const podeGerar = isImportar ? podeGerarImport : podeGerarManual;

  const validarListaImport = useCallback(async () => {
    const codigos = parseCodigosImportados(importTexto);
    if (codigos.length === 0) {
      setToast({ type: 'error', message: 'Cole ou importe pelo menos um código de artigo.' });
      return [];
    }
    if (codigos.length > MAX_CODIGOS_IMPORT_IDENT) {
      setToast({
        type: 'error',
        message: `Máximo de ${MAX_CODIGOS_IMPORT_IDENT} códigos por importação.`
      });
      return [];
    }

    importAbortRef.current?.abort();
    const ac = new AbortController();
    importAbortRef.current = ac;

    setImportResolvendo(true);
    setImportProgresso({ feito: 0, total: codigos.length });
    setImportResultados([]);
    try {
      const rows = await resolverItensPorCodigos(codigos, {
        signal: ac.signal,
        onProgress: (feito, total) => setImportProgresso({ feito, total })
      });
      if (ac.signal.aborted) return [];
      setImportResultados(rows);
      const ok = rows.filter((r) => r.encontrado).length;
      const falha = rows.length - ok;
      setToast({
        type: falha > 0 ? 'warning' : 'success',
        message:
          falha > 0
            ? `${ok} artigo(s) encontrado(s), ${falha} código(s) sem correspondência.`
            : `${ok} artigo(s) encontrado(s).`
      });
      return rows;
    } catch (e) {
      if (e?.name === 'AbortError') return [];
      setToast({ type: 'error', message: e?.message || 'Erro ao validar códigos.' });
      return [];
    } finally {
      if (importAbortRef.current === ac) {
        setImportResolvendo(false);
        importAbortRef.current = null;
      }
    }
  }, [importTexto]);

  const handleImportarFicheiro = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setImportTexto(text);
      setImportResultados([]);
      setToast({ type: 'success', message: `Ficheiro «${file.name}» carregado.` });
    };
    reader.onerror = () => {
      setToast({ type: 'error', message: 'Não foi possível ler o ficheiro.' });
    };
    reader.readAsText(file, 'UTF-8');
  };

  useEffect(() => {
    return () => importAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isImportar) return;
    setImportResultados([]);
  }, [importTexto, isImportar]);

  const handleGerarPdfImport = async () => {
    if (modoLoteAtivo) {
      setToast({
        type: 'error',
        message: 'Importação de lista só está disponível para etiquetas de localização (não Lote).'
      });
      return;
    }

    let rows = importResultados;
    if (!rows.length || rows.length !== importCodigosParsed.length) {
      rows = await validarListaImport();
      if (!rows.length) return;
    }

    const itensPdf = rows
      .filter((r) => r.encontrado && r.item)
      .map((r) => ({
        codigo: String(r.item.codigo || r.codigo || '').trim(),
        descricao: String(r.item.descricao || r.item.nome || '').trim(),
        tipoEtiqueta: TIPO_ETIQUETA.LOCALIZACAO
      }));

    if (itensPdf.length === 0) {
      setToast({ type: 'error', message: 'Nenhum código da lista foi encontrado no catálogo.' });
      return;
    }

    try {
      setGerando(true);
      await gerarPdfIdentificacao({
        modo,
        tipoEtiqueta: TIPO_ETIQUETA.LOCALIZACAO,
        localizacao: '',
        itens: itensPdf
      });
      setToast({
        type: 'success',
        message: `PDF gerado com ${itensPdf.length} etiqueta(s).`
      });
    } catch (err) {
      setToast({ type: 'error', message: err?.message || 'Erro ao gerar PDF.' });
    } finally {
      setGerando(false);
    }
  };

  const handleGerarPdf = async () => {
    if (isImportar) {
      await handleGerarPdfImport();
      return;
    }

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
        localizacao: modoLoteAtivo ? undefined : (String(l.localizacao || '').trim() || undefined),
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
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Identificação de itens</h1>
        <p className="text-gray-600 mt-1 mb-6">
          PDF em A4 (horizontal ou vertical conforme o formato).
          {modoLoteAtivo
            ? ' QR = lote; código de barras = artigo.'
            : ' Na folha inteira, localização é opcional (QR e texto só se preencher). Código de barras = código do artigo.'}
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
            <legend className="text-sm font-medium text-gray-700 mb-3">Como adicionar artigos</legend>
            <div className="flex flex-col sm:flex-row gap-2 mb-5">
              <label className="flex-1 flex items-start gap-2 p-3 border rounded-lg cursor-pointer has-[:checked]:border-[#0915FF] has-[:checked]:bg-blue-50/50">
                <input
                  type="radio"
                  name="modo-entrada"
                  className="mt-1"
                  checked={modoEntrada === MODO_ENTRADA.MANUAL}
                  onChange={() => setModoEntrada(MODO_ENTRADA.MANUAL)}
                />
                <span className="text-sm text-gray-800">
                  <span className="font-semibold block">Um a um</span>
                  <span className="text-xs text-gray-500">Pesquisar e preencher cada artigo</span>
                </span>
              </label>
              <label
                className={`flex-1 flex items-start gap-2 p-3 border rounded-lg cursor-pointer has-[:checked]:border-[#0915FF] has-[:checked]:bg-blue-50/50 ${
                  modoLoteAtivo ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <input
                  type="radio"
                  name="modo-entrada"
                  className="mt-1"
                  checked={isImportar}
                  disabled={modoLoteAtivo}
                  onChange={() => {
                    if (!modoLoteAtivo) setModoEntrada(MODO_ENTRADA.IMPORTAR);
                  }}
                />
                <span className="text-sm text-gray-800">
                  <span className="font-semibold block">Importar lista</span>
                  <span className="text-xs text-gray-500">
                    Códigos em texto ou ficheiro · gera PDF sem localização
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

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
                    <span className="text-xs text-gray-500">QR da localização (opcional) + quantidade opcional</span>
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

          {isImportar ? (
            <div className="space-y-4 border border-indigo-100 bg-indigo-50/30 rounded-xl p-4">
              <p className="text-sm text-gray-700">
                Cole códigos de artigo (um por linha) ou importe um ficheiro{' '}
                <span className="font-mono text-xs">.txt</span> /{' '}
                <span className="font-mono text-xs">.csv</span>. Cada código gera uma etiqueta;
                localização não é necessária. Máximo {MAX_CODIGOS_IMPORT_IDENT} códigos.
              </p>
              <textarea
                value={importTexto}
                onChange={(e) => setImportTexto(e.target.value)}
                rows={10}
                placeholder={'3000324\n3000325\n3000326'}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#0915FF]/30 focus:border-[#0915FF]"
              />
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".txt,.csv,text/plain,text/csv"
                  className="hidden"
                  onChange={handleImportarFicheiro}
                />
                <button
                  type="button"
                  onClick={() => importFileRef.current?.click()}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50"
                >
                  <FaFileImport /> Escolher ficheiro
                </button>
                <button
                  type="button"
                  onClick={validarListaImport}
                  disabled={importResolvendo || importCodigosParsed.length === 0}
                  className="px-3 py-2 text-sm font-medium border border-indigo-300 text-indigo-800 rounded-lg bg-white hover:bg-indigo-50 disabled:opacity-50"
                >
                  {importResolvendo
                    ? `A validar… (${importProgresso.feito}/${importProgresso.total || importCodigosParsed.length})`
                    : 'Validar lista'}
                </button>
                <span className="text-xs text-gray-600">
                  {importCodigosParsed.length} código(s) na lista
                </span>
              </div>
              {importResultados.length > 0 && (
                <div className="text-sm space-y-2">
                  <p className="text-gray-800">
                    <strong>{importEncontrados.length}</strong> encontrado(s)
                    {importNaoEncontrados.length > 0 && (
                      <>
                        {' '}
                        · <strong className="text-amber-800">{importNaoEncontrados.length}</strong>{' '}
                        sem correspondência
                      </>
                    )}
                  </p>
                  {importNaoEncontrados.length > 0 && (
                    <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 font-mono break-all">
                      {importNaoEncontrados.map((r) => r.codigo).join(', ')}
                    </p>
                  )}
                  {importEncontrados.length > 0 && importEncontrados.length <= 12 && (
                    <ul className="text-xs text-gray-600 max-h-32 overflow-auto border border-gray-200 rounded-lg bg-white divide-y">
                      {importEncontrados.map((r) => (
                        <li key={r.codigo} className="px-2 py-1.5 flex gap-2">
                          <span className="font-mono font-semibold shrink-0">{r.item.codigo}</span>
                          <span className="truncate">{r.item.descricao || r.item.nome}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ) : (
          <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {isTres
                  ? 'Adicione quantos artigos precisar (3 por página A4; novas páginas são criadas automaticamente). Localização opcional (QR e texto na etiqueta).'
                  : modoLoteAtivo
                    ? 'Adicione artigos com controlo por Lote (1 etiqueta por página A4 horizontal). Pesquise só artigos Lote; o número de lote pode ser escolhido entre os registados no seu armazém.'
                    : 'Adicione quantos artigos precisar (1 etiqueta por página A4 horizontal). Localização é opcional; todos entram num único PDF com várias folhas.'}
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
                          Localização (opcional — QR e etiqueta)
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
                          onFocus={() => {
                            setLocOpenIdx(idx);
                            if (linha.item_id && armazemId) {
                              carregarLocalizacoesStockLinha(idx, linha.item_id);
                            }
                          }}
                          onLerClick={() => {
                            setScannerLocLinhaIdx(idx);
                            setScannerLocOpen(true);
                          }}
                          placeholder="Opcional — ex.: GERAL.E"
                          fontMono
                          lerTitle="Ler QR da localização"
                          disabled={!linha.codigo || !armazemId || armazensIdentificacao.length === 0}
                          lerDisabled={!linha.codigo || !armazemId || armazensIdentificacao.length === 0}
                        />
                        {locOpenIdx === idx && loadingLocStockSug && (
                          <p className="text-xs text-gray-500 mt-1">A carregar localizações com stock…</p>
                        )}
                        {locOpenIdx === idx && localizacoesFiltradasLinha.length > 0 && (
                          <ul className="absolute z-20 left-0 right-0 mt-1 max-h-48 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
                            {localizacoesFiltradasLinha.map((row) => (
                              <li key={row.localizacao}>
                                <button
                                  type="button"
                                  className="w-full text-left px-3 py-2 hover:bg-gray-50 font-mono border-b border-gray-100 last:border-0 flex justify-between gap-2"
                                  onClick={() => {
                                    setLinhas((prev) =>
                                      prev.map((l, i) =>
                                        i === idx ? { ...l, localizacao: row.localizacao } : l)
                                    );
                                    setLocOpenIdx(null);
                                  }}
                                >
                                  <span>{row.localizacao}</span>
                                  {row.quantidade != null && Number(row.quantidade) > 0 && (
                                    <span className="text-gray-500 font-sans text-xs shrink-0">
                                      {Number(row.quantidade).toLocaleString('pt-PT', {
                                        maximumFractionDigits: 2
                                      })}
                                    </span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {locOpenIdx === idx &&
                          !loadingLocStockSug &&
                          linha.codigo &&
                          armazemId &&
                          localizacoesFiltradasLinha.length === 0 &&
                          String(linha.localizacao || '').trim().length >= 1 && (
                            <p className="text-xs text-gray-500 mt-1">
                              Sem stock nesta localização para o artigo (pode usar uma localização do armazém).
                            </p>
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
          )}

          <button
            type="button"
            onClick={handleGerarPdf}
            disabled={!podeGerar}
            className="w-full py-3 rounded-lg text-sm font-semibold bg-[#0915FF] text-white hover:bg-[#0712cc] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {gerando
              ? 'A gerar PDF…'
              : isImportar
                ? importResolvendo
                  ? 'A validar códigos…'
                  : isTres
                    ? 'Gerar PDF da lista (A4 vertical)'
                    : 'Gerar PDF da lista (A4 horizontal)'
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
