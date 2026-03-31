import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import jsPDF from 'jspdf';
import { desenharPaginaNotaEntregaDigi, NOTA_DEVOLUCAO_PDF_OPTS } from '../utils/notaEntregaPdf';
import { operadorPodeDocsELogisticaAposSeparacao } from '../utils/roles';
import {
  FaArrowRight,
  FaBoxOpen,
  FaCheck,
  FaEdit,
  FaFileImport,
  FaPlus,
  FaSearch,
  FaTrash
} from 'react-icons/fa';
import {
  formatCriadorRequisicao,
  preparacaoReservadaOutroUtilizador,
  isRequisicaoDoUtilizadorAtual
} from '../utils/requisicaoCriador';
import { getRequisicoesArmazemOrigemIds } from '../utils/requisicoesArmazemOrigem';
import {
  podeFinalizarDevolucaoTransferenciasPendentes as devolucaoPodeFinalizarTransferenciasPendentes,
  mensagemDocumentosEmFaltaFinalizarDevolucao
} from '../utils/podeFinalizarDevolucaoTransferenciasPendentes';

const normalize = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const ListarDevolucoes = () => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();

  const [devolucoes, setDevolucoes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [armazensDestino, setArmazensDestino] = useState([]);
  const [apeadoArmazens, setApeadoArmazens] = useState([]);
  const [apeadoDestinoByReqId, setApeadoDestinoByReqId] = useState({});
  const [pendenteLocByReqItemId, setPendenteLocByReqItemId] = useState({});
  // Para o ciclo de devolução na card:
  // clicar "Receber" apenas ativa a UI para mostrar o botão "GERAR TRA" na mesma card.
  const RECEBER_ATIVO_IDS_KEY = 'devolucao_receber_ativo_ids_v1';
  const [receberAtivoIds, setReceberAtivoIds] = useState(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(RECEBER_ATIVO_IDS_KEY) : null;
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.map((x) => Number(x)).filter(Number.isFinite));
    } catch (_) {
      return new Set();
    }
  });

  const [searchTerm, setSearchTerm] = useState('');
  const [somenteMinhas, setSomenteMinhas] = useState(false);

  const params = new URLSearchParams(location.search || '');
  const statusParam = params.get('status') || '';

  const showStatusBoard = !statusParam;
  // statusFilter pode ser: 'esperando' | 'EM EXPEDICAO' | 'APEADOS' | 'FINALIZADO'
  const statusFilter = statusParam;

  const canEntregar =
    user && ['admin', 'operador', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  const canPrepare =
    user && ['admin', 'operador', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  const canDelete =
    user && ['admin', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);

  const canDeleteDevolucao = (reqObj) => {
    if (!canDelete) return false;
    if (!reqObj) return false;
    const status = String(reqObj?.status || '');
    const precisaAdmin = ['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue'].includes(status);
    return !precisaAdmin || user?.role === 'admin';
  };

  const canCreateOrEdit =
    user && ['admin', 'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);

  const semArmazemOrigemAtribuido = Boolean(
    user && user.role !== 'admin' && getRequisicoesArmazemOrigemIds(user).length === 0
  );
  const podeCriarOuImportarRequisicao = canCreateOrEdit && !semArmazemOrigemAtribuido;

  const canDocsELogisticaPosSeparacao = Boolean(
    canPrepare && operadorPodeDocsELogisticaAposSeparacao(user?.role)
  );

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, req: null });
  const contextMenuRef = useRef(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [reporteModal, setReporteModal] = useState({
    open: false,
    title: '',
    kind: 'reporte',
    mode: 'single',
    reqId: null,
    ids: [],
    columns: [],
    rows: []
  });
  const [reporteLoading, setReporteLoading] = useState(false);
  const [traNumeroByReqId, setTraNumeroByReqId] = useState({});
  const [savingTraReqId, setSavingTraReqId] = useState(null);
  const [traApeadosNumeroByReqId, setTraApeadosNumeroByReqId] = useState({});
  const [savingTraApeadosReqId, setSavingTraApeadosReqId] = useState(null);

  const fetchDevolucoes = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');

      const p = new URLSearchParams();
      p.append('devolucoes', '1');

      // "Esperando entrega" agrega client-side (pendente + EM SEPARACAO + separado)
      // Para isso não passamos status=esperando ao backend.
      if (statusFilter && statusFilter !== 'esperando') p.append('status', statusFilter);
      if (somenteMinhas) p.append('minhas', '1');

      const response = await fetch(`/api/requisicoes?${p.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        setToast({ type: 'error', message: 'Erro ao carregar devoluções' });
        return;
      }

      const data = await response.json();
      setDevolucoes(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setToast({ type: 'error', message: 'Erro ao carregar devoluções' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDevolucoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, somenteMinhas]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    };
    if (contextMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenu.visible]);

  useLayoutEffect(() => {
    if (!contextMenu.visible) return;
    const el = contextMenuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const padding = 8;

    let x = contextMenu.x;
    let y = contextMenu.y;

    const maxX = window.innerWidth - rect.width - padding;
    const maxY = window.innerHeight - rect.height - padding;

    x = Math.max(padding, Math.min(x, maxX));
    y = Math.max(padding, Math.min(y, maxY));

    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu((prev) => ({ ...prev, x, y }));
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  // Armazéns de destino do tipo APEADO (para gerar a TRA APEADOS)
  useEffect(() => {
    const loadApeadoArmazens = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/armazens?ativo=true&destino_requisicao=1', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) return;
        const data = await response.json();
        const todos = Array.isArray(data) ? data : [];
        const list = todos
          ? todos.filter((a) => String(a?.tipo || '').trim().toLowerCase() === 'apeado')
          : [];
        setArmazensDestino(todos);
        setApeadoArmazens(list);
      } catch (_) {
        // Sem bloquear a listagem de devoluções
      }
    };
    loadApeadoArmazens();
  }, []);

  // Persistir a UI "Receber -> GERAR TRA" entre recarregamentos.
  useEffect(() => {
    try {
      window.localStorage.setItem(RECEBER_ATIVO_IDS_KEY, JSON.stringify(Array.from(receberAtivoIds)));
    } catch (_) {}
  }, [receberAtivoIds]);

  // Ao obter dados do backend, se a TRA já estiver gerada ou o estado não for mais EM EXPEDICAO,
  // limpamos o passo local.
  useEffect(() => {
    if (!receberAtivoIds || receberAtivoIds.size === 0) return;
    setReceberAtivoIds((prev) => {
      if (!prev || prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const r of devolucoes) {
        if (!r) continue;
        const id = Number(r.id);
        if (!Number.isFinite(id)) continue;
        if (r.devolucao_tra_gerada_em || r.status !== 'EM EXPEDICAO') {
          if (next.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devolucoes]);

  const countsByStatus = useMemo(() => {
    const acc = {};
    for (const r of devolucoes) {
      const s = r.status || 'pendente';
      acc[s] = (acc[s] || 0) + 1;
    }
    acc.esperando = (acc.pendente || 0) + (acc['EM SEPARACAO'] || 0) + (acc.separado || 0);
    return acc;
  }, [devolucoes]);

  const filtered = useMemo(() => {
    const cycleStatuses =
      statusFilter === 'esperando'
        ? ['pendente', 'EM SEPARACAO', 'separado']
        : statusFilter
          ? [statusFilter]
          : null;

    const base = cycleStatuses ? devolucoes.filter((r) => cycleStatuses.includes(r.status)) : devolucoes;

    if (!searchTerm) return base;
    const raw = normalize(searchTerm).trim();
    if (!raw) return base;

    return base.filter((r) => {
      const created = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '';
      const fields = [
        String(r.id || ''),
        r.armazem_descricao,
        r.armazem_origem_descricao,
        String(r.status || ''),
        created
      ];
      return fields.some((f) => normalize(f).includes(raw));
    });
  }, [devolucoes, searchTerm, statusFilter]);

  const devolucoesOrdenadas = useMemo(() => {
    const list = [...filtered];
    // FIFO: quando há estado selecionado, mostramos mais antigas primeiro.
    const hasStatus = Boolean(statusFilter);
    list.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return hasStatus ? ta - tb : tb - ta;
    });
    return list;
  }, [filtered, statusFilter]);

  const getStatusBadge = (status) => {
    if (['pendente', 'EM SEPARACAO', 'separado'].includes(status)) return 'bg-yellow-100 text-yellow-800';
    if (status === 'EM EXPEDICAO') return 'bg-blue-100 text-blue-800';
    if (status === 'APEADOS') return 'bg-purple-100 text-purple-800';
    if (status === 'Entregue') return 'bg-emerald-100 text-emerald-800';
    if (status === 'FINALIZADO') return 'bg-slate-200 text-slate-900';
    return 'bg-gray-100 text-gray-800';
  };

  const getStatusLabel = (status) => {
    if (['pendente', 'EM SEPARACAO', 'separado'].includes(status)) return 'Esperando entrega';
    if (status === 'EM EXPEDICAO') return 'Em processo';
    if (status === 'APEADOS') return 'APEADOS';
    if (status === 'Entregue') return 'Finalizado';
    if (status === 'FINALIZADO') return 'Finalizado';
    return status || '';
  };

  const setStatusInUrl = (nextStatus) => {
    const p = new URLSearchParams(location.search || '');
    if (nextStatus) p.set('status', nextStatus);
    else p.delete('status');
    navigate({ pathname: '/devolucoes', search: p.toString() ? `?${p.toString()}` : '' });
  };

  const statusCards = [
    { key: 'esperando', label: 'Esperando entrega', color: 'bg-yellow-50 border-yellow-200 text-yellow-800' },
    { key: 'EM EXPEDICAO', label: 'Em processo', color: 'bg-blue-50 border-blue-200 text-blue-800' },
    { key: 'APEADOS', label: 'Transferências pendentes', color: 'bg-purple-50 border-purple-200 text-purple-800' },
    { key: 'FINALIZADO', label: 'Finalizado', color: 'bg-slate-50 border-slate-300 text-slate-800' }
  ];

  const handleDelete = async (reqId) => {
    const req = devolucoes.find((x) => Number(x.id) === Number(reqId));
    if (!canDeleteDevolucao(req)) {
      setToast({ type: 'error', message: 'Sem permissão para excluir esta devolução.' });
      return;
    }
    try {
      const ok = await confirm({
        title: 'Excluir devolução',
        message: 'Confirma a exclusão desta devolução? Esta ação não pode ser desfeita.',
        variant: 'danger',
        confirmLabel: 'Excluir'
      });
      if (!ok) return;

      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao excluir devolução');
      }

      await fetchDevolucoes();
      setToast({ type: 'success', message: 'Devolução excluída.' });
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: error.message || 'Erro ao excluir devolução' });
    }
  };

  const handleConfirmarArtigosDevolucao = async (reqId) => {
    try {
      const ok = await confirm({
        title: 'Confirmar artigos',
        message: 'Confirmar que os artigos estão preparados e avançar o ciclo desta devolução?',
        confirmLabel: 'Confirmar',
        variant: 'warning'
      });
      if (!ok) return;

      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };

      // Mesma sequência do fluxo de preparação, mas sem abrir a página de edição.
      // 1) completa separação: EM SEPARACAO/PENDENTE -> separado
      let resp = await fetch(`/api/requisicoes/${reqId}/completar-separacao`, {
        method: 'PATCH',
        headers
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao concluir separação');
      }

      // 2) confirma separação: marca separacao_confirmada=true
      resp = await fetch(`/api/requisicoes/${reqId}/confirmar-separacao`, {
        method: 'PATCH',
        headers
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao confirmar separação');
      }

      // 3) marca em expedição: separado -> EM EXPEDICAO (no caso de devolução, depois entra no ciclo)
      resp = await fetch(`/api/requisicoes/${reqId}/marcar-em-expedicao`, {
        method: 'PATCH',
        headers
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao marcar em expedição');
      }

      await fetchDevolucoes();
      setToast({ type: 'success', message: 'Devolução avançada para Em processo.' });
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: error.message || 'Erro ao confirmar artigos' });
    }
  };

  const downloadExport = async (urlPath, filename, successMsg) => {
    const token = localStorage.getItem('token');
    const response = await fetch(urlPath, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      let msg = 'Falha ao exportar';
      try {
        const data = await response.json();
        msg = data.error || data.message || msg;
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

  const handleExportTRADevolucao = async (reqId, opts = {}) => {
    try {
      if (!reqId) throw new Error('Requisição inválida');

      const isRedownload = Boolean(opts.redownload);
      if (isRedownload) {
        const ok = await confirm({
          title: 'Baixar DEV',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        });
        if (!ok) return;
      } else {
        const ok = await confirm({
          title: 'Receber devolução',
          message: 'Deseja gerar o DEV da devolução (entrada no central em localização de recebimento)?',
          confirmLabel: 'Continuar'
        });
        if (!ok) return;
      }

      await downloadExport(
        `/api/requisicoes/${reqId}/export-tra`,
        `DEV_devolucao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        isRedownload ? 'DEV baixado novamente.' : 'DEV da devolução gerado com sucesso.'
      );
      if (!isRedownload) {
        setReceberAtivoIds((prev) => {
          const next = new Set(prev);
          next.delete(reqId);
          return next;
        });
      }
      await fetchDevolucoes();
    } catch (error) {
      console.error('Erro ao exportar DEV de devolução:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar DEV de devolução' });
    }
  };

  const handleTraNumeroChange = (reqId, value) => {
    setTraNumeroByReqId((prev) => ({ ...prev, [reqId]: value }));
  };

  const handleGuardarTraNumero = async (req) => {
    const reqId = Number(req?.id);
    if (!Number.isFinite(reqId)) return;
    const valor = String(traNumeroByReqId[reqId] ?? req?.tra_numero ?? '').trim();
    if (!valor) {
      setToast({ type: 'error', message: 'Número da TRA é obrigatório.' });
      return;
    }
    try {
      setSavingTraReqId(reqId);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/tra-numero`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tra_numero: valor })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao guardar número da TRA');
      }
      await fetchDevolucoes();
      setToast({ type: 'success', message: `Nº TRA guardado: ${valor}` });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao guardar número da TRA' });
    } finally {
      setSavingTraReqId(null);
    }
  };

  const handleExportTRADevolucaoApeados = async (reqId, destinoApeadoId, opts = {}) => {
    try {
      if (!reqId) throw new Error('Requisição inválida');
      const isRedownload = Boolean(opts.redownload);
      if (!isRedownload && !destinoApeadoId) throw new Error('Selecione um armazém APEADO como destino.');

      if (isRedownload) {
        const ok = await confirm({
          title: 'Baixar TRA APEADOS',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        });
        if (!ok) return;
      } else {
        const ok = await confirm({
          title: 'Gerar TRA APEADOS',
          message:
            'Deseja gerar a TRA para transferir apenas os artigos marcados como APEADOS para o armazém APEADO selecionado?',
          confirmLabel: 'Continuar'
        });
        if (!ok) return;
      }

      const p = new URLSearchParams();
      if (destinoApeadoId) p.set('destino_apeado_id', String(destinoApeadoId));
      const qs = p.toString();
      await downloadExport(
        `/api/requisicoes/${reqId}/export-tra-apeados${qs ? `?${qs}` : ''}`,
        `TRA_apeados_devolucao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        isRedownload ? 'TRA APEADOS baixada novamente.' : 'TRA APEADOS gerada com sucesso.'
      );
      await fetchDevolucoes();
    } catch (error) {
      console.error('Erro ao exportar TRA APEADOS:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRA APEADOS' });
    }
  };

  const handleTraApeadosNumeroChange = (reqId, value) => {
    setTraApeadosNumeroByReqId((prev) => ({ ...prev, [reqId]: value }));
  };

  const handleGuardarTraApeadosNumero = async (req) => {
    const reqId = Number(req?.id);
    if (!Number.isFinite(reqId)) return;
    const valor = String(traApeadosNumeroByReqId[reqId] ?? req?.devolucao_tra_apeados_numero ?? '').trim();
    if (!valor) {
      setToast({ type: 'error', message: 'Número da TRA APEADOS é obrigatório.' });
      return;
    }
    try {
      setSavingTraApeadosReqId(reqId);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/devolucao-tra-apeados-numero`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ devolucao_tra_apeados_numero: valor })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao guardar número da TRA APEADOS');
      }
      await fetchDevolucoes();
      setToast({ type: 'success', message: `Nº TRA APEADOS guardado: ${valor}` });
      navigate('/movimentos');
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao guardar número da TRA APEADOS' });
    } finally {
      setSavingTraApeadosReqId(null);
    }
  };

  const handleExportTRFLPendenteArmazenagem = async (reqId, itemLocalizacoes, opts = {}) => {
    try {
      if (!reqId) throw new Error('Requisição inválida');
      const isRedownload = Boolean(opts.redownload);
      const mapKeys = Object.keys(itemLocalizacoes || {});
      if (mapKeys.length === 0) {
        throw new Error('Selecione a localização de destino por artigo.');
      }
      const hasEmpty = mapKeys.some((k) => !String(itemLocalizacoes[k] || '').trim());
      if (hasEmpty) throw new Error('Todos os artigos pendentes precisam ter localização selecionada.');

      if (isRedownload) {
        const ok = await confirm({
          title: 'Baixar TRFL pendente de armazenagem',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        });
        if (!ok) return;
      } else {
        const ok = await confirm({
          title: 'Gerar TRFL pendente de armazenagem',
          message: 'Deseja gerar a TRFL para os itens remanescentes com as localizações por artigo selecionadas?',
          confirmLabel: 'Continuar'
        });
        if (!ok) return;
      }

      const p = new URLSearchParams();
      p.set('item_localizacoes', JSON.stringify(itemLocalizacoes));
      const qs = p.toString();
      await downloadExport(
        `/api/requisicoes/${reqId}/export-trfl-pendente-armazenagem${qs ? `?${qs}` : ''}`,
        `TRFL_pendente_armazenagem_devolucao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        isRedownload
          ? 'TRFL de pendente de armazenagem baixada novamente.'
          : 'TRFL de pendente de armazenagem gerada com sucesso.'
      );
      await fetchDevolucoes();
    } catch (error) {
      console.error('Erro ao exportar TRFL pendente de armazenagem:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRFL pendente de armazenagem' });
    }
  };

  const handleEntregarDevolucao = async (reqId) => {
    try {
      const ok = await confirm({
        title: 'Entregar devolução',
        message: 'Tem certeza que deseja continuar? Isso vai alterar o status para Entregue.',
        confirmLabel: 'Sim, entregar',
        variant: 'warning'
      });
      if (!ok) return;

      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/marcar-entregue`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao entregar');
      }

      await fetchDevolucoes();
      setToast({ type: 'success', message: 'Devolução marcada como Entregue.' });
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: error.message || 'Erro ao entregar devolução' });
    }
  };

  const handleFinalizarDevolucao = async (reqId) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/finalizar`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao finalizar devolução');
      }

      setToast({ type: 'success', message: 'Devolução finalizada.' });
      await fetchDevolucoes();
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: error.message || 'Erro ao finalizar devolução' });
    }
  };

  const computeDevolucaoCardDerived = (r) => {
    const itensCount = (r.itens || []).length || 0;
    const apeadosItens = (r.itens || []).filter((it) => {
      const q = Number(it?.quantidade_apeados ?? 0) || 0;
      return q > 0;
    });
    const pendenteArmazenagemItens = (r.itens || [])
      .map((it) => {
        const total = Number(it?.quantidade_preparada ?? it?.quantidade ?? 0) || 0;
        const apeados = Number(it?.quantidade_apeados ?? 0) || 0;
        const pendente = Math.max(0, total - apeados);
        return pendente > 0 ? { ...it, quantidade_pendente_armazenagem: pendente } : null;
      })
      .filter(Boolean);
    const reqIdNum = Number(r.id);
    const selectedApeadoId = apeadoDestinoByReqId[reqIdNum] ?? (apeadoArmazens[0]?.id ?? '');
    const podeFinalizarTransferenciasPendentes = devolucaoPodeFinalizarTransferenciasPendentes(r);
    const armazemCentralDestino =
      (armazensDestino || []).find((a) => Number(a?.id) === Number(r.armazem_id)) || null;
    const locsCentralAll = Array.isArray(armazemCentralDestino?.localizacoes)
      ? armazemCentralDestino.localizacoes
          .map((l) => ({
            code: String(l?.localizacao || '').trim(),
            tipo: String(l?.tipo_localizacao || '').toLowerCase()
          }))
          .filter((l) => l.code)
      : [];
    const locsCentralPreferidas = locsCentralAll.filter((l) => l.tipo !== 'recebimento');
    const locsCentralDestino = (locsCentralPreferidas.length > 0 ? locsCentralPreferidas : locsCentralAll)
      .map((l) => l.code)
      .filter((v, i, arr) => arr.indexOf(v) === i);
    const pendenteItemLocMap = Object.fromEntries(
      pendenteArmazenagemItens.map((it) => {
        const mapKey = `${reqIdNum}:${it.id}`;
        const val = pendenteLocByReqItemId[mapKey] ?? (locsCentralDestino[0] || '');
        return [String(it.id), val];
      })
    );
    const todosPendentesComLoc = pendenteArmazenagemItens.every((it) => {
      const v = pendenteItemLocMap[String(it.id)];
      return Boolean(String(v || '').trim());
    });
    return {
      itensCount,
      apeadosItens,
      pendenteArmazenagemItens,
      reqIdNum,
      selectedApeadoId,
      podeFinalizarTransferenciasPendentes,
      armazemCentralDestino,
      locsCentralDestino,
      pendenteItemLocMap,
      todosPendentesComLoc
    };
  };

  const fetchRequisicaoDetalhe = async (reqId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/requisicoes/${reqId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  };

  const desenharAssinaturasRodape = (doc) => {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    const marginX = 60;
    const bottomMargin = 60;
    const blockHeight = 70;
    const topY = pageHeight - bottomMargin - blockHeight;

    const leftX1 = marginX;
    const leftX2 = pageWidth / 2 - 20;
    const rightX1 = pageWidth / 2 + 20;
    const rightX2 = pageWidth - marginX;

    doc.setFontSize(10);
    doc.text('Assinatura do Armazém', (leftX1 + leftX2) / 2, topY, { align: 'center' });
    doc.line(leftX1, topY + 34, leftX2, topY + 34);
    doc.text('Nome / assinatura', (leftX1 + leftX2) / 2, topY + 52, { align: 'center' });

    doc.text('Assinatura do Recebedor', (rightX1 + rightX2) / 2, topY, { align: 'center' });
    doc.line(rightX1, topY + 34, rightX2, topY + 34);
    doc.text('Nome / assinatura', (rightX1 + rightX2) / 2, topY + 52, { align: 'center' });
  };

  const gerarPdfEntrega = (reqs) => {
    const arr = Array.isArray(reqs) ? reqs : [];
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageHeight = doc.internal.pageSize.getHeight();

    arr.forEach((req, idx) => {
      desenharPaginaNotaEntregaDigi(doc, req, {
        isFirstPage: idx === 0,
        dataRef: today
      });
    });

    const sigTop = pageHeight - 60 - 70;
    const lastY = doc.lastAutoTable?.finalY ?? 0;
    if (lastY + 30 > sigTop) {
      doc.addPage();
    }
    desenharAssinaturasRodape(doc);

    const filename =
      arr.length === 1
        ? `NOTA_ENTREGA_${arr[0]?.id || ''}_${dateStr}.pdf`
        : `NOTA_ENTREGA_multi_${dateStr}.pdf`;

    doc.save(filename);
  };

  const gerarPdfNotaDevolucaoReceber = (req) => {
    if (!req) throw new Error('Requisição inválida');
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageHeight = doc.internal.pageSize.getHeight();

    desenharPaginaNotaEntregaDigi(doc, req, {
      isFirstPage: true,
      dataRef: today,
      ...NOTA_DEVOLUCAO_PDF_OPTS
    });

    const sigTop = pageHeight - 60 - 70;
    const lastY = doc.lastAutoTable?.finalY ?? 0;
    if (lastY + 30 > sigTop) {
      doc.addPage();
    }
    desenharAssinaturasRodape(doc);

    doc.save(`NOTA_DEVOLUCAO_${req.id ?? ''}_${dateStr}.pdf`);
  };

  const handleReceberDevolucaoComPdf = async (r, bloqueadoPreparacao) => {
    const reqId = r?.id;
    if (!reqId || bloqueadoPreparacao) return;
    try {
      const detalhe = await fetchRequisicaoDetalhe(reqId);
      gerarPdfNotaDevolucaoReceber(detalhe || r);
      setToast({ type: 'success', message: 'Nota de devolução gerada.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao gerar nota de devolução.' });
    } finally {
      setReceberAtivoIds((prev) => {
        const next = new Set(prev);
        next.add(reqId);
        return next;
      });
    }
  };

  const baixarPdfEntregaMultiRespeitandoDestino = (reqs) => {
    const arr = (Array.isArray(reqs) ? reqs : []).filter(Boolean);
    if (arr.length === 0) return;

    const destinos = new Set(arr.map((r) => String(r.armazem_id ?? r.armazem_destino_id ?? r.armazem_descricao ?? '')));
    if (destinos.size <= 1) {
      gerarPdfEntrega(arr);
      return;
    }

    for (const r of arr) {
      gerarPdfEntrega([r]);
    }
  };

  const handleBaixarPdfEntrega = async (req) => {
    const reqId = req?.id;
    try {
      if (!reqId) throw new Error('Requisição inválida');
      if (!['Entregue', 'FINALIZADO'].includes(req.status)) {
        throw new Error('O comprovativo de entrega só está disponível após a devolução estar Entregue.');
      }
      const ok = await confirm({
        title: 'Baixar comprovativo de entrega',
        message: 'Deseja baixar novamente?',
        confirmLabel: 'Baixar novamente',
        variant: 'warning'
      });
      if (!ok) return;

      const detalhe = await fetchRequisicaoDetalhe(reqId);
      gerarPdfEntrega([detalhe || req]);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao baixar comprovativo de entrega' });
    }
  };

  const handleBaixarPdfEntregaMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map((x) => parseInt(x, 10)).filter(Boolean);
    const byId = new Map((devolucoes || []).map((r) => [r.id, r]));
    const elegiveis = uniqueIds.filter((id) => ['Entregue', 'FINALIZADO'].includes(byId.get(id)?.status));
    if (elegiveis.length === 0) {
      setToast({ type: 'error', message: 'Selecione devoluções Entregues/Finalizadas para baixar o comprovativo.' });
      return;
    }
    try {
      const reqs = [];
      for (const id of elegiveis) {
        // eslint-disable-next-line no-await-in-loop
        const detalhe = await fetchRequisicaoDetalhe(id);
        reqs.push(detalhe || byId.get(id));
      }

      const arr = reqs.filter(Boolean);
      const destinos = new Set(arr.map((r) => String(r.armazem_id ?? r.armazem_destino_id ?? r.armazem_descricao ?? '')));
      const msgDocs =
        destinos.size <= 1
          ? `Será gerado 1 PDF com ${arr.length} devolução(ões) (mesmo armazém destino).`
          : `Os armazéns destino são diferentes. Serão gerados ${arr.length} PDFs separados (1 por devolução).`;

      const ok = await confirm({
        title: 'Baixar comprovativo (múltiplas)',
        message: `Deseja baixar novamente? ${msgDocs}`,
        confirmLabel: 'Baixar novamente',
        variant: 'warning'
      });
      if (!ok) return;

      baixarPdfEntregaMultiRespeitandoDestino(reqs);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao baixar comprovativo' });
    }
  };

  const getActionTargetIds = (req) => {
    if (selectedIds.length > 0 && selectedIds.includes(req.id)) {
      return selectedIds;
    }
    return [req.id];
  };

  const getActionTargetReqs = (req) => {
    const ids = getActionTargetIds(req || {});
    const byId = new Map((devolucoes || []).map((r) => [r.id, r]));
    const reqs = ids.map((id) => byId.get(id)).filter(Boolean);
    return { ids, reqs, complete: reqs.length === ids.length };
  };

  const handleToggleSelect = (id, checked) => {
    setSelectedIds((prev) => {
      let next;
      if (checked) {
        next = [...new Set([...prev, id])];
      } else {
        next = prev.filter((x) => x !== id);
      }
      setSelectionMode(next.length > 0);
      return next;
    });
  };

  const handleContextMenu = (e, req) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      req
    });
  };

  const handleExportMultiReporte = async (idsArg) => {
    const ids = Array.from(new Set(idsArg || selectedIds)).map((x) => parseInt(x, 10)).filter(Boolean);
    if (ids.length < 2) {
      setToast({ type: 'error', message: 'Selecione pelo menos 2 devoluções para o reporte combinado.' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/reporte-dados-multi', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do reporte combinado');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Reporte (Multi: ${ids.length} devolução(ões))`,
        kind: 'reporte',
        mode: 'multi',
        reqId: null,
        ids,
        columns: data.columns || [],
        rows: data.rows || []
      });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao preparar reporte' });
    } finally {
      setReporteLoading(false);
    }
  };

  const handleExportMultiClog = async (idsArg) => {
    const ids = Array.from(new Set(idsArg || selectedIds)).map((x) => parseInt(x, 10)).filter(Boolean);
    if (ids.length < 2) {
      setToast({ type: 'error', message: 'Selecione pelo menos 2 devoluções para o Clog combinado.' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/clog-dados-multi', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do Clog combinado');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Clog (Multi: ${ids.length} devolução(ões))`,
        kind: 'clog',
        mode: 'multi',
        reqId: null,
        ids,
        columns: data.columns || [],
        rows: data.rows || []
      });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao preparar Clog' });
    } finally {
      setReporteLoading(false);
    }
  };

  const handleExportReporte = async (req) => {
    const reqId = req?.id;
    if (!reqId) {
      setToast({ type: 'error', message: 'Requisição inválida' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/reporte-dados`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do reporte');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Reporte (Devolução #${reqId})`,
        kind: 'reporte',
        mode: 'single',
        reqId,
        ids: [reqId],
        columns: data.columns || [],
        rows: data.rows || []
      });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao preparar reporte' });
    } finally {
      setReporteLoading(false);
    }
  };

  const handleExportClog = async (req) => {
    const reqId = req?.id;
    if (!reqId) {
      setToast({ type: 'error', message: 'Requisição inválida' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/clog-dados`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do Clog');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Clog (Devolução #${reqId})`,
        kind: 'clog',
        mode: 'single',
        reqId,
        ids: [reqId],
        columns: data.columns || [],
        rows: data.rows || []
      });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao preparar Clog' });
    } finally {
      setReporteLoading(false);
    }
  };

  const closeReporteModal = () => {
    setReporteModal((prev) => ({ ...prev, open: false }));
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

      const isClog = reporteModal.kind === 'clog';
      const headerLine = columns.join('\t');
      const bodyLines = reporteModal.rows.map((r) =>
        columns.map((c) => (r?.[c] ?? '').toString().replace(/\r?\n/g, ' ')).join('\t')
      );
      const tsv = isClog ? bodyLines.join('\n') : [headerLine, ...bodyLines].join('\n');

      const escapeHtml = (val) =>
        String(val ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');

      const htmlHeader = isClog
        ? ''
        : `
          <thead>
            <tr>
              ${columns
                .map(
                  (c) =>
                    `<th style="border:1px solid #000; padding:4px 6px; background:#f2f2f2; font-weight:bold; text-align:center; white-space:nowrap;">${escapeHtml(c)}</th>`
                )
                .join('')}
            </tr>
          </thead>
        `;
      const htmlTable = `
        <table style="border-collapse:collapse; font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
          ${htmlHeader}
          <tbody>
            ${reporteModal.rows
              .map((r) => {
                const isSepReporte = String(r?.Artigo ?? '').startsWith('--- Requisição #');
                const isSepClog = String(r?.['REF.'] ?? '').startsWith('--- Requisição #');
                const isSep = isSepReporte || isSepClog;
                const trStyle = isSep ? 'background:#f2f2f2; font-weight:bold;' : '';
                return `
                <tr style="${trStyle}">
                  ${columns
                    .map((c) => {
                      const v = r?.[c] ?? '';
                      const align =
                        c === 'Descrição' || c === 'DESCRIPTION' || c === 'Observações' ? 'left' : 'center';
                      return `<td style="border:1px solid #000; padding:4px 6px; text-align:${align}; vertical-align:top;">${escapeHtml(v)}</td>`;
                    })
                    .join('')}
                </tr>
              `;
              })
              .join('')}
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

      setToast({
        type: 'success',
        message:
          reporteModal.kind === 'clog'
            ? 'Tabela do Clog copiada (para colar no Outlook).'
            : 'Tabela do reporte copiada (para colar no Outlook).'
      });
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: error.message || 'Erro ao copiar tabela' });
    }
  };

  const downloadReporteXlsx = async () => {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const isClog = reporteModal.kind === 'clog';
      if (reporteModal.mode === 'single') {
        const reqId = reporteModal.reqId;
        await downloadExport(
          isClog ? `/api/requisicoes/${reqId}/export-clog` : `/api/requisicoes/${reqId}/export-reporte`,
          isClog ? `CLOG_requisicao_${reqId}_${dateStr}.xlsx` : `REPORTE_requisicao_${reqId}_${dateStr}.xlsx`,
          isClog ? 'Ficheiro Clog gerado com sucesso.' : 'Ficheiro de reporte gerado com sucesso.'
        );
      } else {
        const ids = Array.isArray(reporteModal.ids) ? reporteModal.ids : [];
        const token = localStorage.getItem('token');
        const res = await fetch(
          isClog ? '/api/requisicoes/export-clog-multi' : '/api/requisicoes/export-reporte-multi',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ids })
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Erro ao exportar ficheiro de reporte');
        }
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = isClog ? `CLOG_multi_${dateStr}.xlsx` : `REPORTE_multi_${dateStr}.xlsx`;
        a.click();
        window.URL.revokeObjectURL(url);
      }
      closeReporteModal();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao baixar ficheiro' });
    }
  };

  const handleEntregarDevolucaoMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map((x) => parseInt(x, 10)).filter(Boolean);
    const byId = new Map((devolucoes || []).map((r) => [r.id, r]));
    const elegiveis = uniqueIds.filter((id) => {
      const r = byId.get(id);
      return r?.status === 'APEADOS' && Boolean(r.devolucao_trfl_gerada_em);
    });
    if (elegiveis.length === 0) {
      setToast({
        type: 'error',
        message: 'Selecione devoluções em transferências pendentes com TRFL gerada para entregar.'
      });
      return;
    }
    try {
      const ok = await confirm({
        title: 'Entregar (múltiplas)',
        message: `Tem certeza que deseja marcar ${elegiveis.length} devolução(ões) como Entregue?`,
        confirmLabel: 'Sim, entregar',
        variant: 'warning'
      });
      if (!ok) return;

      const token = localStorage.getItem('token');
      for (const id of elegiveis) {
        const response = await fetch(`/api/requisicoes/${id}/marcar-entregue`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Erro ao entregar #${id}`);
        }
      }
      await fetchDevolucoes();
      setToast({ type: 'success', message: 'Devoluções marcadas como Entregue.' });
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: error.message || 'Erro ao entregar devoluções' });
    }
  };

  const handleFinalizarDevolucaoMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map((x) => parseInt(x, 10)).filter(Boolean);
    if (uniqueIds.length === 0) return;

    const byId = new Map((devolucoes || []).map((r) => [r.id, r]));
    const elegiveis = uniqueIds.filter((id) => {
      const r = byId.get(id);
      if (!r) return false;
      const docsOk = devolucaoPodeFinalizarTransferenciasPendentes(r);
      const traApeadosNumeroOk =
        !r.devolucao_tra_apeados_gerada_em || Boolean(String(r.devolucao_tra_apeados_numero || '').trim());
      if (r.status === 'APEADOS' && docsOk && traApeadosNumeroOk) return true;
      if (r.status === 'Entregue' && (Boolean(r.devolucao_tra_gerada_em) || Boolean(r.tra_gerada_em))) {
        return true;
      }
      return false;
    });
    const ignoradas = uniqueIds.filter((id) => !elegiveis.includes(id));

    if (elegiveis.length === 0) {
      setToast({
        type: 'error',
        message: 'Nenhuma devolução selecionada está elegível para finalizar.'
      });
      return;
    }

    try {
      const token = localStorage.getItem('token');
      let okCount = 0;
      let failCount = 0;
      for (const id of elegiveis) {
        const response = await fetch(`/api/requisicoes/${id}/finalizar`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.ok) okCount++;
        else failCount++;
      }
      await fetchDevolucoes();
      const parts = [];
      if (okCount) parts.push(`${okCount} finalizada(s)`);
      if (failCount) parts.push(`${failCount} falhou(aram)`);
      if (ignoradas.length) parts.push(`${ignoradas.length} ignorada(s)`);
      setToast({ type: 'success', message: `Finalização concluída: ${parts.join(', ')}.` });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao finalizar devoluções' });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto"></div>
          <p className="mt-4 text-gray-600">Carregando devoluções...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

        {semArmazemOrigemAtribuido && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <strong>Sem armazéns atribuídos.</strong> Não pode ver nem trabalhar com devoluções até um
            administrador associar pelo menos um armazém de origem ao seu utilizador.
          </div>
        )}

        {/* Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Devoluções</h1>
            <p className="text-gray-600">
              {showStatusBoard
                ? 'Selecione um estado para abrir a lista e gerir por FIFO.'
                : `Lista de devoluções${statusFilter ? ` (${getStatusLabel(statusFilter)})` : ''}.`}
            </p>
          </div>

          {podeCriarOuImportarRequisicao && showStatusBoard && (
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={() => navigate('/requisicoes/importar')}
                className="inline-flex items-center gap-2 px-4 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors text-sm"
              >
                <FaFileImport /> Importar requisição
              </button>
              <button
                type="button"
                onClick={() => navigate('/requisicoes/criar?devolucao=1')}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors text-sm"
              >
                <FaPlus /> Nova Devolução
              </button>
            </div>
          )}
        </div>

        {!showStatusBoard && (
          <div className="mb-3 sm:hidden">
            <button
              type="button"
              onClick={() => {
                navigate('/devolucoes');
                setSearchTerm('');
              }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Voltar aos status
            </button>
          </div>
        )}

        {showStatusBoard && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {statusCards.map((card) => {
              const qty = countsByStatus[card.key] || 0;
              return (
                <button
                  key={card.key}
                  type="button"
                  onClick={() => setStatusInUrl(card.key)}
                  className={`text-left rounded-xl border p-5 shadow-sm hover:shadow-md transition-all ${card.color}`}
                >
                  <div className="text-sm font-semibold opacity-90">{card.label}</div>
                  <div className="mt-2 text-3xl font-bold">{qty}</div>
                </button>
              );
            })}
          </div>
        )}

        {!showStatusBoard && (
          <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
            <div className="flex flex-col gap-4">
              {podeCriarOuImportarRequisicao && selectionMode && selectedIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedIds.length >= 2 && canDocsELogisticaPosSeparacao && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleExportMultiReporte(selectedIds)}
                        className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm"
                      >
                        Reporte (combinado)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleExportMultiClog(selectedIds)}
                        className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm"
                      >
                        Clog (combinado)
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSelectionMode(false);
                      setSelectedIds([]);
                    }}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
                  >
                    Limpar seleção
                  </button>
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1 relative">
                  <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Buscar por data, viatura/equipa, item, criador..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => {
                    navigate('/devolucoes');
                    setSearchTerm('');
                  }}
                  className="hidden sm:block px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Voltar aos status
                </button>
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={somenteMinhas}
                  onChange={(e) => setSomenteMinhas(e.target.checked)}
                  className="rounded border-gray-300 text-[#0915FF] focus:ring-[#0915FF]"
                />
                Apenas requisições que eu criei
              </label>
            </div>

            {devolucoesOrdenadas.length === 0 ? (
              <div className="text-gray-600 text-sm">Sem devoluções para este estado.</div>
            ) : (
              <div className="space-y-4">
                {devolucoesOrdenadas.map((r, idx) => {
                  const d = computeDevolucaoCardDerived(r);
                  const {
                    itensCount,
                    apeadosItens,
                    pendenteArmazenagemItens,
                    reqIdNum,
                    selectedApeadoId,
                    podeFinalizarTransferenciasPendentes,
                    locsCentralDestino,
                    pendenteItemLocMap,
                    todosPendentesComLoc
                  } = d;
                  const createdBr = r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR') : '';
                  const statusLabel = getStatusLabel(r.status);
                  const prepBloqueio = preparacaoReservadaOutroUtilizador(r, user);
                  const separadorNome =
                    r.separador_nome != null && String(r.separador_nome).trim() !== '' ? String(r.separador_nome).trim() : null;

                  const podePrepararAqui = canPrepare && ['pendente', 'EM SEPARACAO', 'separado'].includes(r.status);
                  const podeAbrir = Boolean(canPrepare || canEntregar);

                  return (
                    <div
                      key={r.id}
                      onContextMenu={(e) => handleContextMenu(e, r)}
                      className={`relative overflow-hidden rounded-lg border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
                        selectedIds.includes(r.id)
                          ? 'border-blue-500 bg-blue-50 shadow-md'
                          : 'border-gray-200 bg-white shadow-sm'
                      }`}
                    >
                      {statusFilter && (
                        <span className="absolute left-3 top-3 px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                          FIFO #{idx + 1}
                        </span>
                      )}

                      {(selectionMode || selectedIds.length > 0) && (
                        <input
                          type="checkbox"
                          className="absolute right-3 top-3 h-4 w-4 z-10"
                          checked={selectedIds.includes(r.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleToggleSelect(r.id, e.target.checked);
                          }}
                        />
                      )}

                      <div
                        className={`p-6 cursor-pointer hover:bg-gray-50/50 transition-colors`}
                        onClick={() => {
                          if (selectionMode || selectedIds.length > 0) {
                            const isSelected = selectedIds.includes(r.id);
                            handleToggleSelect(r.id, !isSelected);
                            return;
                          }
                          if (!podeAbrir) return;
                          if (
                            canPrepare &&
                            (r.status === 'pendente' || r.status === 'EM SEPARACAO') &&
                            prepBloqueio
                          ) {
                            setToast({
                              type: 'error',
                              message: `Esta devolução está reservada para preparação (${separadorNome || 'outro operador'}).`
                            });
                            return;
                          }
                          navigate(`/requisicoes/preparar/${r.id}`);
                        }}
                      >
                        <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2 flex-wrap">
                              <span className="text-lg font-bold text-gray-900">#{r.id}</span>
                              <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadge(r.status)}`}>
                                {statusLabel}
                              </span>

                              {isRequisicaoDoUtilizadorAtual(r, user) && (
                                <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-violet-100 text-violet-800 uppercase tracking-wide">
                                  MINHA REQUISIÇÃO
                                </span>
                              )}

                              {selectedIds.includes(r.id) && (
                                <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-800 uppercase tracking-wide">
                                  Selecionada
                                </span>
                              )}

                              {itensCount > 0 && (
                                <span className="text-xs text-gray-500">
                                  {itensCount} {itensCount === 1 ? 'item' : 'itens'}
                                </span>
                              )}
                            </div>

                            {(r.status === 'pendente' || r.status === 'EM SEPARACAO') && canPrepare && !prepBloqueio && (
                              <span className="text-xs text-[#0915FF] flex items-center gap-1">
                                <FaBoxOpen />{' '}
                                {r.status === 'EM SEPARACAO' ? 'Separação em curso — use Confirmar artigos' : 'Use o botão Preparar abaixo'}
                              </span>
                            )}

                            {(r.status === 'pendente' || r.status === 'EM SEPARACAO') && canPrepare && prepBloqueio && (
                              <span className="text-xs text-amber-700 flex items-center gap-1">
                                Em preparação por {separadorNome || 'outro operador'}
                              </span>
                            )}

                            {r.status === 'separado' && r.separacao_confirmada && r.separacao_confirmada_em && (
                              <span className="text-xs text-green-700 flex items-center gap-1">
                                <FaCheck /> Separação confirmada em{' '}
                                {new Date(r.separacao_confirmada_em).toLocaleString('pt-BR')}
                              </span>
                            )}

                            <div className="text-sm text-gray-600 space-y-1">
                              <div>
                                <strong>Origem:</strong> {r.armazem_origem_descricao || r.armazem_origem_codigo}
                              </div>
                              <div>
                                <strong>Destino:</strong> {r.armazem_descricao}
                              </div>
                              {r.localizacao && (
                                <div>
                                  <strong>Localização:</strong> {r.localizacao}
                                </div>
                              )}
                              <div>
                                <strong>Criado por:</strong> {formatCriadorRequisicao(r)}
                              </div>
                              <div>
                                <strong>Data:</strong> {createdBr}
                              </div>
                              <div>
                                <strong>Nº de DEV:</strong> {String(r.tra_numero || '').trim() || '—'}
                              </div>
                            </div>
                            {r.status === 'EM EXPEDICAO' && Boolean(r.devolucao_tra_gerada_em || r.tra_gerada_em) && (
                              <div className="mt-3 flex items-end gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                                <div className="flex flex-col">
                                  <label className="text-xs font-semibold text-gray-700 mb-1">Nº DEV</label>
                                  <input
                                    type="text"
                                    value={String(traNumeroByReqId[r.id] ?? r.tra_numero ?? '')}
                                    onChange={(e) => handleTraNumeroChange(r.id, e.target.value)}
                                    placeholder="Digite o número da DEV"
                                    disabled={savingTraReqId === r.id || String(r.tra_numero || '').trim()}
                                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-[220px] focus:ring-2 focus:ring-[#0915FF] focus:border-transparent disabled:bg-gray-100 disabled:text-gray-500"
                                  />
                                </div>
                                {!String(r.tra_numero || '').trim() && (
                                  <button
                                    type="button"
                                    onClick={() => handleGuardarTraNumero(r)}
                                    disabled={savingTraReqId === r.id}
                                    className="px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 text-sm hover:bg-indigo-50 disabled:opacity-50"
                                  >
                                    {savingTraReqId === r.id ? 'A guardar...' : 'Guardar DEV'}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2 mt-2 xl:mt-0 flex-wrap content-start" onClick={(e) => e.stopPropagation()}>
                            {podePrepararAqui &&
                              (r.status === 'pendente' || r.status === 'EM SEPARACAO' || r.status === 'separado') && (
                                <button
                                  type="button"
                                  className={`px-3 py-2 bg-green-600 text-white rounded-lg transition-colors flex items-center gap-2 ${
                                    prepBloqueio
                                      ? 'opacity-50 cursor-not-allowed hover:bg-green-600'
                                      : 'hover:bg-green-700'
                                  }`}
                                  onClick={() => {
                                    if (prepBloqueio) return;
                                    if (r.status === 'EM SEPARACAO') {
                                      handleConfirmarArtigosDevolucao(r.id);
                                      return;
                                    }
                                    navigate(`/requisicoes/preparar/${r.id}`);
                                  }}
                                  disabled={prepBloqueio}
                                >
                                  <FaBoxOpen />{' '}
                                  {r.status === 'EM SEPARACAO'
                                    ? 'Confirmar artigos'
                                    : r.status === 'separado'
                                      ? 'Ver preparação'
                                      : 'Preparar'}
                                </button>
                              )}

                            {podePrepararAqui &&
                              r.status === 'EM SEPARACAO' &&
                              canPrepare && (
                                <button
                                  type="button"
                                  className={`px-3 py-2 text-[#0915FF] hover:bg-[#0915FF] hover:text-white rounded-lg transition-colors ${
                                    prepBloqueio ? 'opacity-50 cursor-not-allowed hover:bg-[#0915FF]' : ''
                                  }`}
                                  onClick={() => {
                                    if (prepBloqueio) return;
                                    window.localStorage.setItem(
                                      'devolucao_editar_artigos_foco_v1',
                                      JSON.stringify(Number(r.id))
                                    );
                                    navigate(`/requisicoes/preparar/${r.id}`);
                                  }}
                                  disabled={prepBloqueio}
                                  title="Editar artigos"
                                >
                                  <FaEdit />
                                </button>
                              )}

                            {/* Fluxo devolução: EM EXPEDICAO */}
                            {r.status === 'EM EXPEDICAO' && canEntregar && !r.devolucao_tra_gerada_em && !receberAtivoIds.has(r.id) && (
                              <button
                                type="button"
                                onClick={() => handleReceberDevolucaoComPdf(r, prepBloqueio)}
                                className={`px-3 py-2 bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition-colors flex items-center gap-2 ${
                                  prepBloqueio
                                    ? 'opacity-50 cursor-not-allowed hover:bg-amber-600'
                                    : ''
                                }`}
                                disabled={prepBloqueio}
                              >
                                Receber <FaArrowRight size={14} />
                              </button>
                            )}

                            {r.status === 'EM EXPEDICAO' && canEntregar && !r.devolucao_tra_gerada_em && receberAtivoIds.has(r.id) && (
                              <button
                                type="button"
                                onClick={() => handleExportTRADevolucao(r.id)}
                                className={`px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors flex items-center gap-2 ${
                                  prepBloqueio
                                    ? 'opacity-50 cursor-not-allowed hover:bg-indigo-50'
                                    : ''
                                }`}
                                disabled={prepBloqueio}
                              >
                                GERAR DEV
                              </button>
                            )}

                            {r.status === 'APEADOS' && canEntregar && !!r.devolucao_tra_gerada_em && (
                              <button
                                type="button"
                                onClick={() => handleFinalizarDevolucao(r.id)}
                                className={`px-3 py-2 bg-slate-700 text-white rounded-lg transition-colors ${
                                  (prepBloqueio || !podeFinalizarTransferenciasPendentes) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-800'
                                }`}
                                disabled={prepBloqueio || !podeFinalizarTransferenciasPendentes}
                                title={
                                  prepBloqueio
                                    ? 'Reservada para separação a outro operador'
                                    : !podeFinalizarTransferenciasPendentes
                                      ? mensagemDocumentosEmFaltaFinalizarDevolucao(r) ||
                                        'Conclua os documentos em falta antes de finalizar.'
                                      : 'Marcar como Finalizado'
                                }
                              >
                                Finalizar
                              </button>
                            )}

                            {r.status === 'APEADOS' && canEntregar && !!r.devolucao_trfl_gerada_em && (
                              <button
                                type="button"
                                onClick={() => handleEntregarDevolucao(r.id)}
                                className={`px-3 py-2 bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition-colors flex items-center gap-2 ${
                                  prepBloqueio
                                    ? 'opacity-50 cursor-not-allowed hover:bg-amber-600'
                                    : ''
                                }`}
                                disabled={prepBloqueio}
                              >
                                ENTREGAR <FaArrowRight size={14} />
                              </button>
                            )}

                            {r.status === 'APEADOS' &&
                              canEntregar &&
                              !!r.devolucao_tra_gerada_em && (
                                <div className="w-full mt-4 rounded-lg border border-purple-200 bg-purple-50 p-4">
                                  <div className="text-[11px] font-semibold uppercase tracking-wide text-purple-800 mb-3">
                                    Tarefa APEADOS (gerar TRA)
                                  </div>

                                  <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                                    <div className="w-full sm:max-w-[560px]">
                                      <label className="block text-[11px] font-medium text-purple-900 mb-1.5">
                                        Destino APEADO
                                      </label>
                                      <select
                                        value={selectedApeadoId}
                                        onChange={(e) => {
                                          const next = e.target.value ? Number(e.target.value) : '';
                                          setApeadoDestinoByReqId((prev) => ({ ...prev, [reqIdNum]: next }));
                                        }}
                                        className="w-full px-3 py-2 border border-purple-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-[#0915FF]"
                                      >
                                        <option value="">
                                          Selecione um armazém APEADO
                                        </option>
                                        {apeadoArmazens.map((a) => (
                                          <option key={a.id} value={a.id}>
                                            {a.codigo || a.id}
                                          </option>
                                        ))}
                                      </select>
                                    </div>

                                    <button
                                      type="button"
                                      onClick={() => handleExportTRADevolucaoApeados(r.id, selectedApeadoId)}
                                      disabled={prepBloqueio || apeadosItens.length === 0 || !selectedApeadoId}
                                      className={`px-3 py-2 text-purple-800 hover:bg-purple-100 rounded-lg border border-purple-300 transition-colors flex items-center gap-2 whitespace-nowrap ${
                                        prepBloqueio || apeadosItens.length === 0 || !selectedApeadoId
                                          ? 'opacity-50 cursor-not-allowed hover:bg-purple-50'
                                          : ''
                                      }`}
                                      title={apeadosItens.length === 0 ? 'Nenhum item marcado como APEADOS' : 'Gerar TRA APEADOS'}
                                    >
                                      GERAR TRA APEADOS
                                    </button>
                                  </div>

                                  {apeadosItens.length > 0 ? (
                                    <div className="mt-4">
                                      {Boolean(r.devolucao_tra_apeados_gerada_em) && (
                                        <div className="mb-3 flex items-end gap-2 flex-wrap">
                                          <div className="flex flex-col">
                                            <label className="block text-[11px] font-medium text-purple-900 mb-1.5">
                                              Nº TRA APEADOS
                                            </label>
                                            <input
                                              type="text"
                                              value={String(traApeadosNumeroByReqId[r.id] ?? r.devolucao_tra_apeados_numero ?? '')}
                                              onChange={(e) => handleTraApeadosNumeroChange(r.id, e.target.value)}
                                              placeholder="Digite o número da TRA APEADOS"
                                              disabled={savingTraApeadosReqId === r.id || Boolean(String(r.devolucao_tra_apeados_numero || '').trim())}
                                              className="w-full sm:w-[280px] px-3 py-2 border border-purple-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-[#0915FF] disabled:bg-gray-100 disabled:text-gray-500"
                                            />
                                          </div>
                                          {!String(r.devolucao_tra_apeados_numero || '').trim() && (
                                            <button
                                              type="button"
                                              onClick={() => handleGuardarTraApeadosNumero(r)}
                                              disabled={savingTraApeadosReqId === r.id}
                                              className="px-3 py-2 rounded-lg border border-purple-300 text-purple-800 text-sm hover:bg-purple-100 disabled:opacity-50"
                                            >
                                              {savingTraApeadosReqId === r.id ? 'A guardar...' : 'Guardar TRA APEADOS'}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      <div className="text-[11px] font-semibold text-purple-900 mb-2">
                                        Itens APEADOS na separação
                                      </div>
                                      <div className="space-y-1.5">
                                        {apeadosItens.map((it) => (
                                          <div
                                            key={it.id}
                                            className="flex items-center justify-between gap-3 text-sm text-purple-900 leading-5"
                                          >
                                            <span className="truncate">
                                              {it.item_codigo}
                                              {it.item_descricao ? ` - ${it.item_descricao}` : ''}
                                            </span>
                                            <span className="font-semibold tabular-nums">
                                              {Number(it.quantidade_apeados) || 0}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="mt-4 text-xs text-purple-900/80">
                                      Nenhum item está marcado como APEADOS nesta devolução.
                                    </div>
                                  )}
                                </div>
                              )}

                            {r.status === 'APEADOS' &&
                              canEntregar &&
                              !!r.devolucao_tra_gerada_em && (
                                <div className="w-full mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                                  <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-3">
                                    Pendente de armazenagem (gerar TRFL)
                                  </div>

                                  <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                                    <button
                                      type="button"
                                      onClick={() => handleExportTRFLPendenteArmazenagem(r.id, pendenteItemLocMap)}
                                      disabled={prepBloqueio || pendenteArmazenagemItens.length === 0 || !todosPendentesComLoc}
                                      className={`px-3 py-2 text-amber-800 hover:bg-amber-100 rounded-lg border border-amber-300 transition-colors flex items-center gap-2 whitespace-nowrap ${
                                        prepBloqueio || pendenteArmazenagemItens.length === 0 || !todosPendentesComLoc
                                          ? 'opacity-50 cursor-not-allowed hover:bg-amber-50'
                                          : ''
                                      }`}
                                      title={pendenteArmazenagemItens.length === 0 ? 'Nenhum item pendente de armazenagem' : 'Gerar TRFL pendente de armazenagem'}
                                    >
                                      GERAR TRFL PENDENTE
                                    </button>
                                  </div>

                                  {pendenteArmazenagemItens.length > 0 ? (
                                    <div className="mt-4">
                                      <div className="text-[11px] font-semibold text-amber-900 mb-2">
                                        Itens pendentes de armazenagem
                                      </div>
                                      <div className="space-y-1.5">
                                        {pendenteArmazenagemItens.map((it) => (
                                          <div
                                            key={it.id}
                                            className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_170px_80px] gap-2 items-center text-sm text-amber-900 leading-5"
                                          >
                                            <span className="truncate">
                                              {it.item_codigo}
                                              {it.item_descricao ? ` - ${it.item_descricao}` : ''}
                                            </span>
                                            <select
                                              value={pendenteItemLocMap[String(it.id)] || ''}
                                              onChange={(e) => {
                                                const mapKey = `${reqIdNum}:${it.id}`;
                                                setPendenteLocByReqItemId((prev) => ({ ...prev, [mapKey]: e.target.value || '' }));
                                              }}
                                              className="w-full px-2 py-1.5 border border-amber-300 rounded bg-white text-xs focus:ring-2 focus:ring-[#0915FF]"
                                            >
                                              <option value="">Localização</option>
                                              {locsCentralDestino.map((loc) => (
                                                <option key={loc} value={loc}>
                                                  {loc}
                                                </option>
                                              ))}
                                            </select>
                                            <span className="font-semibold tabular-nums">
                                              {Number(it.quantidade_pendente_armazenagem) || 0}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="mt-4 text-xs text-amber-900/80">
                                      Nenhum item está pendente de armazenagem nesta devolução.
                                    </div>
                                  )}
                                </div>
                              )}

                            {r.status === 'Entregue' &&
                              canEntregar &&
                              (Boolean(r.devolucao_tra_gerada_em) || Boolean(r.tra_gerada_em)) && (
                                <button
                                  type="button"
                                  onClick={() => handleFinalizarDevolucao(r.id)}
                                  className={`px-3 py-2 bg-slate-700 text-white rounded-lg transition-colors ${
                                    prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-800'
                                  }`}
                                  disabled={prepBloqueio}
                                  title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Marcar como Finalizado'}
                                >
                                  Finalizar
                                </button>
                              )}

                            {r.status === 'pendente' && podeCriarOuImportarRequisicao && (
                              <button
                                type="button"
                                onClick={() => navigate(`/requisicoes/editar/${r.id}`)}
                                className="px-3 py-2 text-[#0915FF] hover:bg-[#0915FF] hover:text-white rounded-lg transition-colors"
                                title="Editar"
                              >
                                <FaEdit />
                              </button>
                            )}

                            {canDeleteDevolucao(r) && (
                              <button
                                type="button"
                                onClick={() => handleDelete(r.id)}
                                className="px-3 py-2 text-red-600 hover:bg-red-600 hover:text-white rounded-lg transition-colors"
                                title="Excluir"
                              >
                                <FaTrash />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Menu de contexto (clique direito) — alinhado às requisições; ações específicas do fluxo de devolução */}
        {contextMenu.visible && contextMenu.req && (
          <div
            ref={contextMenuRef}
            className="fixed z-50 bg-white border border-gray-200 rounded-md shadow-lg text-sm py-1"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="block w-full text-left px-4 py-2 hover:bg-gray-100"
              onClick={() => {
                if (preparacaoReservadaOutroUtilizador(contextMenu.req, user)) {
                  const nome =
                    contextMenu.req.separador_nome != null &&
                    String(contextMenu.req.separador_nome).trim() !== ''
                      ? String(contextMenu.req.separador_nome).trim()
                      : 'outro operador';
                  setToast({
                    type: 'error',
                    message: `Esta devolução está reservada para preparação (${nome}).`
                  });
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  return;
                }
                navigate(`/requisicoes/preparar/${contextMenu.req.id}`);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              Abrir
            </button>
            {podeCriarOuImportarRequisicao && (
              <button
                className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                onClick={() => {
                  setSelectionMode(true);
                  setSelectedIds((prev) =>
                    prev.includes(contextMenu.req.id) ? prev : [...prev, contextMenu.req.id]
                  );
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
              >
                Selecionar / multi-seleção
              </button>
            )}
            {podeCriarOuImportarRequisicao && contextMenu.req.status === 'pendente' && (
              <button
                className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                onClick={() => {
                  navigate(`/requisicoes/editar/${contextMenu.req.id}`);
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
              >
                Editar
              </button>
            )}
            {canPrepare &&
              (() => {
                const { ids, reqs, complete } = getActionTargetReqs(contextMenu.req);
                const isMulti = ids.length >= 2;
                const all = (pred) => complete && reqs.every(pred);
                const algumaPrepBloqueio = complete && reqs.some((x) => preparacaoReservadaOutroUtilizador(x, user));

                const dxSingle = !isMulti && reqs[0] ? computeDevolucaoCardDerived(reqs[0]) : null;
                const r0 = reqs[0];

                const canGerarDEV =
                  !isMulti &&
                  complete &&
                  r0 &&
                  r0.status === 'EM EXPEDICAO' &&
                  !r0.devolucao_tra_gerada_em &&
                  receberAtivoIds.has(Number(r0.id));
                const canBaixarDEV =
                  !isMulti && complete && r0 && Boolean(r0.devolucao_tra_gerada_em);

                const canGerarTraApe =
                  Boolean(canDocsELogisticaPosSeparacao) &&
                  !isMulti &&
                  complete &&
                  r0 &&
                  dxSingle &&
                  r0.status === 'APEADOS' &&
                  r0.devolucao_tra_gerada_em &&
                  !r0.devolucao_tra_apeados_gerada_em &&
                  dxSingle.apeadosItens.length > 0 &&
                  Boolean(dxSingle.selectedApeadoId);
                const canBaixarTraApe =
                  Boolean(canDocsELogisticaPosSeparacao) &&
                  !isMulti &&
                  complete &&
                  r0 &&
                  Boolean(r0.devolucao_tra_apeados_gerada_em);

                const canGerarTrflPend =
                  Boolean(canDocsELogisticaPosSeparacao) &&
                  !isMulti &&
                  complete &&
                  r0 &&
                  dxSingle &&
                  r0.status === 'APEADOS' &&
                  r0.devolucao_tra_gerada_em &&
                  !r0.devolucao_trfl_pendente_gerada_em &&
                  dxSingle.pendenteArmazenagemItens.length > 0 &&
                  dxSingle.todosPendentesComLoc;
                const canBaixarTrflPend =
                  Boolean(canDocsELogisticaPosSeparacao) &&
                  !isMulti &&
                  complete &&
                  r0 &&
                  Boolean(r0.devolucao_trfl_pendente_gerada_em);

                const canEntregarDevCtx = all(
                  (x) => x.status === 'APEADOS' && Boolean(x.devolucao_trfl_gerada_em)
                );

                const podeFin = (x) => devolucaoPodeFinalizarTransferenciasPendentes(x);
                const canFinalizarDevCtx =
                  Boolean(canDocsELogisticaPosSeparacao) &&
                  complete &&
                  all((x) => {
                    if (x.status === 'APEADOS') {
                      const numeroTraApeadosOk =
                        !x.devolucao_tra_apeados_gerada_em || Boolean(String(x.devolucao_tra_apeados_numero || '').trim());
                      return podeFin(x) && numeroTraApeadosOk;
                    }
                    if (x.status === 'Entregue') {
                      return Boolean(x.devolucao_tra_gerada_em || x.tra_gerada_em);
                    }
                    return false;
                  });

                const canGerarReporte = all(
                  (x) =>
                    x.status === 'FINALIZADO' ||
                    (x.status === 'Entregue' && Boolean(x.tra_gerada_em || x.devolucao_tra_gerada_em))
                );
                const canGerarClog = all(
                  (x) =>
                    x.status === 'FINALIZADO' ||
                    (x.status === 'Entregue' && Boolean(x.tra_gerada_em || x.devolucao_tra_gerada_em)) ||
                    (x.status === 'APEADOS' &&
                      Boolean(x.devolucao_tra_gerada_em) &&
                      Boolean(String(x.tra_numero || '').trim()))
                );

                const canBaixarComprovativo = all((x) => ['Entregue', 'FINALIZADO'].includes(x.status));

                const ctxDocBloqueado = Boolean(algumaPrepBloqueio && canDocsELogisticaPosSeparacao);
                const ctxEntregarBloqueado = Boolean(canEntregarDevCtx && algumaPrepBloqueio);
                const ctxFinalizarBloqueado = Boolean(canFinalizarDevCtx && algumaPrepBloqueio);

                return (
                  <>
                    {canDocsELogisticaPosSeparacao && (canGerarDEV || canBaixarDEV) && (
                      <button
                        type="button"
                        disabled={Boolean(canGerarDEV && algumaPrepBloqueio)}
                        className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                          canGerarDEV && algumaPrepBloqueio ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        title={canGerarDEV && algumaPrepBloqueio ? 'Reservada para preparação a outro operador' : undefined}
                        onClick={() => {
                          if (!r0) return;
                          handleExportTRADevolucao(r0.id, { redownload: canBaixarDEV && !canGerarDEV });
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        {canGerarDEV ? 'GERAR DEV' : 'Baixar DEV'}
                      </button>
                    )}

                    {canDocsELogisticaPosSeparacao && (canGerarTraApe || canBaixarTraApe) && (
                      <button
                        type="button"
                        disabled={ctxDocBloqueado && canGerarTraApe}
                        className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                          ctxDocBloqueado && canGerarTraApe ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        title={ctxDocBloqueado && canGerarTraApe ? 'Reservada para preparação a outro operador' : undefined}
                        onClick={() => {
                          if (isMulti || !r0 || !dxSingle) {
                            setToast({ type: 'error', message: 'Gere a TRA APEADOS a partir de uma única devolução.' });
                            setContextMenu((prev) => ({ ...prev, visible: false }));
                            return;
                          }
                          handleExportTRADevolucaoApeados(r0.id, dxSingle.selectedApeadoId, {
                            redownload: canBaixarTraApe && !canGerarTraApe
                          });
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        {canGerarTraApe ? 'GERAR TRA APEADOS' : 'Baixar TRA APEADOS'}
                      </button>
                    )}

                    {canDocsELogisticaPosSeparacao && (canGerarTrflPend || canBaixarTrflPend) && (
                      <button
                        type="button"
                        disabled={ctxDocBloqueado && canGerarTrflPend}
                        className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                          ctxDocBloqueado && canGerarTrflPend ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        title={ctxDocBloqueado && canGerarTrflPend ? 'Reservada para preparação a outro operador' : undefined}
                        onClick={() => {
                          if (isMulti || !r0 || !dxSingle) {
                            setToast({
                              type: 'error',
                              message: 'Gere a TRFL pendente a partir de uma única devolução.'
                            });
                            setContextMenu((prev) => ({ ...prev, visible: false }));
                            return;
                          }
                          handleExportTRFLPendenteArmazenagem(r0.id, dxSingle.pendenteItemLocMap, {
                            redownload: canBaixarTrflPend && !canGerarTrflPend
                          });
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        {canGerarTrflPend ? 'GERAR TRFL PENDENTE' : 'Baixar TRFL PENDENTE'}
                      </button>
                    )}

                    {canEntregarDevCtx && (
                      <button
                        type="button"
                        disabled={ctxEntregarBloqueado}
                        className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                          ctxEntregarBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        title={ctxEntregarBloqueado ? 'Reservada para preparação a outro operador' : undefined}
                        onClick={() => {
                          if (isMulti) handleEntregarDevolucaoMulti(ids);
                          else handleEntregarDevolucao(contextMenu.req.id);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        ENTREGAR
                      </button>
                    )}

                    {canDocsELogisticaPosSeparacao && canGerarReporte && (
                      <button
                        className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                        onClick={() => {
                          if (isMulti) handleExportMultiReporte(ids);
                          else handleExportReporte(contextMenu.req);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        Reporte
                      </button>
                    )}

                    {canDocsELogisticaPosSeparacao && canGerarClog && (
                      <button
                        className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                        onClick={() => {
                          if (isMulti) handleExportMultiClog(ids);
                          else handleExportClog(contextMenu.req);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        Clog
                      </button>
                    )}

                    {canBaixarComprovativo && (
                      <button
                        className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                        onClick={() => {
                          if (isMulti) handleBaixarPdfEntregaMulti(ids);
                          else handleBaixarPdfEntrega(contextMenu.req);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        Baixar comprovativo de entrega
                      </button>
                    )}

                    {canDocsELogisticaPosSeparacao && canFinalizarDevCtx && (
                      <button
                        type="button"
                        disabled={ctxFinalizarBloqueado}
                        className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                          ctxFinalizarBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        title={ctxFinalizarBloqueado ? 'Reservada para preparação a outro operador' : undefined}
                        onClick={() => {
                          if (isMulti) handleFinalizarDevolucaoMulti(ids);
                          else handleFinalizarDevolucao(contextMenu.req.id);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        Finalizar
                      </button>
                    )}
                  </>
                );
              })()}
            {(() => {
              const { reqs, complete } = getActionTargetReqs(contextMenu.req);
              const canDeleteCtx = complete && reqs.length > 0 && reqs.every(canDeleteDevolucao);
              if (!canDeleteCtx) return null;
              return (
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-red-50 text-red-600"
                  onClick={() => {
                    const idsDel = getActionTargetIds(contextMenu.req);
                    (async () => {
                      for (const id of idsDel) {
                        // eslint-disable-next-line no-await-in-loop
                        await handleDelete(id);
                      }
                    })();
                    setContextMenu((prev) => ({ ...prev, visible: false }));
                  }}
                >
                  Excluir devolução
                </button>
              );
            })()}
          </div>
        )}

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
                {reporteLoading ? (
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
                              <th
                                key={c}
                                className="sticky top-0 z-10 bg-gray-100 border border-gray-300 px-2 py-1 text-gray-800"
                              >
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(reporteModal.rows || []).slice(0, 200).map((row, ridx) => (
                            <tr key={ridx}>
                              {(reporteModal.columns || []).map((c) => (
                                <td key={c} className="border border-gray-200 px-2 py-1 text-gray-900">
                                  {String(row?.[c] ?? '')}
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
                  disabled={reporteLoading}
                  className="px-4 py-2 rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Copiar tabela
                </button>
                <button
                  type="button"
                  onClick={downloadReporteXlsx}
                  disabled={reporteLoading}
                  className="px-4 py-2 rounded-lg bg-[#0915FF] text-white hover:bg-[#070FCC] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Baixar XLSX
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ListarDevolucoes;

