import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaArrowLeft, FaCheck, FaBox, FaMapMarkerAlt, FaArrowRight, FaEdit, FaQrcode, FaTrash } from 'react-icons/fa';
import axios from 'axios';
import QrScannerModal, { Html5QrcodeSupportedFormats } from '../components/QrScannerModal';
import jsPDF from 'jspdf';
import {
  formatCriadorRequisicao,
  isRequisicaoDoUtilizadorAtual,
  preparacaoReservadaOutroUtilizador
} from '../utils/requisicaoCriador';
import { desenharPaginaNotaEntregaDigi, NOTA_DEVOLUCAO_PDF_OPTS } from '../utils/notaEntregaPdf';
import { quantidadeStockNacionalNoArmazem } from '../utils/stockNacionalArmazem';
import { operadorPodeDocsELogisticaAposSeparacao, isAdmin } from '../utils/roles';

function labelArmazem(armazem) {
  if (!armazem) return '';
  return armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : (armazem.descricao || '');
}

const MAX_BOBINAS_LOTE = 500;

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
  const [serialScannerIdx, setSerialScannerIdx] = useState(null);
  const [serialScannerContinuous, setSerialScannerContinuous] = useState(false);
  const [stockNacionalPrep, setStockNacionalPrep] = useState({ loading: false, valor: null });
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
    const qtdPreparada = item.quantidade_preparada !== undefined && item.quantidade_preparada !== null
      ? item.quantidade_preparada
      : item.quantidade;
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
    setItemPreparando(null);
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

    const locOrigem = (formItem.localizacao_origem === '_custom_' ? formItem.localizacao_origem_custom : formItem.localizacao_origem)?.trim() || '';
    if (!locOrigem) {
      setToast({ type: 'error', message: 'A localização de saída (onde está saindo) é obrigatória.' });
      return;
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
          localizacao_origem: locOrigem,
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
  const locsOrigem = armazemOrigem?.localizacoes?.map(l => l.localizacao).filter(Boolean) || [];
  const todosPreparados = requisicao.itens?.every(it => it.preparacao_confirmada === true) ?? false;
  const itensPorConfirmar = requisicao.itens?.filter(it => it.preparacao_confirmada !== true) ?? [];
  const preparacaoBloqueadaOutrem = preparacaoReservadaOutroUtilizador(requisicao, user);
  const podeAgirSeparacao = canPrepare && !preparacaoBloqueadaOutrem;
  const podeTrflTraReporte = podeAgirSeparacao && podeDocsPosSeparacao;
  const isFluxoDevolucao =
    String(armazemOrigem?.tipo || requisicao.armazem_origem_tipo || '').toLowerCase() === 'viatura' &&
    String(armazemDestino?.tipo || requisicao.armazem_destino_tipo || '').toLowerCase() === 'central';
  const podeFinalizarTransferenciasPendentes =
    Boolean(requisicao?.devolucao_tra_gerada_em) &&
    Boolean(requisicao?.devolucao_tra_apeados_gerada_em) &&
    Boolean(requisicao?.devolucao_trfl_pendente_gerada_em);

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
            {(requisicao.status === 'separado' && requisicao.separacao_confirmada) && podeTrflTraReporte && !isFluxoDevolucao && (
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
                      : 'Para finalizar, gere TRA APEADOS e TRFL PENDENTE.'
                  }
                >
                  FINALIZAR
                </button>
              )}

            {/* Requisição normal: EM EXPEDICAO */}
            {!isFluxoDevolucao &&
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
            {isFluxoDevolucao ? `Preparar Devolução #${id}` : `Preparar Requisição #${id}`}
          </h1>
          {!isFluxoDevolucao && (
            <p className="text-gray-600">
              Prepare cada item: confirme a quantidade e escolha a localização de saída. O destino é sempre <strong>EXPEDICAO</strong>.
            </p>
          )}
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            {requisicao.armazem_origem_descricao && (
              <div>
                <span className="text-sm text-gray-500">Origem</span>
                <p className="font-medium text-gray-900">{requisicao.armazem_origem_descricao}</p>
              </div>
            )}
            <div>
              <span className="text-sm text-gray-500">Destino</span>
              <p className="font-medium text-gray-900">{requisicao.armazem_descricao}</p>
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
                    requisicao.status === 'EM EXPEDICAO' ? (isFluxoDevolucao ? 'Em processo' : 'Em expedição') :
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
                    <div className="flex-1">
                      <div className="font-medium text-gray-900">{item.item_codigo}</div>
                      <div className="text-sm text-gray-500">{item.item_descricao}</div>
                      <div className="mt-2 flex items-center gap-4 text-sm flex-wrap">
                        <span>
                          Quantidade: <strong className="text-[#0915FF]">{item.quantidade}</strong>
                          {(qtdPreparada > 0 || preparado) && (
                            <span className="ml-2 text-gray-600">
                              (preparado: {qtdPreparada})
                            </span>
                          )}
                        </span>
                        {preparado && (
                          <span className="text-green-600 font-medium flex items-center gap-1">
                            <FaCheck /> Preparado{!completo && ' (quantidade parcial)'}
                          </span>
                        )}
                      </div>
                      {(item.localizacao_origem || item.localizacao_destino) && (
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
                    <form onSubmit={handlePrepararItem} className="mt-4 pt-4 border-t border-gray-200 space-y-4">
                      <div className="flex flex-col lg:flex-row gap-4 lg:items-start lg:gap-6">
                        <div className="flex-1 min-w-0">
                          <label className="block text-sm font-medium text-gray-700 mb-1">Quantidade preparada</label>
                          <input
                            type="number"
                            min="0"
                            step={(item.tipocontrolo || '').toUpperCase() === 'LOTE' ? 1 : 'any'}
                            value={formItem.quantidade_preparada}
                            onChange={handleQuantidadePreparadaChange}
                            className="w-full sm:w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                            required
                          />
                          {/* Devolução: quantidade parcial a considerar como APEADOS (destino FERR no TRFL) */}
                          {isFluxoDevolucao && (
                            <div className="mt-3">
                              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
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
                                      setToast({ type: 'error', message: 'Defina primeiro uma quantidade de devolução (mínimo 1).' });
                                      return;
                                    }

                                    setFormItem((prev) => {
                                      const current = Number(prev.quantidade_apeados) || 0;
                                      const nextApeados = current > 0 ? current : 1;
                                      return { ...prev, quantidade_apeados: Math.min(nextApeados, totalQty) };
                                    });
                                  }}
                                />
                                <span>Marcar uma parte como APEADOS</span>
                              </label>

                              {Number(formItem.quantidade_apeados) > 0 && (
                                <div className="mt-2">
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Quantidade APEADOS (mín. 1)
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
                                    className="w-full sm:w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                                    required
                                  />
                                </div>
                              )}
                            </div>
                          )}
                          <p className="text-xs text-gray-500 mt-1">
                            {(item.tipocontrolo || '').toUpperCase() === 'LOTE' ? (
                              <>
                                Requisitada: {item.quantidade} bobina(s). Este número define quantas bobinas vai separar — aparecem
                                automaticamente os campos de lote e metragem por bobina. Use 0 se não tiver o item.
                              </>
                            ) : (item.tipocontrolo || '').toUpperCase() === 'S/N' ? (
                              <>
                                Requisitada: {item.quantidade} unidade(s). Este número define quantos campos de serial number serão exibidos.
                                Use 0 se não tiver o item.
                              </>
                            ) : (
                              <>
                                Requisitada: {item.quantidade}. Pode ser diferente (para mais ou para menos); o sistema irá pedir confirmação.
                                Use 0 se não tiver o item.
                              </>
                            )}
                          </p>
                        </div>
                        {armazemOrigem && (
                          <div className="shrink-0 w-full sm:max-w-[220px] rounded-lg bg-gray-50 px-3 py-2.5 lg:self-start">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 text-center sm:text-left">
                              Stock nacional · armazém origem
                            </div>
                            <div
                              className="text-xs text-gray-600 mt-0.5 truncate text-center sm:text-left"
                              title={labelArmazem(armazemOrigem)}
                            >
                              {labelArmazem(armazemOrigem)}
                            </div>
                            <div className="mt-2 text-2xl font-bold tabular-nums text-gray-900 min-h-[2rem] flex items-center justify-center sm:justify-start">
                              {stockNacionalPrep.loading ? '…' : stockNacionalPrep.valor != null ? stockNacionalPrep.valor : '—'}
                            </div>
                          </div>
                        )}
                      </div>
                      {(item.tipocontrolo || '').toUpperCase() === 'LOTE' && (
                        <div className="space-y-3">
                          <span className="text-sm font-medium text-gray-700">Bobinas preparadas</span>
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
                        </div>
                      )}
                      {(item.tipocontrolo || '').toUpperCase() === 'S/N' && (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium text-gray-700">Seriais preparados</span>
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
                            formatsToSupport={[
                              Html5QrcodeSupportedFormats.CODE_128,
                              Html5QrcodeSupportedFormats.CODE_39,
                              Html5QrcodeSupportedFormats.CODE_93,
                              Html5QrcodeSupportedFormats.EAN_13,
                              Html5QrcodeSupportedFormats.EAN_8,
                              Html5QrcodeSupportedFormats.UPC_A,
                              Html5QrcodeSupportedFormats.UPC_E,
                              Html5QrcodeSupportedFormats.ITF,
                              Html5QrcodeSupportedFormats.CODABAR,
                              Html5QrcodeSupportedFormats.QR_CODE
                            ]}
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Localização de saída (onde está saindo) <span className="text-red-600">*</span>
                        </label>
                        {armazemOrigem && (
                          <p className="text-xs text-gray-500 mb-2">
                            Armazém origem: <strong>{armazemOrigem.codigo ? `${armazemOrigem.codigo} - ` : ''}{armazemOrigem.descricao}</strong>
                            {locsOrigem.length === 0 && <span className="block mt-1 text-amber-600">Nenhuma localização cadastrada</span>}
                          </p>
                        )}
                        {locsOrigem.length > 0 ? (
                          <>
                            <div className="flex gap-2">
                              <select
                                value={formItem.localizacao_origem}
                                onChange={(e) => setFormItem(prev => ({ ...prev, localizacao_origem: e.target.value }))}
                                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                                required
                              >
                                <option value="">Selecione a localização...</option>
                                {locsOrigem.map((loc, i) => (
                                  <option key={i} value={loc}>{loc}</option>
                                ))}
                                <option value="_custom_">Outra (digite)</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => setShowQrScanner(true)}
                                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 flex items-center gap-1"
                                title="Ler localização com QR Code"
                              >
                                <FaQrcode /> Ler QR
                              </button>
                            </div>
                            {formItem.localizacao_origem === '_custom_' && (
                              <input
                                type="text"
                                value={formItem.localizacao_origem_custom}
                                onChange={(e) => setFormItem(prev => ({ ...prev, localizacao_origem_custom: e.target.value }))}
                                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                                placeholder="Digite a localização de saída"
                                required
                              />
                            )}
                          </>
                        ) : (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={formItem.localizacao_origem}
                              onChange={(e) => setFormItem(prev => ({ ...prev, localizacao_origem: e.target.value }))}
                              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                              placeholder="Ex: Prateleira A3"
                              required
                            />
                            <button
                              type="button"
                              onClick={() => setShowQrScanner(true)}
                              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 flex items-center gap-1"
                              title="Ler localização com QR Code"
                            >
                              <FaQrcode /> Ler QR
                            </button>
                          </div>
                        )}
                        <QrScannerModal
                          open={showQrScanner}
                          onClose={() => setShowQrScanner(false)}
                          onScan={(texto) => {
                            const loc = (texto || '').trim();
                            if (!loc) return;
                            if (locsOrigem.length > 0) {
                              if (locsOrigem.includes(loc)) {
                                setFormItem(prev => ({ ...prev, localizacao_origem: loc, localizacao_origem_custom: '' }));
                                setToast({ type: 'success', message: `Localização definida: ${loc}` });
                              } else {
                                setToast({
                                  type: 'error',
                                  message: `Localização não reconhecida. O QR Code deve ser uma das localizações do armazém: ${locsOrigem.join(', ')}`
                                });
                              }
                            } else {
                              setFormItem(prev => ({ ...prev, localizacao_origem: loc }));
                              setToast({ type: 'success', message: `Localização definida: ${loc}` });
                            }
                          }}
                          title="Ler localização por QR Code (apenas localizações do armazém)"
                        />
                      </div>
                      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                        <p className="text-sm font-medium text-gray-700">Destino (automático)</p>
                        <p className="text-xs text-gray-600 mt-1">
                          Todos os itens vão para <strong>EXPEDICAO</strong>
                          {armazemDestino?.codigo && (
                            <span> — armazém destino: {armazemDestino.codigo} ({armazemDestino.codigo}, {armazemDestino.codigo}.FERR)</span>
                          )}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={submitting === item.id}
                          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                        >
                          {submitting === item.id ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                              Salvando...
                            </>
                          ) : (
                            <>
                              <FaCheck /> Confirmar preparação
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={fecharPrepararItem}
                          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                        >
                          Cancelar
                        </button>
                      </div>
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
                  <p className="text-gray-700 mb-3">Todos os itens foram preparados. Clique abaixo para concluir a separação da requisição.</p>
                  <button
                    type="button"
                    onClick={handleCompletarSeparacao}
                    className="px-4 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-2 font-medium"
                  >
                    <FaCheck /> Concluir preparação da requisição
                  </button>
                </>
              ) : (
                <>
                  <p className="text-gray-700 mb-2">Confirme a preparação de todos os itens (use 0 quando não tiver o item) para poder concluir.</p>
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
                    <FaCheck /> Concluir preparação da requisição
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
