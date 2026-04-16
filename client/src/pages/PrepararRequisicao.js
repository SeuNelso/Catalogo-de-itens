import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import {
  FaArrowLeft,
  FaCheck,
  FaBox,
  FaMapMarkerAlt,
  FaArrowRight,
  FaEdit,
  FaQrcode,
  FaTrash,
  FaPlus
} from 'react-icons/fa';
import axios from 'axios';
import QrScannerModal from '../components/QrScannerModal';
import PesquisaComLeitorQr from '../components/PesquisaComLeitorQr';
import { FORMATOS_QR_BARCODE } from '../utils/qrBarcodeFormats';
import jsPDF from 'jspdf';
import {
  formatCriadorRequisicao,
  isRequisicaoDoUtilizadorAtual,
  preparacaoReservadaOutroUtilizador
} from '../utils/requisicaoCriador';
import { desenharPaginaNotaEntregaDigi, NOTA_DEVOLUCAO_PDF_OPTS } from '../utils/notaEntregaPdf';
import { quantidadeStockNacionalNoArmazem } from '../utils/stockNacionalArmazem';
import { operadorPodeDocsELogisticaAposSeparacao, isAdmin } from '../utils/roles';
import { podeUsarControloStock } from '../utils/controloStock';
import {
  podeFinalizarDevolucaoTransferenciasPendentes,
  mensagemDocumentosEmFaltaFinalizarDevolucao
} from '../utils/podeFinalizarDevolucaoTransferenciasPendentes';

function labelArmazem(armazem) {
  if (!armazem) return '';
  return armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : (armazem.descricao || '');
}

const MAX_BOBINAS_LOTE = 500;
const RECEBIMENTO_TRANSFERENCIA_MARKER = 'RECEBIMENTO_TRANSFERENCIA_V1';

const normPrepLocBusca = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** Itens LOTE/SN: uma linha por unidade; alinha ao nº em «quantidade preparada». */
function resizeBobinasArray(prevBobinas, n) {
  const prev = Array.isArray(prevBobinas) ? [...prevBobinas] : [];
  const capped = Math.max(0, Math.min(MAX_BOBINAS_LOTE, Math.floor(Number(n)) || 0));
  const empty = () => ({ lote: '', serialnumber: '', metros: '' });
  if (capped === 0) return [];
  if (prev.length === capped) return prev;
  if (prev.length > capped) return prev.slice(0, capped);
  return [...prev, ...Array(capped - prev.length).fill(null).map(() => empty())];
}

const PrepararRequisicao = () => {
  const { id } = useParams();
  const location = useLocation();
  const paramsOrigem = new URLSearchParams(location.search || '');
  const origemPagina = String(paramsOrigem.get('origem') || '').toLowerCase();
  const rotaRetorno = origemPagina === 'transferencias' ? '/transferencias' : '/requisicoes';
  const [requisicao, setRequisicao] = useState(null);
  const [armazemOrigem, setArmazemOrigem] = useState(null);
  const [armazemDestino, setArmazemDestino] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(null);
  const [toast, setToast] = useState(null);
  const [reporteModal, setReporteModal] = useState({
    open: false,
    title: '',
    columns: [],
    rows: [],
    loading: false
  });
  const [itemPreparando, setItemPreparando] = useState(null);
  const [formItem, setFormItem] = useState({
    quantidade_preparada: '',
    localizacao_origem: '',
    localizacao_origem_custom: '',
    localizacao_destino: '',
    localizacao_destino_custom: '',
    lote: '',
    serialnumber: '',
    quantidade_apeados: 0,
    bobinas: [] // itens controlados por LOTE ou S/N
  });
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [prepLocBusca, setPrepLocBusca] = useState('');
  const [serialScannerIdx, setSerialScannerIdx] = useState(null);
  const [serialScannerContinuous, setSerialScannerContinuous] = useState(false);
  const [stockNacionalPrep, setStockNacionalPrep] = useState({ loading: false, valor: null });
  const [addItemSearch, setAddItemSearch] = useState('');
  const [addItemResults, setAddItemResults] = useState([]);
  const [addItemId, setAddItemId] = useState('');
  const [addItemQuantidade, setAddItemQuantidade] = useState('1');
  const [addingItem, setAddingItem] = useState(false);
  /** Stock por localização (armazém central + módulo) para filtrar saída na preparação */
  const [preparacaoStockLoc, setPreparacaoStockLoc] = useState({
    loading: false,
    filtroAtivo: false,
    porLocalizacao: [],
    moduloOff: false,
    semNenhuma: false,
    erro: null,
  });
  // No ciclo de devolução (EM EXPEDICAO = "Em processo"): ao clicar "Receber" mostramos o botão de gerar TRA.
  const [receberAtivo, setReceberAtivo] = useState(false);
  const RECEBER_ATIVO_IDS_KEY = 'devolucao_receber_ativo_ids_v1';
  const EDITAR_ARTIGOS_FOCO_KEY = 'devolucao_editar_artigos_foco_v1';
  const reqReceber = useMemo(() => {
    const p = new URLSearchParams(location.search || '');
    return ['1', 'true', 'yes', 'sim'].includes(String(p.get('receber') || '').toLowerCase());
  }, [location.search]);
  const abortStockPrepRef = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canPrepare = user && ['admin', 'operador', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  const podeDocsPosSeparacao = operadorPodeDocsELogisticaAposSeparacao(user?.role);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetchRequisicao();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Quando chegar com `?receber=1` (feito a partir da lista de devoluções),
  // ativamos o passo "GERAR TRA" para o utilizador avançar no ciclo.
  useEffect(() => {
    // Persistência do passo "Receber -> GERAR TRA":
    // - via ?receber=1 (caso exista)
    // - via localStorage que a listagem usa na card
    // Só faz sentido no ciclo de devolução e antes da TRA ser gerada.
    // A validação "devolução" é feita no render por `isFluxoDevolucao`.
    if (!requisicao) return;

    let persistedActive = false;
    try {
      const raw = window.localStorage.getItem(RECEBER_ATIVO_IDS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          persistedActive = arr.map((x) => Number(x)).filter(Number.isFinite).includes(Number(id));
        }
      }
    } catch (_) {}

    const shouldActivate =
      (reqReceber || persistedActive) &&
      requisicao.status === 'EM EXPEDICAO' &&
      !requisicao.devolucao_tra_gerada_em;

    setReceberAtivo(Boolean(shouldActivate));
  }, [location.search, requisicao, reqReceber, id]);

  useEffect(() => {
    if (!itemPreparando?.item_id || !armazemOrigem) {
      setStockNacionalPrep({ loading: false, valor: null });
      return;
    }
    if (abortStockPrepRef.current) abortStockPrepRef.current.abort();
    const ac = new AbortController();
    abortStockPrepRef.current = ac;
    setStockNacionalPrep((s) => ({ ...s, loading: true }));
    const token = localStorage.getItem('token');
    (async () => {
      try {
        const { data } = await axios.get(`/api/itens/${itemPreparando.item_id}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: ac.signal
        });
        if (abortStockPrepRef.current !== ac) return;
        const q = quantidadeStockNacionalNoArmazem(data.armazens || [], armazemOrigem);
        setStockNacionalPrep({ loading: false, valor: q });
      } catch (err) {
        if (axios.isCancel?.(err) || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        if (abortStockPrepRef.current !== ac) return;
        setStockNacionalPrep({ loading: false, valor: null });
      }
    })();
    return () => {
      ac.abort();
    };
  }, [itemPreparando?.item_id, armazemOrigem]);

  useEffect(() => {
    if (!itemPreparando?.item_id || !armazemOrigem?.id) {
      setPreparacaoStockLoc({
        loading: false,
        filtroAtivo: false,
        porLocalizacao: [],
        moduloOff: false,
        semNenhuma: false,
        erro: null,
      });
      return;
    }
    if (String(armazemOrigem.tipo || '').toLowerCase() !== 'central') {
      setPreparacaoStockLoc({
        loading: false,
        filtroAtivo: false,
        porLocalizacao: [],
        moduloOff: false,
        semNenhuma: false,
        erro: null,
      });
      return;
    }
    if (!podeUsarControloStock(user)) {
      setPreparacaoStockLoc({
        loading: false,
        filtroAtivo: false,
        porLocalizacao: [],
        moduloOff: false,
        semNenhuma: false,
        erro: null,
      });
      return;
    }
    const ac = new AbortController();
    setPreparacaoStockLoc((s) => ({ ...s, loading: true, erro: null }));
    const token = localStorage.getItem('token');
    (async () => {
      try {
        const { data } = await axios.get(
          `/api/armazens/${armazemOrigem.id}/itens/${itemPreparando.item_id}/localizacoes-com-stock`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: ac.signal,
          }
        );
        const locs = Array.isArray(data.localizacoes) ? data.localizacoes : [];
        const moduloOk = data.armazem_central === true && data.modulo_instalado === true;
        const filtro = moduloOk && locs.length > 0;
        setPreparacaoStockLoc({
          loading: false,
          filtroAtivo: filtro,
          porLocalizacao: locs,
          moduloOff: data.armazem_central === true && data.modulo_instalado === false,
          semNenhuma: moduloOk && locs.length === 0,
          erro: null,
        });
      } catch (err) {
        if (axios.isCancel?.(err) || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        setPreparacaoStockLoc({
          loading: false,
          filtroAtivo: false,
          porLocalizacao: [],
          moduloOff: false,
          semNenhuma: false,
          erro: err.response?.data?.error || err.message || 'Erro ao carregar stock por localização',
        });
      }
    })();
    return () => ac.abort();
  }, [itemPreparando?.item_id, armazemOrigem?.id, armazemOrigem?.tipo, user]);

  useEffect(() => {
    if (!preparacaoStockLoc.filtroAtivo) return;
    setFormItem((prev) =>
      prev.localizacao_origem === '_custom_'
        ? { ...prev, localizacao_origem: '', localizacao_origem_custom: '' }
        : prev
    );
  }, [preparacaoStockLoc.filtroAtivo]);

  const fetchRequisicao = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.get(`/api/requisicoes/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      setRequisicao(response.data);

      if (response.data.armazem_origem_id) {
        const ao = await axios.get(`/api/armazens/${response.data.armazem_origem_id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        setArmazemOrigem(ao.data);
      }
      if (response.data.armazem_id) {
        const ad = await axios.get(`/api/armazens/${response.data.armazem_id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        setArmazemDestino(ad.data);
      }
      return response.data;
    } catch (error) {
      console.error('Erro ao buscar requisição:', error);
      setToast({ type: 'error', message: 'Erro ao carregar requisição' });
      navigate(rotaRetorno);
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const isFluxoDevNow =
      String(armazemOrigem?.tipo || requisicao?.armazem_origem_tipo || '').toLowerCase() === 'viatura' &&
      String(armazemDestino?.tipo || requisicao?.armazem_destino_tipo || '').toLowerCase() === 'central';
    if (!isFluxoDevNow) {
      setAddItemResults([]);
      return;
    }
    const q = String(addItemSearch || '').trim();
    if (q.length < 2) {
      setAddItemResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/itens?search=${encodeURIComponent(q)}&limit=20`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        const itens = Array.isArray(data?.itens) ? data.itens : [];
        setAddItemResults(itens);
      } catch (_) {}
    }, 250);
    return () => clearTimeout(t);
  }, [addItemSearch, armazemOrigem?.tipo, armazemDestino?.tipo, requisicao?.armazem_origem_tipo, requisicao?.armazem_destino_tipo]);

  const handleAdicionarItemDevolucao = async () => {
    const itemId = Number(addItemId);
    const qtd = Number(addItemQuantidade || 0);
    if (!Number.isFinite(itemId)) {
      setToast({ type: 'error', message: 'Selecione o artigo correto para adicionar.' });
      return;
    }
    if (!Number.isFinite(qtd) || qtd < 0) {
      setToast({ type: 'error', message: 'Quantidade inválida.' });
      return;
    }
    try {
      setAddingItem(true);
      const token = localStorage.getItem('token');
      const { data } = await axios.post(
        `/api/requisicoes/${id}/requisicao-itens`,
        { item_id: itemId, quantidade: qtd },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setRequisicao(data);
      setAddItemSearch('');
      setAddItemId('');
      setAddItemQuantidade('1');
      setAddItemResults([]);
      setToast({
        type: 'success',
        message:
          'Artigo adicionado. Se o artigo anterior estiver errado, defina quantidade preparada = 0 para desconsiderar.',
      });
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Erro ao adicionar artigo';
      setToast({ type: 'error', message: msg });
    } finally {
      setAddingItem(false);
    }
  };

  const handleRemoverLinhaRequisicao = async (item) => {
    if (!user || !isAdmin(user.role)) return;
    const n = requisicao?.itens?.length || 0;
    if (n <= 1) {
      setToast({ type: 'error', message: 'Não é possível remover o único item da requisição.' });
      return;
    }
    const ok = await confirm({
      title: 'Remover linha',
      message: `Remover o artigo ${item.item_codigo || item.item_id} desta requisição? Esta ação não pode ser desfeita.`,
      variant: 'danger',
      confirmLabel: 'Remover',
    });
    if (!ok) return;
    try {
      const token = localStorage.getItem('token');
      const { data } = await axios.delete(`/api/requisicoes/${id}/requisicao-itens/${item.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRequisicao(data);
      if (itemPreparando?.id === item.id) {
        setItemPreparando(null);
      }
      setToast({ type: 'success', message: 'Linha removida.' });
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Erro ao remover';
      setToast({ type: 'error', message: msg });
    }
  };

  const abrirPrepararItem = (item) => {
    const st = requisicao?.status;
    const adminPodeCorrigir =
      user && isAdmin(user.role) && (st === 'separado' || st === 'EM EXPEDICAO');
    if (st && st !== 'pendente' && st !== 'EM SEPARACAO' && !adminPodeCorrigir) {
      setToast({
        type: 'error',
        message:
          'Após a requisição avançar, só um administrador pode alterar a preparação (em Separadas ou Em expedição).',
      });
      return;
    }
    setItemPreparando(item);
    const locs = armazemOrigem?.localizacoes?.map((l) => l.localizacao).filter(Boolean) || [];
    let locOrigem = item.localizacao_origem || '';
    if (
      String(armazemOrigem?.tipo || '').toLowerCase() === 'viatura' &&
      String(armazemDestino?.tipo || '').toLowerCase() === 'central'
    ) {
      const cod = String(armazemOrigem.codigo || '').trim().toUpperCase();
      const ferr = item.is_ferramenta === true;
      const expected = ferr ? `${cod}.FERR` : cod;
      const existing = String(locOrigem).trim();
      if (!existing) {
        if (locs.includes(expected)) locOrigem = expected;
        else if (locs.length === 1) locOrigem = locs[0];
      }
    }
    const isOrigemCustom = locOrigem && locs.length > 0 && !locs.includes(locOrigem);
    const isRecebimentoMercadoria = String(requisicao?.observacoes || '')
      .toUpperCase()
      .startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER);
    const qtdPreparada = isRecebimentoMercadoria
      ? (
          item.quantidade_preparada !== undefined && item.quantidade_preparada !== null
            ? item.quantidade_preparada
            : ''
        )
      : (
          item.quantidade_preparada !== undefined && item.quantidade_preparada !== null
            ? item.quantidade_preparada
            : item.quantidade
        );
    const tipoControlo = (item.tipocontrolo || '').toUpperCase();
    const isLote = tipoControlo === 'LOTE';
    const isSerial = tipoControlo === 'S/N';
    const serialsExistentes = String(item.serialnumber || '')
      .split(/\r?\n|;|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    const nBobinas = Math.max(0, Math.min(MAX_BOBINAS_LOTE, Math.floor(Number(qtdPreparada)) || 0));
    const bobinasInicial = (isLote || isSerial)
      ? resizeBobinasArray(
        (item.bobinas || []).length > 0
          ? item.bobinas
          : (isSerial ? serialsExistentes.map((s) => ({ lote: '', serialnumber: s, metros: '' })) : []),
        nBobinas
      )
      : (item.bobinas || []);
    setFormItem({
      quantidade_preparada: qtdPreparada,
      localizacao_origem: isOrigemCustom ? '_custom_' : locOrigem,
      localizacao_origem_custom: isOrigemCustom ? locOrigem : '',
      localizacao_destino: '',
      localizacao_destino_custom: '',
      lote: item.lote || '',
      serialnumber: item.serialnumber || '',
      quantidade_apeados: 0,
      bobinas: bobinasInicial
    });
  };

  // Ação "Editar" na lista de devoluções:
  // Quando o utilizador clica no ícone de editar ao lado de "Confirmar artigos",
  // guardamos o ID num localStorage e abrimos automaticamente o modal "Preparar item" / "Editar preparação".
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!requisicao) return;
    if (!armazemOrigem) return;

    let focando = false;
    let focoId = null;
    try {
      const raw = window.localStorage.getItem(EDITAR_ARTIGOS_FOCO_KEY);
      if (raw) {
        // Aceita: "123" ou JSON "123"
        focoId = (() => {
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed[0] : parsed;
          } catch (_) {
            return raw;
          }
        })();
      }
    } catch (_) {}

    if (focoId != null && Number(focoId) === Number(id)) {
      focando = true;
    }

    if (!focando) return;

    const itens = requisicao.itens || [];
    const item =
      itens.find((it) => it.preparacao_confirmada === true) ||
      itens.find((it) => it.preparacao_confirmada !== true) ||
      null;

    if (item) {
      // Se a ação for bloqueada por permissão/estado, a função vai mostrar toast e não altera o estado.
      abrirPrepararItem(item);
    }

    try {
      window.localStorage.removeItem(EDITAR_ARTIGOS_FOCO_KEY);
    } catch (_) {}
  }, [requisicao, armazemOrigem, id]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const downloadExport = async (urlPath, filename, successMsg) => {
    const token = localStorage.getItem('token');
    const response = await fetch(urlPath, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) {
      let msg = 'Falha ao exportar';
      try {
        const data = await response.json();
        if (data.error) msg = data.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
    setToast({ type: 'success', message: successMsg });
  };

  const handleExportTRFL = async (opts = {}) => {
    const isDev = !!opts.isFluxoDevolucao;
    try {
      const ok = await confirm({
        title: 'Gerar TRFL',
        message: isDev
          ? 'Devolução: este ficheiro move o stock da localização de recebimento para a zona final no armazém central. Depois a requisição passará a APEADOS.'
          : 'Deseja continuar? Ao continuar, a requisição será marcada como Em expedição.',
        confirmLabel: 'Continuar'
      });
      if (!ok) return;

      await downloadExport(
        `/api/requisicoes/${id}/export-trfl`,
        `TRFL_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'TRFL gerada com sucesso.'
      );
      if (requisicao?.status === 'separado') {
        const token = localStorage.getItem('token');
        const resp = await fetch(`/api/requisicoes/${id}/marcar-em-expedicao`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) {
          const updated = await fetchRequisicao(true);
          if ((updated?.status || '') !== 'EM EXPEDICAO') {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || 'Erro ao marcar em expedição');
          }
        }
      }
      await fetchRequisicao(true);
    } catch (error) {
      console.error('Erro ao exportar TRFL:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRFL' });
    }
  };

  const handleExportTRA = async (opts = {}) => {
    const isDev = !!opts.isFluxoDevolucao;
    try {
      const ok = await confirm({
        title: isDev ? 'Gerar DEV' : 'Gerar TRA',
        message: isDev
          ? 'Devolução: este DEV regista a entrada no armazém central na localização de recebimento (origem = viatura e localização preparada).'
          : 'Deseja continuar? Após gerar a TRA, esta requisição ficará apta para FINALIZAR.',
        confirmLabel: 'Continuar'
      });
      if (!ok) return;

      await downloadExport(
        `/api/requisicoes/${id}/export-tra`,
        `${isDev ? 'DEV' : 'TRA'}_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        isDev ? 'DEV gerado com sucesso.' : 'TRA gerada com sucesso.'
      );

      if (isDev) {
        // Se a TRA for da devolução, limpamos o passo local para a UI.
        try {
          const raw = window.localStorage.getItem(RECEBER_ATIVO_IDS_KEY);
          const arr = raw ? JSON.parse(raw) : [];
          if (Array.isArray(arr)) {
            const next = arr.map((x) => Number(x)).filter(Number.isFinite);
            const filtered = next.filter((x) => x !== Number(id));
            window.localStorage.setItem(RECEBER_ATIVO_IDS_KEY, JSON.stringify(filtered));
          }
        } catch (_) {}
        setReceberAtivo(false);
      }

      await fetchRequisicao(true);
    } catch (error) {
      console.error('Erro ao exportar TRA:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRA' });
    }
  };

  const handleExportReporte = async () => {
    try {
      const st = requisicao?.status;
      const podeReporte =
        ['Entregue', 'FINALIZADO'].includes(st) && (st === 'FINALIZADO' || requisicao?.tra_gerada_em);
      if (!podeReporte) {
        setToast({
          type: 'error',
          message: 'Ficheiro de reporte só está disponível após gerar a TRA (Entregue) ou quando a requisição estiver finalizada.'
        });
        return;
      }

      setReporteModal(prev => ({ ...prev, open: false, loading: true }));
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${id}/reporte-dados`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do reporte');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Reporte (Requisição #${id})`,
        columns: data.columns || [],
        rows: data.rows || [],
        loading: false
      });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao preparar reporte' });
      setReporteModal(prev => ({ ...prev, loading: false }));
    }
  };

  const closeReporteModal = () => {
    setReporteModal(prev => ({ ...prev, open: false }));
  };

  const copyReporteTable = async () => {
    try {
      if (!reporteModal?.rows?.length) {
        setToast({ type: 'error', message: 'Nada para copiar' });
        return;
      }
      const columns = Array.isArray(reporteModal.columns) ? reporteModal.columns : [];
      if (!columns.length) {
        setToast({ type: 'error', message: 'Sem colunas para copiar' });
        return;
      }
      const headerLine = columns.join('\t');
      const bodyLines = reporteModal.rows.map(r => columns.map(c => (r?.[c] ?? '').toString().replace(/\r?\n/g, ' ')).join('\t'));
      const tsv = [headerLine, ...bodyLines].join('\n');
      const escapeHtml = (val) => String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      const htmlTable = `
        <table style="border-collapse:collapse; font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
          <thead>
            <tr>
              ${columns.map((c) => `<th style="border:1px solid #000; padding:4px 6px; background:#f2f2f2; font-weight:bold; text-align:center; white-space:nowrap;">${escapeHtml(c)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${reporteModal.rows.map((r) => {
              const isSep = String(r?.Artigo ?? '').startsWith('--- Requisição #');
              const trStyle = isSep ? 'background:#f2f2f2; font-weight:bold;' : '';
              return `
                <tr style="${trStyle}">
                  ${columns.map((c) => {
                    const v = r?.[c] ?? '';
                    const align = c === 'Descrição' || c === 'Observações' ? 'left' : 'center';
                    return `<td style="border:1px solid #000; padding:4px 6px; text-align:${align}; vertical-align:top;">${escapeHtml(v)}</td>`;
                  }).join('')}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `.trim();

      if (navigator?.clipboard?.write && window?.ClipboardItem) {
        const items = [
          new window.ClipboardItem({
            'text/html': new Blob([htmlTable], { type: 'text/html' }),
            'text/plain': new Blob([tsv], { type: 'text/plain' })
          })
        ];
        await navigator.clipboard.write(items);
      } else if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = tsv;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setToast({ type: 'success', message: 'Tabela do reporte copiada (TSV).' });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao copiar tabela' });
    }
  };

  const downloadReporteXlsx = async () => {
    try {
      await downloadExport(
        `/api/requisicoes/${id}/export-reporte`,
        `REPORTE_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'Ficheiro de reporte gerado com sucesso.'
      );
      closeReporteModal();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao baixar ficheiro de reporte' });
    }
  };

  const handleEntregar = async () => {
    try {
      if (!isFluxoDevolucao) {
        if (requisicao?.status !== 'EM EXPEDICAO') {
          setToast({ type: 'error', message: 'Só é possível entregar quando a requisição está em expedição.' });
          return;
        }
      } else {
        if (!['EM EXPEDICAO', 'APEADOS'].includes(requisicao?.status)) {
          setToast({ type: 'error', message: 'Só é possível entregar no ciclo de devolução após EM EXPEDICAO/APEADOS.' });
          return;
        }
      }
      const ok = await confirm({
        title: 'Entregar',
        message: 'Tem certeza que deseja continuar? Isso vai alterar o status para Entregue.',
        confirmLabel: 'Sim, entregar',
        variant: 'warning'
      });
      if (!ok) return;

      // PDF «Nota de entrega» (template DIGI) antes de mudar status
      try {
        const today = new Date();
        const dateStr = today.toISOString().slice(0, 10);
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageHeightActual = doc.internal.pageSize.getHeight();

        desenharPaginaNotaEntregaDigi(doc, requisicao, { isFirstPage: true, dataRef: today });

        const sigTop = pageHeightActual - 60 - 70;
        const lastY = doc.lastAutoTable?.finalY || 0;
        if (lastY + 30 > sigTop) {
          doc.addPage();
        }

        const pageWidth = doc.internal.pageSize.getWidth();
        const leftX1 = 60;
        const leftX2 = pageWidth / 2 - 20;
        const rightX1 = pageWidth / 2 + 20;
        const rightX2 = pageWidth - 60;
        const y = doc.internal.pageSize.getHeight() - 60 - 70;

        doc.setFontSize(10);
        doc.text('Assinatura do Armazém', (leftX1 + leftX2) / 2, y, { align: 'center' });
        doc.line(leftX1, y + 34, leftX2, y + 34);
        doc.text('Nome / assinatura', (leftX1 + leftX2) / 2, y + 52, { align: 'center' });

        doc.text('Assinatura do Recebedor', (rightX1 + rightX2) / 2, y, { align: 'center' });
        doc.line(rightX1, y + 34, rightX2, y + 34);
        doc.text('Nome / assinatura', (rightX1 + rightX2) / 2, y + 52, { align: 'center' });

        doc.save(`NOTA_ENTREGA_${id}_${dateStr}.pdf`);
      } catch (_) {}


      const token = localStorage.getItem('token');
      const resp = await fetch(`/api/requisicoes/${id}/marcar-entregue`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao entregar');
      }
      setToast({ type: 'success', message: 'Requisição marcada como Entregue.' });
      await fetchRequisicao(true);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao entregar' });
    }
  };

  const handleFinalizar = async () => {
    try {
      const ok = await confirm({
        title: 'Finalizar',
        message: 'Tem certeza que deseja finalizar esta devolução?',
        confirmLabel: 'Sim, finalizar',
        variant: 'warning'
      });
      if (!ok) return;

      const token = localStorage.getItem('token');
      const resp = await fetch(`/api/requisicoes/${id}/finalizar`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao finalizar');
      }
      setToast({ type: 'success', message: 'Devolução finalizada.' });
      await fetchRequisicao(true);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao finalizar' });
    }
  };

  const fecharPrepararItem = () => {
    setPrepLocBusca('');
    setItemPreparando(null);
    setPreparacaoStockLoc({
      loading: false,
      filtroAtivo: false,
      porLocalizacao: [],
      moduloOff: false,
      semNenhuma: false,
      erro: null,
    });
    setFormItem({
      quantidade_preparada: '',
      localizacao_origem: '',
      localizacao_origem_custom: '',
      localizacao_destino: '',
      localizacao_destino_custom: '',
      lote: '',
      serialnumber: '',
      quantidade_apeados: 0,
      bobinas: []
    });
  };

  const handleQuantidadePreparadaChange = (e) => {
    const val = e.target.value;
    setFormItem((prev) => {
      const next = { ...prev, quantidade_preparada: val };
      const tipoControlo = (itemPreparando?.tipocontrolo || '').toUpperCase();
      if (tipoControlo === 'LOTE' || tipoControlo === 'S/N') {
        const n = Math.max(0, Math.min(MAX_BOBINAS_LOTE, Math.floor(Number(val)) || 0));
        next.bobinas = resizeBobinasArray(prev.bobinas, n);
      }
      // Se a checkbox de APEADO estiver ativa, mantemos quantidade_apeados dentro do total.
      const totalQty = Math.floor(Number(next.quantidade_preparada) || 0);
      const prevApeados = Number(next.quantidade_apeados) || 0;
      if (prevApeados > 0) {
        next.quantidade_apeados = Math.min(prevApeados, totalQty);
        if (next.quantidade_apeados <= 0) next.quantidade_apeados = 0;
      }
      return next;
    });
  };

  const handleCompletarSeparacao = async () => {
    if (preparacaoReservadaOutroUtilizador(requisicao, user)) {
      setToast({ type: 'error', message: 'Esta requisição está a ser preparada por outro utilizador.' });
      return;
    }
    const itensInsatisfeitos = requisicao.itens?.filter(it => (parseInt(it.quantidade_preparada) || 0) < (parseInt(it.quantidade) || 0)) ?? [];
    if (itensInsatisfeitos.length > 0) {
      const ok = await confirm({
        title: 'Concluir preparação',
        message: 'Um ou mais itens têm quantidade preparada inferior à requisitada. Tem certeza que deseja concluir a preparação mesmo assim?',
        confirmLabel: 'Sim, concluir',
        variant: 'warning'
      });
      if (!ok) return;
    }
    try {
      const token = localStorage.getItem('token');
      const response = await axios.patch(`/api/requisicoes/${id}/completar-separacao`, {}, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      setRequisicao(response.data);
      if (isFluxoDevolucao) {
        // Para devoluções (viatura → central), após preparar a separação queremos avançar o ciclo
        // para "Em processo" (status EM EXPEDICAO) automaticamente.
        try {
          await axios.patch(`/api/requisicoes/${id}/confirmar-separacao`, {}, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          await axios.patch(`/api/requisicoes/${id}/marcar-em-expedicao`, {}, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          await fetchRequisicao(true);
          setToast({ type: 'success', message: 'Devolução em processo.' });
        } catch (e) {
          // Se a operação falhar (ex.: permissões), não interrompemos o fluxo principal.
          console.error('Erro ao avançar ciclo da devolução:', e);
          setToast({ type: 'success', message: 'Separação da devolução concluída. Pode avançar o ciclo pelos botões.' });
        }
        setTimeout(() => navigate('/devolucoes'), 1500);
      } else {
        setToast({ type: 'success', message: 'Separação da requisição concluída!' });
        setTimeout(() => navigate(rotaRetorno), 1500);
      }
    } catch (error) {
      const msg = error.response?.data?.error || 'Erro ao completar separação';
      setToast({ type: 'error', message: msg });
    }
  };

  const handlePrepararItem = async (e) => {
    e.preventDefault();
    if (!canPrepare || !itemPreparando) return;

    const qtdRequisitada = parseFloat(itemPreparando.quantidade) || 0;
    let qtdPreparadaNumerica = 0;

    if ((itemPreparando.tipocontrolo || '').toUpperCase() === 'LOTE' && Array.isArray(formItem.bobinas) && formItem.bobinas.length > 0) {
      qtdPreparadaNumerica = formItem.bobinas.reduce((sum, b) => sum + (parseFloat(b.metros) || 0), 0);
    } else {
      const qtd = parseFloat(formItem.quantidade_preparada);
      if (Number.isNaN(qtd) || qtd < 0) {
        setToast({ type: 'error', message: 'Informe uma quantidade válida (use 0 se não tiver o item).' });
        return;
      }
      qtdPreparadaNumerica = qtd;
    }

    if (qtdPreparadaNumerica !== qtdRequisitada) {
      const msg = `A quantidade preparada (${qtdPreparadaNumerica}) é diferente da quantidade requisitada (${qtdRequisitada}). Confirma que esta diferença é intencional?`;
      const ok = await confirm({
        title: 'Quantidade diferente da requisitada',
        message: msg,
        confirmLabel: 'Sim, confirmar assim mesmo',
        variant: 'warning'
      });
      if (!ok) return;
    }

    const locOrigem = isFluxoRecebimentoMercadoria
      ? ''
      : ((formItem.localizacao_origem === '_custom_' ? formItem.localizacao_origem_custom : formItem.localizacao_origem)?.trim() || '');
    if (!isFluxoRecebimentoMercadoria && !locOrigem) {
      setToast({ type: 'error', message: 'A localização de saída (onde está saindo) é obrigatória.' });
      return;
    }

    if (!isFluxoRecebimentoMercadoria && podeUsarControloStock(user) && preparacaoStockLoc.filtroAtivo && qtdPreparadaNumerica > 0) {
      const row = preparacaoStockLoc.porLocalizacao.find(
        (r) => String(r.localizacao || '').trim().toUpperCase() === locOrigem.toUpperCase()
      );
      const disp = row != null ? Number(row.quantidade) : NaN;
      if (!Number.isFinite(disp)) {
        setToast({
          type: 'error',
          message: 'Escolha uma localização onde este artigo tem stock registado.',
        });
        return;
      }
      if (disp + 1e-9 < qtdPreparadaNumerica) {
        setToast({
          type: 'error',
          message: `Stock insuficiente na localização selecionada (disponível: ${disp}, necessário: ${qtdPreparadaNumerica}).`,
        });
        return;
      }
    }

    const tipoControlo = (itemPreparando.tipocontrolo || '').toUpperCase();
    let bobinasPayload = undefined;
    if (tipoControlo === 'LOTE') {
      if (!Array.isArray(formItem.bobinas) || formItem.bobinas.length === 0) {
        setToast({ type: 'error', message: 'Adicione pelo menos uma bobina (lote + metros).' });
        return;
      }
      const bobinasValidas = [];
      for (const b of formItem.bobinas) {
        const lote = (b.lote || '').trim();
        const metros = Number(b.metros);
        if (!lote || !metros || metros <= 0) {
          setToast({ type: 'error', message: 'Cada bobina deve ter lote e metragem > 0.' });
          return;
        }
        bobinasValidas.push({
          lote,
          serialnumber: (b.serialnumber || '').trim() || null,
          metros
        });
      }
      bobinasPayload = bobinasValidas;
    } else if (tipoControlo === 'S/N') {
      if (!Array.isArray(formItem.bobinas) || formItem.bobinas.length === 0) {
        setToast({ type: 'error', message: 'Adicione pelo menos um serial number.' });
        return;
      }
      const seriais = [];
      for (const b of formItem.bobinas) {
        const sn = (b.serialnumber || '').trim();
        if (!sn) {
          setToast({ type: 'error', message: 'Cada linha de S/N deve ter um serial number.' });
          return;
        }
        seriais.push(sn);
      }
      const duplicados = seriais.filter((sn, i) => seriais.indexOf(sn) !== i);
      if (duplicados.length > 0) {
        const unicos = [...new Set(duplicados)];
        setToast({
          type: 'error',
          message: `Existem serial numbers repetidos: ${unicos.join(', ')}`
        });
        return;
      }
      bobinasPayload = seriais.map((sn) => ({ serialnumber: sn }));
    }

    try {
      setSubmitting(itemPreparando.id);
      const token = localStorage.getItem('token');
      await axios.patch(
        `/api/requisicoes/${id}/atender-item`,
        {
          requisicao_item_id: itemPreparando.id,
          quantidade_preparada:
            (tipoControlo === 'LOTE' || tipoControlo === 'S/N') && bobinasPayload
              ? bobinasPayload.length
              : qtdPreparadaNumerica,
          quantidade_apeados: Math.max(0, Math.floor(Number(formItem.quantidade_apeados) || 0)),
          localizacao_origem: isFluxoRecebimentoMercadoria ? null : locOrigem,
          lote: formItem.lote || null,
          serialnumber: formItem.serialnumber || null,
          bobinas: tipoControlo === 'LOTE' ? bobinasPayload : undefined,
          serials: tipoControlo === 'S/N' ? bobinasPayload.map((b) => b.serialnumber) : undefined
          // localizacao_destino = EXPEDICAO é definida automaticamente no servidor
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      setToast({ type: 'success', message: 'Item preparado com sucesso!' });
      fecharPrepararItem();
      await fetchRequisicao(true);
    } catch (error) {
      const data = error.response?.data;
      let msg = data?.error || 'Erro ao preparar item';
      if (data?.details) msg += ': ' + data.details;
      setToast({ type: 'error', message: msg });
    } finally {
      setSubmitting(null);
    }
  };

  const locsOrigemParaPreparacao = useMemo(() => {
    const todas = armazemOrigem?.localizacoes?.map((l) => l.localizacao).filter(Boolean) || [];
    if (!podeUsarControloStock(user)) return todas;
    if (preparacaoStockLoc.loading || !preparacaoStockLoc.filtroAtivo) return todas;
    const comStock = new Set(
      (preparacaoStockLoc.porLocalizacao || [])
        .filter((r) => Number(r.quantidade) > 0)
        .map((r) => String(r.localizacao || '').trim())
    );
    const filtradas = todas.filter((loc) => comStock.has(loc));
    const salvo = itemPreparando?.localizacao_origem
      ? String(itemPreparando.localizacao_origem).trim()
      : '';
    if (filtradas.length === 0) return todas;
    if (salvo && todas.includes(salvo) && !filtradas.includes(salvo)) {
      return [salvo, ...filtradas.filter((x) => x !== salvo)];
    }
    return filtradas;
  }, [armazemOrigem, preparacaoStockLoc, itemPreparando?.localizacao_origem, user]);

  const locsOrigemSelectFiltradas = useMemo(() => {
    const q = normPrepLocBusca(prepLocBusca);
    if (!q) return locsOrigemParaPreparacao;
    return locsOrigemParaPreparacao.filter((loc) => normPrepLocBusca(loc).includes(q));
  }, [locsOrigemParaPreparacao, prepLocBusca]);

  useEffect(() => {
    setPrepLocBusca('');
  }, [itemPreparando?.id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto" />
          <p className="mt-4 text-gray-600">Carregando requisição...</p>
        </div>
      </div>
    );
  }

  if (!requisicao) return null;

  const isPendente = requisicao.status === 'pendente';
  const isEmSeparacao = requisicao.status === 'EM SEPARACAO';
  const isSeparado = requisicao.status === 'separado';
  const isEmExpedicao = requisicao.status === 'EM EXPEDICAO';
  /** Pendente/EM SEPARACAO: todos com canPrepare; Separadas/Em expedição: só admin (API igual). */
  const podeEditarItensPreparacao =
    isPendente ||
    isEmSeparacao ||
    (user && isAdmin(user.role) && (isSeparado || isEmExpedicao));
  const podeAdminRemoverLinha =
    user && isAdmin(user.role) && (isSeparado || isEmExpedicao) && (requisicao.itens?.length || 0) > 1;
  const fasePreparacaoAberta = isPendente || isEmSeparacao;
  const locsOrigem = armazemOrigem?.localizacoes?.map((l) => l.localizacao).filter(Boolean) || [];
  const todosPreparados = requisicao.itens?.every(it => it.preparacao_confirmada === true) ?? false;
  const itensPorConfirmar = requisicao.itens?.filter(it => it.preparacao_confirmada !== true) ?? [];
  const preparacaoBloqueadaOutrem = preparacaoReservadaOutroUtilizador(requisicao, user);
  const podeAgirSeparacao = canPrepare && !preparacaoBloqueadaOutrem;
  const podeTrflTraReporte = podeAgirSeparacao && podeDocsPosSeparacao;
  const isFluxoDevolucao =
    String(armazemOrigem?.tipo || requisicao.armazem_origem_tipo || '').toLowerCase() === 'viatura' &&
    String(armazemDestino?.tipo || requisicao.armazem_destino_tipo || '').toLowerCase() === 'central';
  const isFluxoRecebimentoMercadoria = String(requisicao?.observacoes || '')
    .toUpperCase()
    .startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER);
  const tituloOrigem = isFluxoRecebimentoMercadoria ? 'Origem (fornecimento)' : 'Origem';
  const tituloDestino = isFluxoRecebimentoMercadoria ? 'Destino (recebimento)' : 'Destino';
  const valorOrigem = isFluxoRecebimentoMercadoria
    ? (requisicao.armazem_descricao || '—')
    : (requisicao.armazem_origem_descricao || '—');
  const valorDestino = isFluxoRecebimentoMercadoria
    ? (requisicao.armazem_origem_descricao || '—')
    : (requisicao.armazem_descricao || '—');
  const podeFinalizarTransferenciasPendentes =
    requisicao && podeFinalizarDevolucaoTransferenciasPendentes(requisicao);

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        {preparacaoBloqueadaOutrem && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 text-sm">
            <strong>Separação em curso por outro utilizador.</strong>{' '}
            {requisicao.separador_nome && requisicao.separador_nome !== '—' ? (
              <>Atribuída a <strong>{requisicao.separador_nome}</strong>. Só esse utilizador, ou administrador/backoffice armazém/supervisor armazém, pode preparar ou avançar esta requisição.</>
            ) : (
              <>Só o utilizador que iniciou a preparação, ou administrador/backoffice armazém/supervisor armazém, pode continuar.</>
            )}
          </div>
        )}
        <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
          <button
            onClick={() => navigate(rotaRetorno)}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-800"
          >
            <FaArrowLeft /> Voltar
          </button>
          <div className="flex gap-2 flex-wrap">
            {(requisicao.status === 'separado' && requisicao.separacao_confirmada) && podeTrflTraReporte && isFluxoDevolucao && (
              <button
                onClick={() => handleExportTRA({ isFluxoDevolucao: true })}
                className="px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors"
                title="Devolução: DEV de entrada no central (localização de recebimento)"
              >
                GERAR DEV (devolução)
              </button>
            )}
            {(requisicao.status === 'separado' && requisicao.separacao_confirmada) && podeTrflTraReporte && !isFluxoDevolucao && !isFluxoRecebimentoMercadoria && (
              <button
                onClick={handleExportTRFL}
                className="px-3 py-2 text-blue-700 hover:bg-blue-50 rounded-lg border border-blue-300 transition-colors"
                title="Gerar TRFL — após confirmar, o status passará a Em expedição"
              >
                GERAR TRFL
              </button>
            )}

            {/* Fluxo devolução: EM EXPEDICAO ("Em processo") */}
            {isFluxoDevolucao &&
              requisicao.status === 'EM EXPEDICAO' &&
              podeAgirSeparacao &&
              !requisicao.devolucao_tra_gerada_em &&
              !receberAtivo &&
              !reqReceber && (
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const today = new Date();
                      const dateStr = today.toISOString().slice(0, 10);
                      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
                      const pageHeightActual = doc.internal.pageSize.getHeight();
                      desenharPaginaNotaEntregaDigi(doc, requisicao, {
                        isFirstPage: true,
                        dataRef: today,
                        ...NOTA_DEVOLUCAO_PDF_OPTS
                      });
                      const sigTop = pageHeightActual - 60 - 70;
                      const lastY = doc.lastAutoTable?.finalY || 0;
                      if (lastY + 30 > sigTop) {
                        doc.addPage();
                      }
                      const pageWidth = doc.internal.pageSize.getWidth();
                      const leftX1 = 60;
                      const leftX2 = pageWidth / 2 - 20;
                      const rightX1 = pageWidth / 2 + 20;
                      const rightX2 = pageWidth - 60;
                      const y = doc.internal.pageSize.getHeight() - 60 - 70;
                      doc.setFontSize(10);
                      doc.text('Assinatura do Armazém', (leftX1 + leftX2) / 2, y, { align: 'center' });
                      doc.line(leftX1, y + 34, leftX2, y + 34);
                      doc.text('Nome / assinatura', (leftX1 + leftX2) / 2, y + 52, { align: 'center' });
                      doc.text('Assinatura do Recebedor', (rightX1 + rightX2) / 2, y, { align: 'center' });
                      doc.line(rightX1, y + 34, rightX2, y + 34);
                      doc.text('Nome / assinatura', (rightX1 + rightX2) / 2, y + 52, { align: 'center' });
                      doc.save(`NOTA_DEVOLUCAO_${id}_${dateStr}.pdf`);
                      setToast({ type: 'success', message: 'Nota de devolução gerada.' });
                    } catch (err) {
                      setToast({ type: 'error', message: err?.message || 'Erro ao gerar nota de devolução.' });
                    }
                    setReceberAtivo(true);
                  }}
                  className="px-3 py-2 bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition-colors"
                  title="Receber a devolução (passo para gerar a TRA)"
                >
                  Receber
                </button>
              )}

            {isFluxoDevolucao &&
              requisicao.status === 'EM EXPEDICAO' &&
              podeAgirSeparacao &&
              !requisicao.devolucao_tra_gerada_em &&
              (receberAtivo || reqReceber) && (
                <button
                  type="button"
                  onClick={() => handleExportTRA({ isFluxoDevolucao: true })}
                  className="px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors"
                  title="Devolução: gerar DEV (entrada no central em localização de recebimento)"
                >
                  GERAR DEV
                </button>
              )}

            {isFluxoDevolucao &&
              (requisicao.status === 'EM EXPEDICAO' || requisicao.status === 'APEADOS') &&
              podeAgirSeparacao &&
              !!requisicao.devolucao_tra_gerada_em && (
                <button
                  type="button"
                  onClick={handleFinalizar}
                  disabled={!podeFinalizarTransferenciasPendentes}
                  className={`px-3 py-2 rounded-lg transition-colors ${
                    podeFinalizarTransferenciasPendentes
                      ? 'bg-slate-700 text-white hover:bg-slate-800'
                      : 'bg-slate-300 text-slate-600 cursor-not-allowed'
                  }`}
                  title={
                    podeFinalizarTransferenciasPendentes
                      ? 'Marcar devolução como Finalizada'
                      : mensagemDocumentosEmFaltaFinalizarDevolucao(requisicao) ||
                        'Conclua os documentos em falta antes de finalizar.'
                  }
                >
                  FINALIZAR
                </button>
              )}

            {/* Requisição normal: EM EXPEDICAO */}
            {!isFluxoDevolucao &&
              !isFluxoRecebimentoMercadoria &&
              requisicao.status === 'EM EXPEDICAO' &&
              podeAgirSeparacao && (
                <button
                  type="button"
                  onClick={handleEntregar}
                  className="px-3 py-2 bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition-colors"
                  title="Alterar status para Entregue"
                >
                  ENTREGAR
                </button>
              )}

            {requisicao.status === 'Entregue' && !requisicao.tra_gerada_em && podeTrflTraReporte && (
              <button
                onClick={handleExportTRA}
                className="px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors"
                title="Gerar TRA"
              >
                GERAR TRA
              </button>
            )}
            {((requisicao.status === 'Entregue' && requisicao.tra_gerada_em) || requisicao.status === 'FINALIZADO') && podeTrflTraReporte && (
              <button
                onClick={handleExportReporte}
                className="px-3 py-2 text-slate-700 hover:bg-slate-100 rounded-lg border border-slate-300 transition-colors"
                title="Gerar ficheiro de reporte"
              >
                FICHEIRO DE REPORTE
              </button>
            )}
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
            {isFluxoRecebimentoMercadoria
              ? `Preparar Recebimento #${id}`
              : isFluxoDevolucao
                ? `Preparar Devolução #${id}`
                : `Preparar Requisição #${id}`}
          </h1>
          {!isFluxoDevolucao && !isFluxoRecebimentoMercadoria && (
            <p className="text-gray-600">
              Prepare cada item: confirme a quantidade e escolha a localização de saída. O destino é sempre <strong>EXPEDICAO</strong>.
            </p>
          )}
          {isFluxoRecebimentoMercadoria && (
            <p className="text-gray-600">
              Confirme a quantidade realmente recebida de cada item. O destino é sempre a <strong>localização de recebimento</strong> do armazém destino.
            </p>
          )}
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            {requisicao.armazem_origem_descricao && (
              <div>
                <span className="text-sm text-gray-500">{tituloOrigem}</span>
                <p className="font-medium text-gray-900">{valorOrigem}</p>
              </div>
            )}
            <div>
              <span className="text-sm text-gray-500">{tituloDestino}</span>
              <p className="font-medium text-gray-900">{valorDestino}</p>
            </div>
            <div>
              <span className="text-sm text-gray-500">Criado por</span>
              <p className="font-medium text-gray-900 flex flex-wrap items-center gap-2">
                {formatCriadorRequisicao(requisicao)}
                {isRequisicaoDoUtilizadorAtual(requisicao, user) && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-800">
                    A sua requisição
                  </span>
                )}
              </p>
            </div>
            {requisicao.separador_usuario_id != null && requisicao.separador_nome && (
              <div>
                <span className="text-sm text-gray-500">Separação / preparação</span>
                <p className="font-medium text-gray-900">
                  {requisicao.separador_nome}
                  {Number(requisicao.separador_usuario_id) === Number(user?.id) && (
                    <span className="ml-2 text-xs font-semibold text-emerald-700">(consigo continuar)</span>
                  )}
                </p>
              </div>
            )}
            <div>
              <span className="text-sm text-gray-500">Status</span>
              <p>
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                  requisicao.status === 'pendente' ? 'bg-yellow-100 text-yellow-800' :
                  requisicao.status === 'EM SEPARACAO' ? 'bg-orange-100 text-orange-900' :
                  requisicao.status === 'separado' ? 'bg-green-100 text-green-800' :
                  requisicao.status === 'EM EXPEDICAO' ? 'bg-blue-100 text-blue-800' :
                  requisicao.status === 'APEADOS' ? 'bg-purple-100 text-purple-800' :
                  requisicao.status === 'Entregue' ? 'bg-emerald-100 text-emerald-800' :
                  requisicao.status === 'FINALIZADO' ? 'bg-slate-200 text-slate-900' :
                  requisicao.status === 'cancelada' ? 'bg-red-100 text-red-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {requisicao.status === 'pendente' ? 'Pendente' :
                    requisicao.status === 'EM SEPARACAO' ? 'Em separação' :
                    requisicao.status === 'separado' ? 'Separadas' :
                    requisicao.status === 'EM EXPEDICAO' ? ((isFluxoDevolucao || isFluxoRecebimentoMercadoria) ? 'Em processo' : 'Em expedição') :
                    requisicao.status === 'APEADOS' ? 'APEADOS' :
                    requisicao.status === 'Entregue' ? 'Entregue' :
                    requisicao.status === 'FINALIZADO' ? 'Finalizado' :
                    requisicao.status === 'cancelada' ? 'Cancelada' : requisicao.status}
                </span>
              </p>
            </div>
          </div>

          <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <FaBox /> Itens a preparar
          </h3>
          {isFluxoDevolucao && podeAgirSeparacao && podeEditarItensPreparacao && (
            <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <div className="text-xs font-semibold text-indigo-900 mb-2">
                Correção da devolução: adicionar artigo correto
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_120px_160px] gap-2 items-end">
                <div>
                  <label className="block text-xs text-indigo-900 mb-1">Pesquisar artigo (código/descrição)</label>
                  <input
                    type="text"
                    value={addItemSearch}
                    onChange={(e) => setAddItemSearch(e.target.value)}
                    className="w-full px-3 py-2 border border-indigo-300 rounded-lg text-sm"
                    placeholder="Ex.: 3000331"
                  />
                  {addItemResults.length > 0 && (
                    <select
                      value={addItemId}
                      onChange={(e) => setAddItemId(e.target.value)}
                      className="mt-2 w-full px-3 py-2 border border-indigo-300 rounded-lg text-sm bg-white"
                    >
                      <option value="">Selecione o artigo encontrado</option>
                      {addItemResults.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.codigo} - {it.descricao}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-indigo-900 mb-1">Quantidade</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={addItemQuantidade}
                    onChange={(e) => setAddItemQuantidade(e.target.value)}
                    className="w-full px-3 py-2 border border-indigo-300 rounded-lg text-sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAdicionarItemDevolucao}
                  disabled={addingItem}
                  className="px-3 py-2 bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <FaPlus /> {addingItem ? 'A adicionar...' : 'Adicionar artigo'}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-indigo-900/80">
                Dica: para desconsiderar um artigo errado, abra “Editar preparação” e guarde com quantidade preparada igual a 0.
              </p>
            </div>
          )}
          <div className="space-y-4">
            {requisicao.itens && requisicao.itens.map((item, idx) => {
              const qtdPreparada = parseInt(item.quantidade_preparada) || 0;
              const qtdTotal = parseInt(item.quantidade) || 0;
              const completo = qtdPreparada >= qtdTotal;
              const isPreparando = itemPreparando?.id === item.id;
              const preparado = item.preparacao_confirmada === true;

              return (
                <div
                  key={item.id ?? item.item_id ?? idx}
                  className={`p-4 rounded-lg border-2 transition-colors ${
                    preparado ? 'bg-green-50 border-green-200' :
                    isPreparando ? 'bg-blue-50 border-[#0915FF]' :
                    'bg-gray-50 border-gray-200'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {isPreparando ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-[#0915FF]">
                              A preparar
                            </span>
                            {preparado && (
                              <span className="text-green-600 text-xs font-medium flex items-center gap-1">
                                <FaCheck /> Já tinha preparação
                              </span>
                            )}
                          </div>
                          <div className="font-mono font-semibold text-gray-900">{item.item_codigo}</div>
                          <p className="text-sm text-gray-600 line-clamp-2" title={item.item_descricao}>
                            {item.item_descricao}
                          </p>
                          <p className="text-xs text-gray-500">
                            Pedido na requisição:{' '}
                            <strong className="text-[#0915FF] tabular-nums">{item.quantidade}</strong>
                            {(qtdPreparada > 0 || preparado) && (
                              <span className="text-gray-500"> · já registado: {qtdPreparada}</span>
                            )}
                          </p>
                        </div>
                      ) : (
                        <>
                          <div className="font-medium text-gray-900">{item.item_codigo}</div>
                          <div className="text-sm text-gray-500">{item.item_descricao}</div>
                          <div className="mt-2 flex items-center gap-4 text-sm flex-wrap">
                            <span>
                              Quantidade: <strong className="text-[#0915FF]">{item.quantidade}</strong>
                              {(qtdPreparada > 0 || preparado) && (
                                <span className="ml-2 text-gray-600">(preparado: {qtdPreparada})</span>
                              )}
                            </span>
                            {preparado && (
                              <span className="text-green-600 font-medium flex items-center gap-1">
                                <FaCheck /> Preparado{!completo && ' (quantidade parcial)'}
                              </span>
                            )}
                          </div>
                          {(String(item.tipocontrolo || '').toUpperCase() === 'LOTE' ||
                            String(item.tipocontrolo || '').toUpperCase() === 'S/N' ||
                            String(item.lote || '').trim() ||
                            String(item.serialnumber || '').trim()) && (
                            <div className="mt-2 text-xs text-gray-700 flex flex-wrap gap-2">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200 rounded">
                                <strong>Controlo:</strong> {String(item.tipocontrolo || '—').toUpperCase()}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200 rounded">
                                <strong>Lote:</strong> {String(item.lote || '').trim() || '—'}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200 rounded">
                                <strong>S/N:</strong> {String(item.serialnumber || '').trim() || '—'}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                      {!isPreparando && !isFluxoRecebimentoMercadoria && (item.localizacao_origem || item.localizacao_destino) && (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          {item.localizacao_origem && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-200 rounded">
                              <FaMapMarkerAlt /> Saída: {item.localizacao_origem}
                            </span>
                          )}
                          {item.localizacao_destino && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-200 rounded">
                              <FaArrowRight /> Chegada: {item.localizacao_destino}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 flex-shrink-0">
                      {podeAgirSeparacao && !item.preparacao_confirmada && podeEditarItensPreparacao && (
                        <button
                          type="button"
                          onClick={() => abrirPrepararItem(item)}
                          disabled={!!itemPreparando}
                          className="px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] disabled:opacity-50 transition-colors flex items-center gap-2"
                        >
                          <FaBox /> Preparar item
                        </button>
                      )}
                      {podeAgirSeparacao && item.preparacao_confirmada && podeEditarItensPreparacao && (
                        <button
                          type="button"
                          onClick={() => abrirPrepararItem(item)}
                          disabled={!!itemPreparando}
                          className="px-4 py-2 border border-[#0915FF] text-[#0915FF] rounded-lg hover:bg-[#0915FF] hover:text-white disabled:opacity-50 transition-colors flex items-center gap-2"
                        >
                          <FaEdit /> Editar preparação
                        </button>
                      )}
                      {podeAdminRemoverLinha && (
                        <button
                          type="button"
                          onClick={() => handleRemoverLinhaRequisicao(item)}
                          disabled={!!itemPreparando}
                          className="px-4 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors flex items-center gap-2"
                          title="Remover esta linha (apenas administrador)"
                        >
                          <FaTrash /> Remover linha
                        </button>
                      )}
                    </div>
                  </div>

                  {isPreparando && (
                    <form onSubmit={handlePrepararItem} className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                      {isFluxoDevolucao && (
                        <section className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm space-y-2">
                          <h4 className="text-sm font-semibold text-indigo-900">
                            Dados importados da devolução (conferência)
                          </h4>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
                            <div className="rounded-md border border-indigo-200 bg-white px-2 py-1.5">
                              <span className="text-indigo-700 font-semibold">Controlo:</span>{' '}
                              <span className="text-indigo-900">
                                {String(item.tipocontrolo || '—').toUpperCase()}
                              </span>
                            </div>
                            <div className="rounded-md border border-indigo-200 bg-white px-2 py-1.5">
                              <span className="text-indigo-700 font-semibold">Qtd. esperada:</span>{' '}
                              <span className="text-indigo-900 tabular-nums">
                                {Number(item.quantidade) || 0}
                              </span>
                            </div>
                            <div className="rounded-md border border-indigo-200 bg-white px-2 py-1.5">
                              <span className="text-indigo-700 font-semibold">Lote:</span>{' '}
                              <span className="text-indigo-900">
                                {String(item.lote || '').trim() || '—'}
                              </span>
                            </div>
                            <div className="rounded-md border border-indigo-200 bg-white px-2 py-1.5">
                              <span className="text-indigo-700 font-semibold">S/N:</span>{' '}
                              <span className="text-indigo-900 break-all">
                                {String(item.serialnumber || '').trim() || '—'}
                              </span>
                            </div>
                          </div>
                        </section>
                      )}
                      <nav
                        className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold"
                        aria-label="Passos da preparação"
                      >
                        <span className="rounded-md bg-[#0915FF] text-white px-2.5 py-1 shadow-sm">1 · Quantidade</span>
                        {!isFluxoRecebimentoMercadoria && (
                          <>
                            <span className="text-gray-300" aria-hidden>
                              →
                            </span>
                            <span className="rounded-md bg-gray-200 text-gray-800 px-2.5 py-1">2 · Local</span>
                          </>
                        )}
                        <span className="text-gray-300" aria-hidden>
                          →
                        </span>
                        <span className="rounded-md bg-gray-100 text-gray-500 px-2.5 py-1">
                          {isFluxoRecebimentoMercadoria ? '2 · Confirmar' : '3 · Confirmar'}
                        </span>
                      </nav>

                      <>
                      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                        <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0915FF]/12 text-xs font-bold text-[#0915FF]">
                            1
                          </span>
                          {isFluxoRecebimentoMercadoria ? 'Quantidade recebida' : 'Quantidade a separar'}
                        </h4>
                        <div className="flex flex-col sm:flex-row sm:items-stretch gap-4">
                          <div className="flex-1 min-w-0 space-y-2">
                            <label className="block text-xs font-medium text-gray-500" htmlFor={`qtd-prep-${item.id}`}>
                              {isFluxoRecebimentoMercadoria ? 'Unidades / bobinas recebidas agora' : 'Unidades / bobinas a preparar agora'}
                            </label>
                            <input
                              id={`qtd-prep-${item.id}`}
                              type="number"
                              min="0"
                              step={(item.tipocontrolo || '').toUpperCase() === 'LOTE' ? 1 : 'any'}
                              value={formItem.quantidade_preparada}
                              onChange={handleQuantidadePreparadaChange}
                              onFocus={(e) => e.target.select()}
                              placeholder={isFluxoRecebimentoMercadoria ? 'Digite a quantidade recebida' : ''}
                              inputMode="decimal"
                              className="w-full sm:max-w-[160px] px-3 py-2.5 border-2 border-gray-200 rounded-xl text-xl font-semibold tabular-nums text-gray-900 focus:border-[#0915FF] focus:ring-2 focus:ring-[#0915FF]/25"
                              required
                            />
                            {isFluxoRecebimentoMercadoria && (
                              <p className="text-[11px] text-gray-500">
                                Digite a quantidade real recebida para este artigo.
                              </p>
                            )}
                            {isFluxoDevolucao && (
                              <div className="rounded-lg border border-violet-100 bg-violet-50/60 px-3 py-2 space-y-2">
                                <label className="flex items-center gap-2 text-sm text-violet-900 cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={Number(formItem.quantidade_apeados) > 0}
                                    onChange={(e) => {
                                      const totalQty = Math.floor(Number(formItem.quantidade_preparada) || 0);
                                      const nextChecked = Boolean(e.target.checked);

                                      if (!nextChecked) {
                                        setFormItem((prev) => ({ ...prev, quantidade_apeados: 0 }));
                                        return;
                                      }

                                      if (totalQty < 1) {
                                        setToast({
                                          type: 'error',
                                          message: 'Defina primeiro uma quantidade de devolução (mínimo 1).'
                                        });
                                        return;
                                      }

                                      setFormItem((prev) => {
                                        const current = Number(prev.quantidade_apeados) || 0;
                                        const nextApeados = current > 0 ? current : 1;
                                        return { ...prev, quantidade_apeados: Math.min(nextApeados, totalQty) };
                                      });
                                    }}
                                  />
                                  <span>Parte desta quantidade é APEADOS</span>
                                </label>

                                {Number(formItem.quantidade_apeados) > 0 && (
                                  <div>
                                    <label className="block text-xs font-medium text-violet-900 mb-1">
                                      Qtd. APEADOS (mín. 1)
                                    </label>
                                    <input
                                      type="number"
                                      min="1"
                                      step="1"
                                      max={Math.floor(Number(formItem.quantidade_preparada) || 0)}
                                      value={formItem.quantidade_apeados}
                                      onChange={(e) => {
                                        const totalQty = Math.floor(Number(formItem.quantidade_preparada) || 0);
                                        const nextVal = Math.floor(Number(e.target.value) || 0);
                                        if (totalQty < 1) return;
                                        const clamped = Math.max(1, Math.min(nextVal, totalQty));
                                        setFormItem((prev) => ({ ...prev, quantidade_apeados: clamped }));
                                      }}
                                      className="w-full sm:w-32 px-3 py-2 border border-violet-200 rounded-lg bg-white text-sm"
                                      required
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          {!isFluxoRecebimentoMercadoria && armazemOrigem && (
                            <div className="sm:w-44 shrink-0 flex flex-col justify-center rounded-xl border border-gray-100 bg-gradient-to-b from-slate-50 to-white px-4 py-3 text-center sm:text-right">
                              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                                Stock nacional
                              </div>
                              <div
                                className="text-[11px] text-gray-500 truncate mt-1 sm:ml-auto max-w-full"
                                title={labelArmazem(armazemOrigem)}
                              >
                                {labelArmazem(armazemOrigem)}
                              </div>
                              <div className="mt-2 text-2xl font-bold tabular-nums text-gray-900">
                                {stockNacionalPrep.loading ? (
                                  <span className="inline-block animate-pulse">…</span>
                                ) : stockNacionalPrep.valor != null ? (
                                  stockNacionalPrep.valor
                                ) : (
                                  '—'
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </section>
                      {(item.tipocontrolo || '').toUpperCase() === 'LOTE' && (
                        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                          <h4 className="text-sm font-semibold text-gray-800">Bobinas (lote e metros)</h4>
                          {(formItem.bobinas || []).length === 0 && (
                            <p className="text-xs text-gray-500">
                              Indique acima a quantidade preparada (número de bobinas) para mostrar os campos de lote e metragem.
                            </p>
                          )}
                          <div className="space-y-2">
                            {(formItem.bobinas || []).map((b, idxBob) => (
                              <div
                                key={idxBob}
                                className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end border border-gray-200 rounded-lg p-2"
                              >
                                <div className="sm:col-span-2">
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Lote da bobina {idxBob + 1}
                                  </label>
                                  <input
                                    type="text"
                                    value={b.lote}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setFormItem(prev => ({
                                        ...prev,
                                        bobinas: prev.bobinas.map((bb, i) =>
                                          i === idxBob ? { ...bb, lote: val } : bb
                                        )
                                      }));
                                    }}
                                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                                    placeholder="Lote"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Metros
                                  </label>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={b.metros}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setFormItem(prev => ({
                                        ...prev,
                                        bobinas: prev.bobinas.map((bb, i) =>
                                          i === idxBob ? { ...bb, metros: val } : bb
                                        )
                                      }));
                                    }}
                                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                                    placeholder="Ex: 120.5"
                                  />
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setFormItem((prev) => {
                                        const bobinas = (prev.bobinas || []).filter((_, i) => i !== idxBob);
                                        return {
                                          ...prev,
                                          bobinas,
                                          quantidade_preparada: String(bobinas.length)
                                        };
                                      })
                                    }
                                    className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50"
                                  >
                                    Remover
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                      {(item.tipocontrolo || '').toUpperCase() === 'S/N' && (
                        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-sm font-semibold text-gray-800">Seriais (S/N)</h4>
                            <button
                              type="button"
                              onClick={() => {
                                const firstEmpty = (formItem.bobinas || []).findIndex((b) => !(b.serialnumber || '').trim());
                                const startIdx = firstEmpty >= 0 ? firstEmpty : 0;
                                if ((formItem.bobinas || []).length === 0) {
                                  setToast({
                                    type: 'error',
                                    message: 'Defina primeiro a quantidade preparada para gerar as linhas de S/N.'
                                  });
                                  return;
                                }
                                setSerialScannerContinuous(true);
                                setSerialScannerIdx(startIdx);
                              }}
                              className="px-2.5 py-1.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 flex items-center gap-1 text-xs"
                              title="Ler vários seriais em sequência"
                            >
                              <FaQrcode /> Scanner contínuo
                            </button>
                          </div>
                          {(formItem.bobinas || []).length === 0 && (
                            <p className="text-xs text-gray-500">
                              Indique acima a quantidade preparada para mostrar os campos de serial number.
                            </p>
                          )}
                          <div className="space-y-2">
                            {(formItem.bobinas || []).map((b, idxBob) => (
                              <div
                                key={idxBob}
                                className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end border border-gray-200 rounded-lg p-2"
                              >
                                <div className="sm:col-span-3">
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Serial number {idxBob + 1}
                                  </label>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      value={b.serialnumber}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setFormItem(prev => ({
                                          ...prev,
                                          bobinas: prev.bobinas.map((bb, i) =>
                                            i === idxBob ? { ...bb, serialnumber: val } : bb
                                          )
                                        }));
                                      }}
                                      className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                                      placeholder="Informe o serial"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSerialScannerContinuous(false);
                                        setSerialScannerIdx(idxBob);
                                      }}
                                      className="px-2.5 py-1.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 flex items-center gap-1 text-xs shrink-0"
                                      title="Ler serial com câmara"
                                    >
                                      <FaQrcode /> Câmara
                                    </button>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setFormItem((prev) => {
                                        const bobinas = (prev.bobinas || []).filter((_, i) => i !== idxBob);
                                        return {
                                          ...prev,
                                          bobinas,
                                          quantidade_preparada: String(bobinas.length)
                                        };
                                      })
                                    }
                                    className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50"
                                  >
                                    Remover
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                          <QrScannerModal
                            open={serialScannerIdx != null}
                            onClose={() => {
                              setSerialScannerIdx(null);
                              setSerialScannerContinuous(false);
                            }}
                            onScan={(texto) => {
                              const sn = (texto || '').trim();
                              if (!sn || serialScannerIdx == null) return;
                              setFormItem((prev) => ({
                                ...prev,
                                bobinas: (prev.bobinas || []).map((bb, i) =>
                                  i === serialScannerIdx ? { ...bb, serialnumber: sn } : bb
                                )
                              }));
                              if (serialScannerContinuous) {
                                const total = (formItem.bobinas || []).length;
                                const nextIdx = serialScannerIdx + 1;
                                if (nextIdx < total) {
                                  setSerialScannerIdx(nextIdx);
                                  setToast({ type: 'success', message: `Serial ${serialScannerIdx + 1}/${total} lido.` });
                                } else {
                                  setSerialScannerIdx(null);
                                  setSerialScannerContinuous(false);
                                  setToast({ type: 'success', message: 'Leitura contínua concluída.' });
                                }
                              } else {
                                setToast({ type: 'success', message: `Serial lido: ${sn}` });
                              }
                            }}
                            title="Ler serial (código de barras / QR)"
                            readerId="qr-reader-serial"
                            closeOnScan={!serialScannerContinuous}
                            formatsToSupport={FORMATOS_QR_BARCODE}
                          />
                        </section>
                      )}
                      {!isFluxoRecebimentoMercadoria && (
                      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                        <h4 className="text-sm font-semibold text-gray-900 flex flex-wrap items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0915FF]/12 text-xs font-bold text-[#0915FF]">
                            2
                          </span>
                          Localização de saída
                          <span className="text-red-600 text-xs font-normal">obrigatório</span>
                        </h4>
                        {armazemOrigem && (
                          <p className="text-xs text-gray-600 flex flex-wrap items-center gap-2">
                            <FaMapMarkerAlt className="text-amber-600 shrink-0" aria-hidden />
                            <span>
                              <span className="text-gray-500">Armazém:</span>{' '}
                              <strong className="text-gray-800">
                                {armazemOrigem.codigo ? `${armazemOrigem.codigo} — ` : ''}
                                {armazemOrigem.descricao}
                              </strong>
                            </span>
                            {locsOrigem.length === 0 && (
                              <span className="text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-0.5 text-[11px]">
                                Sem localizações cadastradas
                              </span>
                            )}
                          </p>
                        )}
                        {preparacaoStockLoc.loading && (
                          <p className="text-xs text-gray-500 flex items-center gap-2">
                            <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-gray-300 border-t-[#0915FF] animate-spin" />
                            A carregar localizações…
                          </p>
                        )}
                        {preparacaoStockLoc.erro && (
                          <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            {preparacaoStockLoc.erro}
                          </p>
                        )}
                        {preparacaoStockLoc.filtroAtivo && (
                          <div className="flex items-start gap-2 text-xs text-emerald-900 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                            <FaCheck className="shrink-0 mt-0.5 text-emerald-600" aria-hidden />
                            <span>Lista filtrada: só localizações com stock registado deste artigo.</span>
                          </div>
                        )}
                        {preparacaoStockLoc.semNenhuma && (
                          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                            Sem stock em nenhuma localização. Pode continuar a indicar localização; o servidor valida ao
                            guardar. Atualize o armazém se for preciso.
                          </div>
                        )}
                        {preparacaoStockLoc.moduloOff && String(armazemOrigem?.tipo || '').toLowerCase() === 'central' && (
                          <details className="text-xs text-gray-600 border border-dashed border-gray-200 rounded-lg px-3 py-1">
                            <summary className="cursor-pointer py-1.5 font-medium text-gray-700 list-none [&::-webkit-details-marker]:hidden">
                              Módulo de stock por localização
                            </summary>
                            <p className="pb-2 text-gray-500 leading-relaxed">
                              Não está configurado neste ambiente: todas as localizações aparecem. Com o módulo ativo, o
                              servidor reforça as regras ao guardar.
                            </p>
                          </details>
                        )}
                        {locsOrigem.length > 0 ? (
                          <>
                            <div className="mb-2">
                              <PesquisaComLeitorQr
                                value={prepLocBusca}
                                onChange={(e) => setPrepLocBusca(e.target.value)}
                                placeholder="Filtrar ou ler localização de saída…"
                                onLerClick={() => setShowQrScanner(true)}
                                lerTitle="Ler QR ou código de barras da localização"
                                lerAriaLabel="Ler QR ou código de barras da localização de saída"
                              />
                            </div>
                            <select
                              value={formItem.localizacao_origem}
                              onChange={(e) => setFormItem((prev) => ({ ...prev, localizacao_origem: e.target.value }))}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                              required
                            >
                              <option value="">Selecione a localização...</option>
                              {locsOrigemSelectFiltradas.map((loc, i) => {
                                let label = loc;
                                if (preparacaoStockLoc.filtroAtivo) {
                                  const r = preparacaoStockLoc.porLocalizacao.find(
                                    (x) => String(x.localizacao || '').trim() === String(loc).trim()
                                  );
                                  if (r && Number(r.quantidade) > 0) {
                                    label = `${loc} (${Number(r.quantidade)} disp.)`;
                                  }
                                }
                                return (
                                  <option key={`${loc}-${i}`} value={loc}>
                                    {label}
                                  </option>
                                );
                              })}
                              {!preparacaoStockLoc.filtroAtivo && <option value="_custom_">Outra (digite)</option>}
                            </select>
                            {locsOrigemParaPreparacao.length > 0 && locsOrigemSelectFiltradas.length === 0 && (
                              <p className="text-[11px] text-amber-800 mt-1">Nenhuma localização corresponde ao filtro.</p>
                            )}
                            {formItem.localizacao_origem === '_custom_' && (
                              <div className="mt-2">
                                <PesquisaComLeitorQr
                                  value={formItem.localizacao_origem_custom}
                                  onChange={(e) =>
                                    setFormItem((prev) => ({ ...prev, localizacao_origem_custom: e.target.value }))
                                  }
                                  placeholder="Digite a localização de saída"
                                  onLerClick={() => setShowQrScanner(true)}
                                  lerTitle="Ler QR ou código de barras da localização"
                                  lerAriaLabel="Ler localização personalizada"
                                />
                              </div>
                            )}
                          </>
                        ) : (
                          <PesquisaComLeitorQr
                            value={formItem.localizacao_origem}
                            onChange={(e) => setFormItem((prev) => ({ ...prev, localizacao_origem: e.target.value }))}
                            placeholder="Ex: Prateleira A3"
                            onLerClick={() => setShowQrScanner(true)}
                            lerTitle="Ler QR ou código de barras da localização"
                            lerAriaLabel="Ler localização de saída"
                          />
                        )}
                      </section>
                      )}
                      {!isFluxoRecebimentoMercadoria && (
                      <QrScannerModal
                        open={showQrScanner}
                        onClose={() => setShowQrScanner(false)}
                        onScan={(texto) => {
                          const loc = (texto || '').trim();
                          if (!loc) return;
                          setPrepLocBusca(loc);
                          if (locsOrigem.length > 0) {
                            let pendingToast = null;
                            setFormItem((prev) => {
                              if (locsOrigemParaPreparacao.includes(loc)) {
                                pendingToast = { type: 'success', message: `Localização definida: ${loc}` };
                                return { ...prev, localizacao_origem: loc, localizacao_origem_custom: '' };
                              }
                              if (prev.localizacao_origem === '_custom_') {
                                pendingToast = { type: 'success', message: `Localização definida: ${loc}` };
                                return { ...prev, localizacao_origem_custom: loc };
                              }
                              pendingToast = {
                                type: 'error',
                                message: `Localização não reconhecida. Use uma das opções permitidas: ${locsOrigemParaPreparacao.join(', ')}`
                              };
                              return prev;
                            });
                            if (pendingToast) setToast(pendingToast);
                          } else {
                            setFormItem((prev) => ({ ...prev, localizacao_origem: loc }));
                            setToast({ type: 'success', message: `Localização definida: ${loc}` });
                          }
                        }}
                        title="Ler localização (QR ou código de barras)"
                        formatsToSupport={FORMATOS_QR_BARCODE}
                      />
                      )}
                      </>
                      <section className="rounded-xl border-2 border-gray-200 bg-gradient-to-br from-slate-50 to-white p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between shadow-sm">
                        <div className="flex items-start gap-3 min-w-0">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0915FF] text-xs font-bold text-white shadow-md">
                            {isFluxoRecebimentoMercadoria ? '2' : '3'}
                          </span>
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                              Confirmar · destino fixo
                            </p>
                            <p className="text-sm text-gray-900 mt-1 leading-snug">
                              {isFluxoRecebimentoMercadoria ? (
                                <>Entrada → <strong>RECEBIMENTO</strong></>
                              ) : (
                                <>Saída → <strong>EXPEDICAO</strong></>
                              )}
                              {armazemDestino?.codigo && !isFluxoRecebimentoMercadoria && (
                                <>
                                  {' '}
                                  <span className="text-gray-600 font-normal">no armazém</span>{' '}
                                  <span className="font-mono font-semibold">{armazemDestino.codigo}</span>
                                  <span className="text-gray-500 text-xs block sm:inline sm:ml-1">
                                    ({armazemDestino.codigo}, {armazemDestino.codigo}.FERR)
                                  </span>
                                </>
                              )}
                              {isFluxoRecebimentoMercadoria && armazemOrigem?.codigo && (
                                <>
                                  {' '}
                                  <span className="text-gray-600 font-normal">no armazém</span>{' '}
                                  <span className="font-mono font-semibold">{armazemOrigem.codigo}</span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 sm:justify-end">
                          <button
                            type="button"
                            onClick={fecharPrepararItem}
                            className="px-4 py-2.5 border border-gray-300 rounded-xl bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 order-2 sm:order-1"
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            disabled={submitting === item.id}
                            className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2 text-sm font-semibold shadow-sm order-1 sm:order-2 min-w-[200px]"
                          >
                            {submitting === item.id ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                A guardar…
                              </>
                            ) : (
                              <>
                                <FaCheck /> Confirmar preparação
                              </>
                            )}
                          </button>
                        </div>
                      </section>
                    </form>
                  )}
                </div>
              );
            })}
          </div>

          {fasePreparacaoAberta && podeAgirSeparacao && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              {todosPreparados ? (
                <>
                  <p className="text-gray-700 mb-3">
                    {isFluxoRecebimentoMercadoria
                      ? 'Todos os itens foram confirmados. Clique abaixo para concluir a preparação do recebimento.'
                      : 'Todos os itens foram preparados. Clique abaixo para concluir a separação da requisição.'}
                  </p>
                  <button
                    type="button"
                    onClick={handleCompletarSeparacao}
                    className="px-4 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-2 font-medium"
                  >
                    <FaCheck /> {isFluxoRecebimentoMercadoria ? 'Concluir preparação do recebimento' : 'Concluir preparação da requisição'}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-gray-700 mb-2">
                    {isFluxoRecebimentoMercadoria
                      ? 'Confirme todos os itens (use 0 quando não tiver recebido) para poder concluir.'
                      : 'Confirme a preparação de todos os itens (use 0 quando não tiver o item) para poder concluir.'}
                  </p>
                  {itensPorConfirmar.length > 0 && (
                    <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-sm">
                      <strong>Faltam confirmar {itensPorConfirmar.length} {itensPorConfirmar.length === 1 ? 'item' : 'itens'}:</strong>{' '}
                      {itensPorConfirmar.map(it => it.item_codigo || it.item_id).join(', ')}.
                      Clique em <strong>«Preparar item»</strong> em cada um e guarde a quantidade (pode ser 0 ou parcial).
                    </p>
                  )}
                  <button
                    type="button"
                    disabled
                    className="px-4 py-3 bg-gray-300 text-gray-500 rounded-lg cursor-not-allowed flex items-center gap-2 font-medium"
                    title="Confirme todos os itens primeiro"
                  >
                    <FaCheck /> {isFluxoRecebimentoMercadoria ? 'Concluir preparação do recebimento' : 'Concluir preparação da requisição'}
                  </button>
                </>
              )}
            </div>
          )}

          {isSeparado && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <p className="text-green-600 font-medium">✓ Requisição totalmente preparada (Separadas)</p>
            </div>
          )}

          {requisicao.status === 'cancelada' && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <p className="text-red-600 font-medium">Requisição cancelada</p>
            </div>
          )}
        </div>

        {reporteModal.open && (
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
            aria-modal="true"
            role="dialog"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeReporteModal();
            }}
          >
            <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl">
              <div className="flex items-center justify-between p-4 border-b">
                <h3 className="text-base sm:text-lg font-semibold text-gray-900">
                  {reporteModal.title || 'Reporte'}
                </h3>
                <button
                  type="button"
                  onClick={closeReporteModal}
                  className="px-3 py-1 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
                >
                  Fechar
                </button>
              </div>
              <div className="p-4 overflow-auto max-h-[60vh]">
                {reporteModal.loading ? (
                  <p className="text-sm text-gray-600">A carregar tabela...</p>
                ) : (
                  <>
                    <div className="text-xs text-gray-500 mb-2">
                      {reporteModal.rows.length > 200 ? `A mostrar 200 de ${reporteModal.rows.length} linhas.` : null}
                    </div>
                    <div className="overflow-auto">
                      <table className="min-w-full text-xs border-collapse">
                        <thead>
                          <tr>
                            {(reporteModal.columns || []).map((c) => (
                              <th key={c} className="sticky top-0 z-10 bg-gray-100 border border-gray-300 px-2 py-1 text-gray-800">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(reporteModal.rows || []).slice(0, 200).map((r, idx) => (
                            <tr key={idx}>
                              {(reporteModal.columns || []).map((c) => (
                                <td key={c} className="border border-gray-200 px-2 py-1 text-gray-900">
                                  {String(r?.[c] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
              <div className="p-4 border-t flex justify-end gap-3">
                <button
                  type="button"
                  onClick={copyReporteTable}
                  disabled={reporteModal.loading}
                  className="px-4 py-2 rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Copiar tabela
                </button>
                <button
                  type="button"
                  onClick={downloadReporteXlsx}
                  disabled={reporteModal.loading}
                  className="px-4 py-2 rounded-lg bg-[#0915FF] text-white hover:bg-[#070FCC] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Baixar XLSX
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
        )}
      </div>
    </div>
  );
};

export default PrepararRequisicao;
