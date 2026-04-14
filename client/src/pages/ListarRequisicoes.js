import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaSearch, FaPlus, FaEdit, FaTrash, FaBoxOpen, FaCheck, FaFileImport } from 'react-icons/fa';
import jsPDF from 'jspdf';
import {
  formatCriadorRequisicao,
  isRequisicaoDoUtilizadorAtual,
  preparacaoReservadaOutroUtilizador
} from '../utils/requisicaoCriador';
import { desenharPaginaNotaEntregaDigi } from '../utils/notaEntregaPdf';
import { operadorPodeDocsELogisticaAposSeparacao, isAdmin } from '../utils/roles';
import { getRequisicoesArmazemOrigemIds } from '../utils/requisicoesArmazemOrigem';
import { podeUsarConsultaMovimentos, podeUsarControloStock } from '../utils/controloStock';

const ListarRequisicoes = ({ modo = 'requisicoes' }) => {
  const RECEBIMENTO_TRANSFERENCIA_MARKER = 'RECEBIMENTO_TRANSFERENCIA_V1';
  const [requisicoes, setRequisicoes] = useState([]);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filtros, setFiltros] = useState({
    status: ''
  });
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [showStatusBoard, setShowStatusBoard] = useState(true);
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, req: null });
  const contextMenuRef = useRef(null);
  const latestFetchIdRef = useRef(0);
  const [reporteModal, setReporteModal] = useState({
    open: false,
    title: '',
    kind: 'reporte', // 'reporte' | 'clog' | 'reporte-recebimento'
    mode: 'single', // 'single' | 'multi'
    reqId: null,
    ids: [],
    columns: [],
    rows: []
  });
  const [reporteLoading, setReporteLoading] = useState(false);
  const [traNumeroByReqId, setTraNumeroByReqId] = useState({});
  const [savingTraReqId, setSavingTraReqId] = useState(null);
  /** Só requisições criadas pelo utilizador atual */
  const [somenteMinhas, setSomenteMinhas] = useState(false);
  const [armazensById, setArmazensById] = useState({});
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const isModoTransferencias = modo === 'transferencias';
  const rotaBase = isModoTransferencias ? '/transferencias' : '/requisicoes';
  const flowParam = String(new URLSearchParams(location.search || '').get('fluxo') || '').toLowerCase();
  const hasFluxoTransferSelecionado = ['centrais', 'apeados', 'recebimento'].includes(flowParam);
  const createTransferLink = hasFluxoTransferSelecionado
    ? `/transferencias/criar?transferencias=1&fluxo=${flowParam}`
    : '/transferencias/criar?transferencias=1';
  const rotaPrepararComOrigem = (reqId) =>
    isModoTransferencias
      ? `/requisicoes/preparar/${reqId}?origem=transferencias`
      : `/requisicoes/preparar/${reqId}`;
  const canCreateOrEdit = user && ['admin', 'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  const canDelete = user && ['admin', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  const canPrepare = user && ['admin', 'operador', 'backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  /** TRFL, TRA, Reporte, Clog, Finalizar — operador não */
  const canDocsELogisticaPosSeparacao =
    Boolean(canPrepare && operadorPodeDocsELogisticaAposSeparacao(user?.role));

  const acessoTotalRequisicoes = isAdmin(user?.role);
  const semArmazemOrigemAtribuido = Boolean(
    user && !acessoTotalRequisicoes && getRequisicoesArmazemOrigemIds(user).length === 0
  );
  const podeCriarOuImportarRequisicao = canCreateOrEdit && !semArmazemOrigemAtribuido;
  const podeTransferenciaLocalizacao = Boolean(user && podeUsarControloStock(user));
  const podeConsultarMovimentos = Boolean(user && podeUsarConsultaMovimentos(user));

  useEffect(() => {
    fetchRequisicoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtros, somenteMinhas, isModoTransferencias]);

  // Mapeamento de tipos de armazém (central/apeado) para filtrar "Transferências"
  // e evitar que central↔apeado apareça em "Requisições".
  useEffect(() => {
    const fetchArmazens = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/armazens?ativo=true&destino_requisicao=1', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        const mapa = (Array.isArray(data) ? data : []).reduce((acc, a) => {
          const idNum = Number(a?.id);
          if (!Number.isFinite(idNum)) return acc;
          acc[idNum] = String(a?.tipo || '').trim().toLowerCase();
          return acc;
        }, {});
        setArmazensById(mapa);
      } catch (_) {}
    };
    fetchArmazens();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const statusParam = params.get('status') || '';
    const fluxoTransferenciaParam = String(params.get('fluxo') || '').toLowerCase();
    const fluxoValido = ['centrais', 'apeados', 'recebimento'].includes(fluxoTransferenciaParam);
    const temFiltroNaUrl = Boolean(statusParam);

    setFiltros(prev => {
      if (prev.status === statusParam) return prev;
      return {
        ...prev,
        status: statusParam
      };
    });
    // Em Transferências: sem "fluxo" selecionado, mostramos sempre a tela de seleção.
    if (isModoTransferencias && !fluxoValido) {
      setShowStatusBoard(true);
    } else {
      setShowStatusBoard(!temFiltroNaUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, isModoTransferencias]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        setContextMenu(prev => ({ ...prev, visible: false }));
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
      setContextMenu(prev => ({ ...prev, x, y }));
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  const fetchRequisicoes = async () => {
    const fetchId = ++latestFetchIdRef.current;
    try {
      setLoading(true);
      const token = localStorage.getItem('token');

      const baseParams = new URLSearchParams();
      if (filtros.status) baseParams.append('status', filtros.status);
      if (somenteMinhas) baseParams.append('minhas', '1');

      if (isModoTransferencias) {
        const paramsSemFlag = new URLSearchParams(baseParams.toString());
        const paramsComFlag = new URLSearchParams(baseParams.toString());
        paramsComFlag.append('transferencias', '1');

        const [respA, respB] = await Promise.all([
          fetch(`/api/requisicoes?${paramsSemFlag.toString()}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store'
          }),
          fetch(`/api/requisicoes?${paramsComFlag.toString()}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store'
          })
        ]);

        const dataA = respA.ok ? await respA.json().catch(() => []) : [];
        const dataB = respB.ok ? await respB.json().catch(() => []) : [];

        const merged = [...(Array.isArray(dataA) ? dataA : []), ...(Array.isArray(dataB) ? dataB : [])];
        // Deduplicar por id.
        const uniqueMap = new Map();
        for (const r of merged) {
          const id = Number(r?.id);
          if (!Number.isFinite(id)) continue;
          uniqueMap.set(id, r);
        }
        const data = Array.from(uniqueMap.values());

        if (fetchId === latestFetchIdRef.current) {
          setRequisicoes(data);
        }
        return data;
      } else {
        const params = baseParams;
        const response = await fetch(`/api/requisicoes?${params.toString()}`, {
          headers: {
            'Authorization': `Bearer ${token}`
          },
          cache: 'no-store'
        });

        if (response.ok) {
          const data = await response.json();
          if (fetchId === latestFetchIdRef.current) {
            setRequisicoes(data);
          }
          return data;
        }

        setToast({ type: 'error', message: 'Erro ao carregar requisições' });
        return null;
      }
    } catch (error) {
      console.error('Erro ao buscar requisições:', error);
      setToast({ type: 'error', message: 'Erro ao carregar requisições' });
      return null;
    } finally {
      if (fetchId === latestFetchIdRef.current) {
        setLoading(false);
      }
    }
  };

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

  const marcarEmExpedicao = async (reqId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/requisicoes/${reqId}/marcar-em-expedicao`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Erro ao marcar em expedição');
    }
  };

  const marcarEntregue = async (reqId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/requisicoes/${reqId}/marcar-entregue`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Erro ao marcar como entregue');
    }
  };

  const voltarParaExpedicao = async (reqId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/requisicoes/${reqId}/voltar-em-expedicao`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Erro ao voltar para Em expedição');
    }
  };

  const fetchRequisicaoDetalhe = async (reqId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/requisicoes/${reqId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data;
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

  const EPI_DISCLAIMER_TITULO = 'Declaração (DL 348/93 de 1 de Outubro)';
  const EPI_DISCLAIMER_TEXTO =
    'Declaro(a) que recebi os Equipamentos de Proteção Individual (EPI) acima mencionados e que fui informado(a) dos respetivos riscos que pretendem proteger, comprometendo-me a utilizá-los corretamene de acordo com as instruções recebidas, a conservá-los e mantê-los em bom estado, e a participar ao meu superior hierárquico todas as avarias ou deficiências de que tenha conhecimento.';
  const EPI_RISCOS_DESCRITIVOS = [
    'Queda em Altura',
    'Queda ao Mesmo ou com Desnível',
    'Queda de Objetos',
    'Esmagamento',
    'Queimadura',
    'Entalamento',
    'Atropelamento',
    'Eletrocussão/ Eletrização',
    'Pancada na Cabeça',
    'Exposição ao Ruído',
    'Exposição Agentes Químicos/ Poeiras',
    'Choque com ou contra Objetos/ Equipamentos em movimento ou imóveis',
    'Projeção de Partículas/ Fragmentos',
    'Golpe, Corte e /ou Perfuração'
  ];

  const isNotaEpi = (reqObj) => {
    const destinoTipo = String(reqObj?.armazem_destino_tipo || '').trim().toLowerCase();
    const obsNorm = String(reqObj?.observacoes || '').toUpperCase();
    return destinoTipo === 'epi' || obsNorm.includes('IMPORTADA DE EXCEL (EPI)');
  };

  const desenharDisclaimerEpiAcimaAssinaturas = (doc) => {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 40;
    const bottomMargin = 60;
    const signaturesBlockHeight = 70;
    const topYSignatures = pageHeight - bottomMargin - signaturesBlockHeight;
    const availableHeight = Math.max(0, topYSignatures - 70);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(45, 45, 45);

    const textWidth = pageWidth - 2 * marginX;
    const lines = doc.splitTextToSize(EPI_DISCLAIMER_TEXTO, textWidth);
    const titleHeight = 13;
    const lineHeight = 10;
    const bodyHeight = lines.length * lineHeight;

    // Tabela em duas colunas (1–7 | 8–14): menos altura na folha; texto com quebra na coluna "Risco".
    const tableW = pageWidth - 2 * marginX;
    const gapMid = 8;
    const leftPanelW = (tableW - gapMid) / 2;
    const colNumW = 22;
    const colRiscoW = leftPanelW - colNumW;
    const riscoHeaderHeight = 14;
    const subHeaderH = 12;
    const riscoLineH = 8;
    const riscoRowPad = 4;
    const riscoRowMin = 10;
    const numPairRows = Math.ceil(EPI_RISCOS_DESCRITIVOS.length / 2);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const rowHeights = [];
    let bodyGridH = 0;
    for (let r = 0; r < numPairRows; r += 1) {
      const leftTxt = EPI_RISCOS_DESCRITIVOS[r] || '';
      const rightTxt = EPI_RISCOS_DESCRITIVOS[r + numPairRows] || '';
      const leftLn = leftTxt ? doc.splitTextToSize(leftTxt, Math.max(20, colRiscoW - 6)) : [''];
      const rightLn = rightTxt ? doc.splitTextToSize(rightTxt, Math.max(20, colRiscoW - 6)) : [''];
      const rowH = Math.max(
        riscoRowMin,
        Math.max(leftLn.length, rightLn.length) * riscoLineH + riscoRowPad
      );
      rowHeights.push(rowH);
      bodyGridH += rowH;
    }

    const riscoTableHeight = riscoHeaderHeight + subHeaderH + bodyGridH;
    const gapAntesDeclaracao = 14;
    const blockHeight = riscoTableHeight + gapAntesDeclaracao + titleHeight + bodyHeight + 4;

    let yStart = topYSignatures - blockHeight - 12;
    const minY = 60;
    if (yStart < minY) yStart = minY;
    if (yStart + blockHeight > availableHeight + 60) {
      yStart = Math.max(minY, availableHeight + 60 - blockHeight);
    }

    const tableX = marginX;
    const tableY = yStart;
    const leftPanelX = tableX;
    const rightPanelX = tableX + leftPanelW + gapMid;

    doc.setDrawColor(175, 175, 175);
    doc.setLineWidth(0.35);
    doc.rect(tableX, tableY, tableW, riscoHeaderHeight);
    doc.rect(leftPanelX, tableY + riscoHeaderHeight, leftPanelW, subHeaderH);
    doc.rect(rightPanelX, tableY + riscoHeaderHeight, leftPanelW, subHeaderH);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(70, 70, 70);
    doc.text('RISCOS A PROTEGER', tableX + tableW / 2, tableY + 10, { align: 'center' });

    const ySub = tableY + riscoHeaderHeight;
    doc.text('Nº', leftPanelX + colNumW / 2, ySub + 8, { align: 'center' });
    doc.text('Risco', leftPanelX + colNumW + colRiscoW / 2, ySub + 8, { align: 'center' });
    doc.text('Nº', rightPanelX + colNumW / 2, ySub + 8, { align: 'center' });
    doc.text('Risco', rightPanelX + colNumW + colRiscoW / 2, ySub + 8, { align: 'center' });

    let rowY = ySub + subHeaderH;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(80, 80, 80);
    for (let r = 0; r < numPairRows; r += 1) {
      const rowH = rowHeights[r];
      const leftTxt = EPI_RISCOS_DESCRITIVOS[r] || '';
      const rightTxt = EPI_RISCOS_DESCRITIVOS[r + numPairRows] || '';
      const leftLn = leftTxt ? doc.splitTextToSize(leftTxt, Math.max(20, colRiscoW - 6)) : [''];
      const rightLn = rightTxt ? doc.splitTextToSize(rightTxt, Math.max(20, colRiscoW - 6)) : [''];

      doc.rect(leftPanelX, rowY, colNumW, rowH);
      doc.rect(leftPanelX + colNumW, rowY, colRiscoW, rowH);
      doc.rect(rightPanelX, rowY, colNumW, rowH);
      doc.rect(rightPanelX + colNumW, rowY, colRiscoW, rowH);

      const yMid = rowY + rowH / 2 + 2.5;
      doc.text(String(r + 1), leftPanelX + colNumW / 2, yMid, { align: 'center' });
      doc.text(leftLn, leftPanelX + colNumW + 3, rowY + 8);
      doc.text(String(r + 1 + numPairRows), rightPanelX + colNumW / 2, yMid, { align: 'center' });
      doc.text(rightLn, rightPanelX + colNumW + 3, rowY + 8);
      rowY += rowH;
    }

    const yDeclaracao = tableY + riscoTableHeight + gapAntesDeclaracao;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(45, 45, 45);
    doc.text(EPI_DISCLAIMER_TITULO, pageWidth / 2, yDeclaracao, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(lines, pageWidth / 2, yDeclaracao + titleHeight, { align: 'center' });
  };

  const baixarPdfEntregaMultiRespeitandoDestino = (reqs) => {
    const arr = (Array.isArray(reqs) ? reqs : []).filter(Boolean);
    if (arr.length === 0) return;

    const destinos = new Set(arr.map(r => String(r.armazem_id ?? r.armazem_destino_id ?? r.armazem_descricao ?? '')));
    if (destinos.size <= 1) {
      gerarPdfEntrega(arr);
      return;
    }

    // Destinos diferentes: gera 1 PDF por requisição
    for (const r of arr) {
      gerarPdfEntrega([r]);
    }
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
    const hasEpiReq = arr.some((r) => isNotaEpi(r));
    const disclaimerReserve = hasEpiReq ? 240 : 0;
    if (lastY + 30 + disclaimerReserve > sigTop) {
      doc.addPage();
    }
    if (hasEpiReq) {
      desenharDisclaimerEpiAcimaAssinaturas(doc);
    }
    desenharAssinaturasRodape(doc);

    const filename = arr.length === 1
      ? `NOTA_ENTREGA_${arr[0]?.id || ''}_${dateStr}.pdf`
      : `NOTA_ENTREGA_multi_${dateStr}.pdf`;

    doc.save(filename);
  };

  const handleEntregar = async (req) => {
    const reqId = req?.id;
    try {
      if (!reqId) throw new Error('Requisição inválida');
      if (req.status !== 'EM EXPEDICAO') {
        throw new Error('Só é possível entregar quando a requisição está em expedição.');
      }
      const ok = await confirm({
        title: 'Entregar',
        message: 'Tem certeza que deseja continuar? Isso vai alterar o status para Entregue.',
        confirmLabel: 'Sim, entregar',
        variant: 'warning'
      });
      if (!ok) return;

      const detalhe = await fetchRequisicaoDetalhe(reqId);
      gerarPdfEntrega([detalhe || req]);
      await marcarEntregue(reqId);
      const isCentralCentral =
        String(req?.armazem_origem_tipo || '').toLowerCase() === 'central' &&
        String(req?.armazem_destino_tipo || '').toLowerCase() === 'central';
      if (isCentralCentral) {
        setRequisicoes((prev) =>
          (prev || []).map((r) =>
            Number(r?.id) === Number(reqId)
              ? { ...r, recepcao_status: 'AGUARDANDO_RECECAO', status: 'EM EXPEDICAO' }
              : r
          )
        );
      }
      setToast({
        type: 'success',
        message: isCentralCentral
          ? 'Encaminhada para recebimento no destino. A origem fica em Em expedição (Aguardando receção).'
          : 'Requisição marcada como Entregue.'
      });
      await fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao entregar' });
    }
  };

  const handleEntregarMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map(x => parseInt(x, 10)).filter(Boolean);
    const entregaveis = uniqueIds.filter(id => {
      const r = requisicoes.find(x => x.id === id);
      return r?.status === 'EM EXPEDICAO' && !isAguardandoRececao(r);
    });
    if (entregaveis.length === 0) {
      setToast({ type: 'error', message: 'Selecione requisições em expedição para entregar.' });
      return;
    }
    try {
      const reqs = [];
      for (const id of entregaveis) {
        // eslint-disable-next-line no-await-in-loop
        const detalhe = await fetchRequisicaoDetalhe(id);
        reqs.push(detalhe || requisicoes.find(x => x.id === id));
      }

      const arr = reqs.filter(Boolean);
      const destinos = new Set(arr.map(r => String(r.armazem_id ?? r.armazem_destino_id ?? r.armazem_descricao ?? '')));
      const msgDocs = destinos.size <= 1
        ? `Será gerado 1 PDF com ${arr.length} requisição(ões) (mesmo armazém destino).`
        : `Os armazéns destino são diferentes. Serão gerados ${arr.length} PDFs separados (1 por requisição).`;

      const ok = await confirm({
        title: 'Entregar (múltiplas)',
        message: `Tem certeza que deseja continuar? Isso vai marcar ${arr.length} requisição(ões) como Entregue. ${msgDocs}`,
        confirmLabel: 'Sim, entregar',
        variant: 'warning'
      });
      if (!ok) return;

      baixarPdfEntregaMultiRespeitandoDestino(reqs);
      for (const id of entregaveis) {
        // eslint-disable-next-line no-await-in-loop
        await marcarEntregue(id);
      }
      const centraisIds = entregaveis.filter((id) => {
        const r = requisicoes.find((x) => Number(x?.id) === Number(id));
        return (
          String(r?.armazem_origem_tipo || '').toLowerCase() === 'central' &&
          String(r?.armazem_destino_tipo || '').toLowerCase() === 'central'
        );
      });
      if (centraisIds.length > 0) {
        const idSet = new Set(centraisIds.map((x) => Number(x)));
        setRequisicoes((prev) =>
          (prev || []).map((r) =>
            idSet.has(Number(r?.id))
              ? { ...r, recepcao_status: 'AGUARDANDO_RECECAO', status: 'EM EXPEDICAO' }
              : r
          )
        );
      }
      setToast({ type: 'success', message: 'Requisições marcadas como Entregue.' });
      await fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao entregar' });
    }
  };

  const handleVoltarEmExpedicao = async (req) => {
    const reqId = req?.id;
    try {
      if (!reqId) throw new Error('Requisição inválida');
      if (req.status !== 'Entregue') {
        throw new Error('Só é possível voltar para Em expedição quando a requisição está Entregue.');
      }
      const ok = await confirm({
        title: 'Voltar para Em expedição',
        message: 'Tem certeza? Isso vai alterar o status para Em expedição.',
        confirmLabel: 'Sim, voltar',
        variant: 'warning'
      });
      if (!ok) return;

      await voltarParaExpedicao(reqId);
      setToast({ type: 'success', message: 'Requisição marcada como Em expedição.' });
      await fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao voltar para Em expedição' });
    }
  };

  const handleBaixarPdfEntrega = async (req) => {
    const reqId = req?.id;
    try {
      if (!reqId) throw new Error('Requisição inválida');
      if (!['Entregue', 'FINALIZADO'].includes(req.status)) {
        throw new Error('O comprovativo de entrega só está disponível após a requisição estar Entregue.');
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
    const uniqueIds = Array.from(new Set(ids || [])).map(x => parseInt(x, 10)).filter(Boolean);
    const byId = new Map((requisicoes || []).map(r => [r.id, r]));
    const elegiveis = uniqueIds.filter(id => ['Entregue', 'FINALIZADO'].includes(byId.get(id)?.status));
    if (elegiveis.length === 0) {
      setToast({ type: 'error', message: 'Selecione requisições Entregues/Finalizadas para baixar o comprovativo.' });
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
      const destinos = new Set(arr.map(r => String(r.armazem_id ?? r.armazem_destino_id ?? r.armazem_descricao ?? '')));
      const msgDocs = destinos.size <= 1
        ? `Será gerado 1 PDF com ${arr.length} requisição(ões) (mesmo armazém destino).`
        : `Os armazéns destino são diferentes. Serão gerados ${arr.length} PDFs separados (1 por requisição).`;

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

  const handleExportTRFL = async (req, opts = {}) => {
    const reqId = req?.id;
    try {
      if (!reqId) throw new Error('Requisição inválida');

      const isRedownload = Boolean(opts.redownload);
      if (isRedownload) {
        const ok = await confirm({
          title: 'Baixar TRFL',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        });
        if (!ok) return;
      } else {
        const ok = await confirm({
          title: 'Gerar TRFL',
          message: 'Deseja continuar? Ao continuar, a requisição será marcada como Em expedição.',
          confirmLabel: 'Continuar'
        });
        if (!ok) return;
      }

      await downloadExport(
        `/api/requisicoes/${reqId}/export-trfl`,
        `TRFL_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        isRedownload ? 'TRFL baixada novamente.' : 'TRFL gerada com sucesso.'
      );
      if (req.status === 'separado') {
        try {
          await marcarEmExpedicao(reqId);
        } catch (err) {
          const data = await fetchRequisicoes();
          const updated = Array.isArray(data) ? data.find(x => x.id === reqId) : null;
          if ((updated?.status || '') !== 'EM EXPEDICAO') throw err;
          return;
        }
      }
      await fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRFL:', error);
      const msg = error.response?.data?.error || error.message || 'Erro ao exportar TRFL';
      setToast({ type: 'error', message: msg });
    }
  };

  const handleExportTRA = async (req, opts = {}) => {
    const reqId = req?.id;
    try {
      if (!reqId) throw new Error('Requisição inválida');
      if (req.status === 'EM EXPEDICAO') {
        throw new Error('Antes de gerar a TRA, clique em ENTREGAR para mudar o status para Entregue.');
      }

      const isRedownload = Boolean(opts.redownload);
      if (isRedownload) {
        const ok = await confirm({
          title: 'Baixar TRA',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        });
        if (!ok) return;
      } else {
        const ok = await confirm({
          title: 'Gerar TRA',
          message: 'Deseja continuar? Após gerar a TRA, esta requisição ficará apta para FINALIZAR.',
          confirmLabel: 'Continuar'
        });
        if (!ok) return;
      }

      await downloadExport(
        `/api/requisicoes/${reqId}/export-tra`,
        `TRA_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        isRedownload ? 'TRA baixada novamente.' : 'TRA gerada com sucesso.'
      );
      if (!isRedownload && !String(req?.tra_numero || '').trim()) {
        setToast({ type: 'success', message: 'TRA gerada. Preencha o Nº TRA diretamente na card para poder finalizar.' });
      }

      await fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRA:', error);
      const msg = error.response?.data?.error || error.message || 'Erro ao exportar TRA';
      setToast({ type: 'error', message: msg });
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
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do reporte');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Reporte (Requisição #${reqId})`,
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

  const handleFinalizar = async (reqId) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/finalizar`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao finalizar requisição');
      }
      setToast({ type: 'success', message: 'Requisição finalizada.' });
      fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao finalizar requisição' });
    }
  };

  const handleExportReporteRecebimento = async (req) => {
    try {
      if (!req?.id) throw new Error('Requisição inválida');
      await downloadExport(
        `/api/requisicoes/transferencias/recebimento/${req.id}/export-reporte`,
        `REPORTE_recebimento_${req.id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'Reporte de recebimento gerado com sucesso.'
      );
      await fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao gerar reporte de recebimento' });
    }
  };

  const handleReporteRecebimentoModal = async (req) => {
    const reqId = req?.id;
    if (!reqId) {
      setToast({ type: 'error', message: 'Requisição inválida' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/transferencias/recebimento/${reqId}/reporte-dados`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do reporte');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Reporte recebimento (#${reqId})`,
        kind: 'reporte-recebimento',
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

  const handleFinalizarRecebimento = async (reqId) => {
    try {
      const ok = await confirm({
        title: 'Finalizar recebimento',
        message: 'Deseja marcar este recebimento como Finalizado?',
        confirmLabel: 'Finalizar',
      });
      if (!ok) return;
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/transferencias/recebimento/${reqId}/finalizar`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao finalizar recebimento');
      }
      await fetchRequisicoes();
      setToast({ type: 'success', message: 'Recebimento finalizado.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao finalizar recebimento' });
    }
  };

  const handleConfirmarEntregaRecebimento = async (reqId) => {
    try {
      const ok = await confirm({
        title: 'Confirmar receção',
        message: 'Deseja confirmar a entrega deste recebimento?',
        confirmLabel: 'Confirmar',
      });
      if (!ok) return;
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/transferencias/recebimento/${reqId}/confirmar-entrega`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao confirmar entrega');
      }
      await fetchRequisicoes();
      setToast({ type: 'success', message: 'Entrega confirmada.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao confirmar entrega' });
    }
  };

  const handleConfirmarTraRecebimento = async (reqId) => {
    try {
      const ok = await confirm({
        title: 'Confirmar TRA',
        message: 'Deseja confirmar o Nº TRA da origem para liberar a finalização?',
        confirmLabel: 'Confirmar TRA',
      });
      if (!ok) return;
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/transferencias/recebimento/${reqId}/confirmar-tra`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao confirmar TRA');
      }
      await fetchRequisicoes();
      setToast({ type: 'success', message: 'TRA confirmada. Finalização liberada.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao confirmar TRA' });
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
      await fetchRequisicoes();
      setToast({ type: 'success', message: `Nº TRA guardado: ${valor}` });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao guardar número da TRA' });
    } finally {
      setSavingTraReqId(null);
    }
  };

  const handleReceberStockRecebimento = async (reqId) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/transferencias/recebimento/${reqId}/receber-stock`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao receber stock');
      }
      await fetchRequisicoes();
      setToast({ type: 'success', message: 'Stock recebido com sucesso.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao receber stock' });
    }
  };

  const handleFinalizarMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map(x => parseInt(x, 10)).filter(Boolean);
    if (uniqueIds.length === 0) return;

    // Finalizar apenas as que estão Entregue, já tiveram TRA gerada e com Nº TRA preenchido
    const byId = new Map((requisicoes || []).map(r => [r.id, r]));
    const elegiveis = uniqueIds.filter(id => {
      const r = byId.get(id);
      return r?.status === 'Entregue' && Boolean(r?.tra_gerada_em) && Boolean(String(r?.tra_numero || '').trim());
    });
    const ignoradas = uniqueIds.filter(id => !elegiveis.includes(id));

    if (elegiveis.length === 0) {
      setToast({
        type: 'error',
        message: 'Nenhuma requisição selecionada está elegível para finalizar (precisa estar Entregue, ter TRA gerada e Nº TRA preenchido).'
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
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) okCount++;
        else failCount++;
      }
      await fetchRequisicoes();
      const parts = [];
      if (okCount) parts.push(`${okCount} finalizada(s)`);
      if (failCount) parts.push(`${failCount} falhou(aram)`);
      if (ignoradas.length) parts.push(`${ignoradas.length} ignorada(s) (não Entregue)`);
      setToast({ type: 'success', message: `Finalização concluída: ${parts.join(', ')}.` });
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao finalizar requisições' });
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Excluir requisição',
      message: 'Tem certeza que deseja excluir esta requisição?',
      variant: 'danger'
    });
    if (!ok) return;

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        setToast({ type: 'success', message: 'Requisição excluída com sucesso' });
        fetchRequisicoes();
      } else {
        const data = await response.json();
        setToast({ type: 'error', message: data.error || 'Erro ao excluir requisição' });
      }
    } catch (error) {
      console.error('Erro ao excluir requisição:', error);
      setToast({ type: 'error', message: 'Erro ao excluir requisição' });
    }
  };

  const handleConfirmarSeparacao = async (reqId) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/confirmar-separacao`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Falha ao confirmar');
      }
      setToast({ type: 'success', message: 'Separação confirmada com sucesso' });
      fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao confirmar separação:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao confirmar separação' });
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
    const byId = new Map((requisicoes || []).map(r => [r.id, r]));
    const reqs = ids.map(id => byId.get(id)).filter(Boolean);
    return { ids, reqs, complete: reqs.length === ids.length };
  };

  const handleExportMultiTRFL = async (idsArg, opts = {}) => {
    const ids = Array.from(new Set(idsArg || selectedIds)).map(x => parseInt(x, 10)).filter(Boolean);
    const isRedownload = Boolean(opts.redownload);

    if (ids.length < 2) {
      setToast({ type: 'error', message: 'Selecione pelo menos 2 requisições para TRFL combinado.' });
      return;
    }
    try {
      const ok = isRedownload
        ? await confirm({
          title: 'Baixar TRFL (combinado)',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        })
        : await confirm({
          title: 'Gerar TRFL (combinado)',
          message: 'Deseja continuar? Ao continuar, as requisições selecionadas (com status Separado) serão marcadas como Em expedição.',
          confirmLabel: 'Continuar'
        });
      if (!ok) return;

      const token = localStorage.getItem('token');
      const res = await fetch('/api/requisicoes/export-trfl-multi', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao exportar TRFL combinado');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `TRFL_multi_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      if (!isRedownload) {
        for (const id of ids) {
          const r = requisicoes.find(x => x.id === id);
          if (r?.status === 'separado') {
            // eslint-disable-next-line no-await-in-loop
            await marcarEmExpedicao(id);
          }
        }
      }
      await fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRFL combinado:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRFL combinado' });
    }
  };

  const handleExportMultiTRA = async (idsArg, opts = {}) => {
    const ids = Array.from(new Set(idsArg || selectedIds)).map(x => parseInt(x, 10)).filter(Boolean);
    const isRedownload = Boolean(opts.redownload);

    if (ids.length < 2) {
      setToast({ type: 'error', message: 'Selecione pelo menos 2 requisições para TRA combinado.' });
      return;
    }
    const targets = ids.map(id => requisicoes.find(x => x.id === id)).filter(Boolean);
    const validGenerate = targets.every(r => r.status === 'Entregue' && !r.tra_gerada_em);
    const validRedownload = targets.every(r => (r.status === 'Entregue' && r.tra_gerada_em) || r.status === 'FINALIZADO');
    if (!isRedownload && !validGenerate) {
      setToast({ type: 'error', message: 'Para GERAR TRA combinado, selecione apenas requisições Entregues que ainda não tiveram TRA gerada.' });
      return;
    }
    if (isRedownload && !validRedownload) {
      setToast({ type: 'error', message: 'Para BAIXAR TRA combinado, selecione apenas requisições com TRA já gerada (Entregue/Finalizado).' });
      return;
    }
    try {
      const ok = isRedownload
        ? await confirm({
          title: 'Baixar TRA (combinado)',
          message: 'Deseja baixar novamente?',
          confirmLabel: 'Baixar novamente',
          variant: 'warning'
        })
        : await confirm({
          title: 'Gerar TRA (combinado)',
          message: 'Deseja continuar? Após gerar a TRA, as requisições selecionadas ficarão aptas para FINALIZAR.',
          confirmLabel: 'Continuar'
        });
      if (!ok) return;

      const token = localStorage.getItem('token');
      const res = await fetch('/api/requisicoes/export-tra-multi', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao exportar TRA combinado');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `TRA_multi_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);

      await fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRA combinado:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRA combinado' });
    }
  };

  const handleExportMultiReporte = async (idsArg) => {
    const ids = Array.from(new Set(idsArg || selectedIds)).map(x => parseInt(x, 10)).filter(Boolean);
    if (ids.length < 2) {
      setToast({ type: 'error', message: 'Selecione pelo menos 2 requisições para o reporte combinado.' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/reporte-dados-multi', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
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
        title: `Reporte (Multi: ${ids.length} requisição(ões))`,
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

  const handleExportClog = async (req) => {
    const reqId = req?.id;
    if (!reqId) {
      setToast({ type: 'error', message: 'Requisição inválida' });
      return;
    }
    if (!String(req?.tra_numero || '').trim()) {
      setToast({ type: 'error', message: 'Guarde o Nº TRA antes de abrir o Clog.' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/clog-dados`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao obter dados do Clog');
      }
      const data = await response.json();
      setReporteModal({
        open: true,
        title: `Clog (Requisição #${reqId})`,
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

  const handleExportMultiClog = async (idsArg) => {
    const ids = Array.from(new Set(idsArg || selectedIds)).map(x => parseInt(x, 10)).filter(Boolean);
    if (ids.length < 2) {
      setToast({ type: 'error', message: 'Selecione pelo menos 2 requisições para o Clog combinado.' });
      return;
    }
    const targets = ids.map(id => requisicoes.find(x => x.id === id)).filter(Boolean);
    const semNumeroTra = targets.some((r) => !String(r?.tra_numero || '').trim());
    if (semNumeroTra) {
      setToast({ type: 'error', message: 'Preencha e guarde o Nº TRA em todas as requisições antes de abrir o Clog combinado.' });
      return;
    }
    try {
      setReporteLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/clog-dados-multi', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
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
        title: `Clog (Multi: ${ids.length} requisição(ões))`,
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

      const isClog = reporteModal.kind === 'clog';
      const headerLine = columns.join('\t');
      const bodyLines = reporteModal.rows.map(r => columns.map(c => (r?.[c] ?? '').toString().replace(/\r?\n/g, ' ')).join('\t'));
      const tsv = isClog ? bodyLines.join('\n') : [headerLine, ...bodyLines].join('\n');

      const escapeHtml = (val) => String(val ?? '')
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
              ${columns.map((c) => `<th style="border:1px solid #000; padding:4px 6px; background:#f2f2f2; font-weight:bold; text-align:center; white-space:nowrap;">${escapeHtml(c)}</th>`).join('')}
            </tr>
          </thead>
        `;
      const htmlTable = `
        <table style="border-collapse:collapse; font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
          ${htmlHeader}
          <tbody>
            ${reporteModal.rows.map((r) => {
              const isSepReporte = String(r?.Artigo ?? '').startsWith('--- Requisição #');
              const isSepClog = String(r?.['REF.'] ?? '').startsWith('--- Requisição #');
              const isSep = isSepReporte || isSepClog;
              const trStyle = isSep ? 'background:#f2f2f2; font-weight:bold;' : '';
              return `
                <tr style="${trStyle}">
                  ${columns.map((c) => {
                    const v = r?.[c] ?? '';
                    const align =
                      c === 'Descrição' ||
                      c === 'DESCRIPTION' ||
                      c === 'Observações' ||
                      c === 'DESCRIÇÃO' ||
                      c === 'Localização destino'
                        ? 'left'
                        : 'center';
                    return `<td style="border:1px solid #000; padding:4px 6px; text-align:${align}; vertical-align:top;">${escapeHtml(v)}</td>`;
                  }).join('')}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `.trim();

      // Outlook costuma pastar melhor quando recebemos HTML além de texto.
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
            : reporteModal.kind === 'reporte-recebimento'
              ? 'Tabela do reporte de recebimento copiada (para colar no Outlook).'
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
      const isReceb = reporteModal.kind === 'reporte-recebimento';
      if (reporteModal.mode === 'single') {
        const reqId = reporteModal.reqId;
        if (isReceb) {
          await downloadExport(
            `/api/requisicoes/transferencias/recebimento/${reqId}/export-reporte`,
            `MATERIAL_RECEBIDO_requisicao_${reqId}_${dateStr}.xlsx`,
            'Ficheiro de reporte gerado com sucesso.'
          );
          await fetchRequisicoes();
        } else {
          await downloadExport(
            isClog ? `/api/requisicoes/${reqId}/export-clog` : `/api/requisicoes/${reqId}/export-reporte`,
            isClog ? `CLOG_requisicao_${reqId}_${dateStr}.xlsx` : `REPORTE_requisicao_${reqId}_${dateStr}.xlsx`,
            isClog ? 'Ficheiro Clog gerado com sucesso.' : 'Ficheiro de reporte gerado com sucesso.'
          );
        }
      } else {
        const ids = Array.isArray(reporteModal.ids) ? reporteModal.ids : [];
        const token = localStorage.getItem('token');
        if (isReceb) {
          throw new Error('Exportação combinada não disponível para reporte de recebimento.');
        }
        const res = await fetch(isClog ? '/api/requisicoes/export-clog-multi' : '/api/requisicoes/export-reporte-multi', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ids })
        });
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

  const handleToggleSelect = (id, checked) => {
    setSelectedIds(prev => {
      let next;
      if (checked) {
        next = [...new Set([...prev, id])];
      } else {
        next = prev.filter(x => x !== id);
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

  const getStatusBadge = (status) => {
    const badges = {
      pendente: 'bg-yellow-100 text-yellow-800',
      'EM SEPARACAO': 'bg-orange-100 text-orange-900',
      separado: 'bg-green-100 text-green-800',
      'EM EXPEDICAO': 'bg-blue-100 text-blue-800',
      Entregue: 'bg-emerald-100 text-emerald-800',
      FINALIZADO: 'bg-slate-200 text-slate-900',
      cancelada: 'bg-red-100 text-red-800'
    };
    return badges[status] || 'bg-gray-100 text-gray-800';
  };

  const getStatusLabel = (status) => {
    const labels = {
      pendente: 'Pendente',
      'EM SEPARACAO': 'Em separação',
      separado: 'Separadas',
      'EM EXPEDICAO': 'Em expedição',
      Entregue: 'Entregue',
      FINALIZADO: 'Finalizado',
      cancelada: 'Cancelada'
    };
    return labels[status] || status;
  };

  const canDeleteRequisicao = (reqObj) => {
    if (!canDelete) return false;
    const status = String(reqObj?.status || '');
    const precisaAdmin = ['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'Entregue'].includes(status);
    return !precisaAdmin || user?.role === 'admin';
  };

  const isFluxoRecebimentoMercadoria = (reqObj) => {
    const obs = String(reqObj?.observacoes || '').toUpperCase();
    if (!obs.startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER)) return false;
    // Qualquer tarefa marcada como recebimento de transferência
    // (manual/GT ou espelho automático) deve entrar no fluxo de recebimento.
    return true;
  };

  const recebimentoEntregaConfirmada = (reqObj) => Boolean(reqObj?.recebimento_entrega_confirmada);
  const recebimentoTraConfirmada = (reqObj) => Boolean(reqObj?.recebimento_tra_confirmada);
  const recebimentoAguardandoTraOrigem = (reqObj) => Boolean(reqObj?.aguardando_tra_origem);
  const recebimentoPodeConfirmarTra = (reqObj) => Boolean(reqObj?.pode_confirmar_tra);
  const recebimentoPodeFinalizar = (reqObj) => Boolean(reqObj?.pode_finalizar_recebimento);

  const getRecebimentoFase = (reqObj) => {
    if (!isFluxoRecebimentoMercadoria(reqObj)) return '';
    if (!recebimentoEntregaConfirmada(reqObj)) return 'Aguardando confirmação de entrega';
    if (recebimentoAguardandoTraOrigem(reqObj)) return 'Aguardando TRA da origem';
    if (recebimentoTraConfirmada(reqObj)) return 'TRA confirmada';
    if (recebimentoPodeConfirmarTra(reqObj)) return 'Pronto para confirmar TRA';
    return '';
  };

  const isFluxoCentralApeadoSemTrfl = (reqObj) => {
    const origem = String(reqObj?.armazem_origem_tipo || '').trim().toLowerCase();
    const destino = String(reqObj?.armazem_destino_tipo || '').trim().toLowerCase();
    return origem === 'central' && destino === 'apeado';
  };

  const isAguardandoRececao = (reqObj) =>
    String(reqObj?.recepcao_status || '').toUpperCase() === 'AGUARDANDO_RECECAO';

  const getRececaoLabel = (reqObj) => {
    const st = String(reqObj?.recepcao_status || '').toUpperCase();
    if (st === 'AGUARDANDO_RECECAO') return 'Aguardando receção';
    if (st === 'RECECIONADA_TOTAL') return 'Rececionada: total';
    if (st === 'RECECIONADA_PARCIAL') return 'Rececionada: parcial';
    return '';
  };

  const rececaoConcluidaOrigem = (reqObj) => {
    const st = String(reqObj?.recepcao_status || '').toUpperCase();
    return st === 'RECECIONADA_TOTAL' || st === 'RECECIONADA_PARCIAL';
  };

  const podeGerarTraAposRececao = (reqObj) => {
    if (!reqObj || isFluxoRecebimentoMercadoria(reqObj)) return false;
    if (String(reqObj?.tra_gerada_em || '').trim()) return false;
    const status = String(reqObj?.status || '');
    if (status === 'Entregue') return true;
    // Fluxo central->central: após receção confirmada no destino, pode gerar TRA mesmo em EM_EXPEDICAO.
    return status === 'EM EXPEDICAO' && rececaoConcluidaOrigem(reqObj);
  };

  const getEpiColaboradorFromObs = (reqObj) => {
    const destinoTipo = String(reqObj?.armazem_destino_tipo || '').trim().toLowerCase();
    if (destinoTipo !== 'epi') return { nome: '', numero: '' };
    const obs = String(reqObj?.observacoes || '');
    if (!obs) return { nome: '', numero: '' };

    const nomeMatch = /(?:^|\|)\s*Colaborador:\s*([^|]+)/i.exec(obs);
    const numeroMatch = /(?:^|\|)\s*Nr\.?\s*Colab\.?:\s*([^|]+)/i.exec(obs);
    return {
      nome: (nomeMatch?.[1] || '').trim(),
      numero: (numeroMatch?.[1] || '').trim(),
    };
  };

  const normalize = (v) => String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const requisicoesPorFluxo = (() => {
    const temMap = armazensById && Object.keys(armazensById).length > 0;
    if (!temMap) return requisicoes;
    const flowFilter = hasFluxoTransferSelecionado ? flowParam : '';

    const getFluxoTransferencia = (req) => {
      if (isFluxoRecebimentoMercadoria(req)) return 'recebimento';
      const tipoOrigem = armazensById[Number(req?.armazem_origem_id)] || '';
      const tipoDestino = armazensById[Number(req?.armazem_id)] || '';
      if (
        (tipoOrigem === 'central' && tipoDestino === 'apeado') ||
        (tipoOrigem === 'apeado' && tipoDestino === 'central')
      ) {
        return 'apeados';
      }
      if (tipoOrigem === 'central' && tipoDestino === 'central') {
        return 'centrais';
      }
      return '';
    };

    return requisicoes.filter((req) => {
      const fluxoTransfer = getFluxoTransferencia(req);
      const isTransfer = Boolean(fluxoTransfer);
      if (!isModoTransferencias) return !isTransfer;
      if (!flowFilter) return isTransfer;
      return fluxoTransfer === flowFilter;
    });
  })();

  const filteredRequisicoes = requisicoesPorFluxo.filter(req => {
    const raw = String(searchTerm || '').trim();
    if (!raw) return true;
    const searchLower = normalize(raw);
    const searchFlat = searchLower.replace(/[^a-z0-9]/g, '');

    const data = req.created_at ? new Date(req.created_at) : null;
    const dataBr = data && !Number.isNaN(data.getTime())
      ? `${String(data.getDate()).padStart(2, '0')}/${String(data.getMonth() + 1).padStart(2, '0')}/${data.getFullYear()}`
      : '';
    const dataIso = data && !Number.isNaN(data.getTime())
      ? data.toISOString().slice(0, 10)
      : '';

    const baseCampos = [
      req.id,
      req.status,
      req.armazem_descricao,
      req.armazem_origem_descricao,
      req.usuario_nome,
      req.criador_username,
      req.criador_numero_colaborador,
      req.separador_nome,
      req.observacoes,
      dataBr,
      dataIso
    ];

    // Extrai tokens de equipa/viatura para permitir buscas como "grd02"
    const equipeTokens = [];
    for (const campo of [req.armazem_descricao, req.armazem_origem_descricao]) {
      const txt = normalize(campo);
      if (!txt) continue;
      const partes = txt.split(/[\s-]+/).filter(Boolean);
      for (const p of partes) {
        equipeTokens.push(p);
        const sub = p.split('_');
        if (sub.length > 1) equipeTokens.push(sub[sub.length - 1]); // ex: con_grd02 -> grd02
      }
    }

    const itensTextos = (req.itens || []).flatMap(item => [item.item_codigo, item.item_descricao]);
    const campos = [...baseCampos, ...equipeTokens, ...itensTextos];

    return campos.some((campo) => {
      const n = normalize(campo);
      if (!n) return false;
      if (n.includes(searchLower)) return true;
      const nFlat = n.replace(/[^a-z0-9]/g, '');
      return Boolean(searchFlat) && nFlat.includes(searchFlat);
    });
  });

  const requisicoesOrdenadas = [...filteredRequisicoes].sort((a, b) => {
    if (filtros.status) {
      if (String(filtros.status) === 'FINALIZADO') {
        // Finalizados: mais recentes primeiro.
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      // FIFO nos demais status: mais antigas primeiro.
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const statusCards = isModoTransferencias && flowParam === 'recebimento'
    ? [
        { key: 'pendente', label: 'Pendentes', color: 'bg-yellow-50 border-yellow-200 text-yellow-800' },
        { key: 'EM EXPEDICAO', label: 'Em processo', color: 'bg-orange-50 border-orange-200 text-orange-900' },
        { key: 'FINALIZADO', label: 'Finalizadas', color: 'bg-slate-50 border-slate-300 text-slate-800' },
      ]
    : [
        { key: 'pendente', label: 'Pendentes', color: 'bg-yellow-50 border-yellow-200 text-yellow-800' },
        { key: 'EM SEPARACAO', label: 'Em separação', color: 'bg-orange-50 border-orange-200 text-orange-900' },
        { key: 'separado', label: 'Separadas', color: 'bg-green-50 border-green-200 text-green-800' },
        { key: 'EM EXPEDICAO', label: 'Em expedição', color: 'bg-blue-50 border-blue-200 text-blue-800' },
        { key: 'Entregue', label: 'Entregues', color: 'bg-emerald-50 border-emerald-200 text-emerald-800' },
        { key: 'FINALIZADO', label: 'Finalizadas', color: 'bg-slate-50 border-slate-300 text-slate-800' },
        { key: 'cancelada', label: 'Canceladas', color: 'bg-red-50 border-red-200 text-red-800' }
      ];
  const countsByStatus = requisicoesPorFluxo.reduce((acc, r) => {
    const s = r.status || 'pendente';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto"></div>
          <p className="mt-4 text-gray-600">Carregando requisições...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {semArmazemOrigemAtribuido && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <strong>Sem armazéns atribuídos.</strong> Não pode ver nem trabalhar com requisições até um administrador associar pelo menos um armazém de origem (central, viatura, APEADO ou EPI) ao seu utilizador.
          </div>
        )}
        {/* Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
              {isModoTransferencias ? 'Transferências' : 'Requisições'}
            </h1>
            <p className="text-gray-600">
              {showStatusBoard
                ? 'Selecione um status para abrir a lista e gerir por FIFO.'
                : `Lista de ${isModoTransferencias ? 'transferências' : 'requisições'}${filtros.status ? ` (${getStatusLabel(filtros.status)})` : ''}.`}
            </p>
          </div>
          {podeCriarOuImportarRequisicao && (
            <div className="flex flex-wrap gap-2 justify-end">
              {isModoTransferencias && showStatusBoard && hasFluxoTransferSelecionado && (
                <button
                  type="button"
                  onClick={() => {
                    navigate('/transferencias');
                    setSelectionMode(false);
                    setSelectedIds([]);
                    setSearchTerm('');
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                >
                  Voltar seleção de fluxo
                </button>
              )}
              {selectionMode && selectedIds.length > 0 && (
                <>
                  {selectedIds.length >= 2 && (
                    <>
                      <button
                        type="button"
                        onClick={handleExportMultiTRFL}
                        className="inline-flex items-center gap-2 px-3 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 text-sm"
                      >
                        GERAR TRFL (combinado)
                      </button>
                      <button
                        type="button"
                        onClick={handleExportMultiTRA}
                        className="inline-flex items-center gap-2 px-3 py-2 border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 text-sm"
                      >
                        GERAR TRA (combinado)
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => { setSelectionMode(false); setSelectedIds([]); }}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
                  >
                    Limpar seleção
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  if (isModoTransferencias && flowParam === 'recebimento') {
                    navigate('/transferencias?recebimento=1');
                    return;
                  }
                  navigate('/requisicoes/importar');
                }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors text-sm"
              >
                <FaFileImport /> {isModoTransferencias && flowParam === 'recebimento' ? 'Importar Guia AT' : 'Importar requisição'}
              </button>
              <Link
                to={
                  isModoTransferencias && flowParam === 'recebimento'
                    ? '/transferencias?recebimento=1'
                    : isModoTransferencias
                      ? createTransferLink
                      : '/requisicoes/criar'
                }
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors"
              >
                <FaPlus /> {isModoTransferencias ? 'Nova Transferência' : 'Nova Requisição'}
              </Link>
            </div>
          )}
        </div>

        {isModoTransferencias && showStatusBoard && (
          <div className="mb-6 grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-5 h-fit">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-gray-800">Tipo de transferência</h2>
                <p className="text-sm text-gray-600">Selecione uma opção para continuar.</p>
              </div>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => navigate('/transferencias?fluxo=centrais')}
                  className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                    flowParam === 'centrais'
                      ? 'border-[#0915FF] bg-blue-50'
                      : 'border-gray-300 bg-white hover:border-[#0915FF] hover:bg-blue-50/40'
                  }`}
                >
                  <div className="text-sm font-semibold text-gray-900">Entre armazéns centrais</div>
                  <div className="mt-0.5 text-xs text-gray-600">Fluxo Central -> Central</div>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/transferencias?fluxo=apeados')}
                  className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                    flowParam === 'apeados'
                      ? 'border-[#0915FF] bg-blue-50'
                      : 'border-gray-300 bg-white hover:border-[#0915FF] hover:bg-blue-50/40'
                  }`}
                >
                  <div className="text-sm font-semibold text-gray-900">Transferências para APEADOS</div>
                  <div className="mt-0.5 text-xs text-gray-600">{'Fluxo Central <-> APEADO'}</div>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/transferencias?fluxo=recebimento')}
                  className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                    flowParam === 'recebimento'
                      ? 'border-[#0915FF] bg-blue-50'
                      : 'border-gray-300 bg-white hover:border-[#0915FF] hover:bg-blue-50/40'
                  }`}
                >
                  <div className="text-sm font-semibold text-gray-900">Recebimento de mercadoria</div>
                  <div className="mt-0.5 text-xs text-gray-600">Importação de Guia AT e conferência em tarefa</div>
                </button>
                {podeTransferenciaLocalizacao && (
                  <button
                    type="button"
                    onClick={() => navigate('/transferencias/localizacao')}
                    className="w-full text-left rounded-lg border px-4 py-3 transition-colors border-gray-300 bg-white hover:border-emerald-600 hover:bg-emerald-50/50"
                  >
                    <div className="text-sm font-semibold text-gray-900">Transferência de localização</div>
                    <div className="mt-0.5 text-xs text-gray-600">
                      Mover stock entre localizações do mesmo central (controlo de stock)
                    </div>
                  </button>
                )}
                {podeConsultarMovimentos && (
                  <button
                    type="button"
                    onClick={() => navigate('/movimentos')}
                    className="w-full text-left rounded-lg border px-4 py-3 transition-colors border-gray-300 bg-white hover:border-[#0915FF] hover:bg-blue-50/40"
                  >
                    <div className="text-sm font-semibold text-gray-900">Consulta de movimentos</div>
                    <div className="mt-0.5 text-xs text-gray-600">
                      Histórico de abastecimentos no formato Clog com filtros avançados
                    </div>
                  </button>
                )}
              </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-5">
              {hasFluxoTransferSelecionado ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {statusCards.map((card) => {
                    const qty = countsByStatus[card.key] || 0;
                    return (
                      <button
                        key={card.key}
                        type="button"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (isModoTransferencias && hasFluxoTransferSelecionado) {
                            params.set('fluxo', flowParam);
                          }
                          params.set('status', card.key);
                          navigate(`${rotaBase}?${params.toString()}`);
                          setSelectionMode(false);
                          setSelectedIds([]);
                        }}
                        className={`text-left rounded-xl border p-5 shadow-sm hover:shadow-md transition-all ${card.color}`}
                      >
                        <div className="text-sm font-semibold opacity-90">{card.label}</div>
                        <div className="mt-2 text-3xl font-bold">{qty}</div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="h-full min-h-[180px] flex items-center justify-center text-center text-gray-500">
                  Selecione um tipo de transferência à esquerda para visualizar os cards de status.
                </div>
              )}
            </div>
          </div>
        )}

        {!showStatusBoard && (
          <div className="mb-3 sm:hidden">
            <button
              type="button"
              onClick={() => {
                const flowParam = String(new URLSearchParams(location.search || '').get('fluxo') || '').toLowerCase();
                if (isModoTransferencias && ['centrais', 'apeados', 'recebimento'].includes(flowParam)) {
                  navigate(`${rotaBase}?fluxo=${flowParam}`);
                } else {
                  navigate(rotaBase);
                }
                setSearchTerm('');
                setSelectionMode(false);
                setSelectedIds([]);
              }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Voltar aos status
            </button>
          </div>
        )}

        {showStatusBoard && !isModoTransferencias && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {statusCards.map((card) => {
              const qty = countsByStatus[card.key] || 0;
              return (
                <button
                  key={card.key}
                  type="button"
                  onClick={() => {
                    const params = new URLSearchParams();
                    if (isModoTransferencias && hasFluxoTransferSelecionado) {
                      params.set('fluxo', flowParam);
                    }
                    params.set('status', card.key);
                    navigate(`${rotaBase}?${params.toString()}`);
                    setSelectionMode(false);
                    setSelectedIds([]);
                  }}
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
          <>
        {/* Filtros e Busca */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row gap-4">
              {/* Busca */}
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
                  const flowParam = String(new URLSearchParams(location.search || '').get('fluxo') || '').toLowerCase();
                  if (isModoTransferencias && ['centrais', 'apeados', 'recebimento'].includes(flowParam)) {
                    navigate(`${rotaBase}?fluxo=${flowParam}`);
                  } else {
                    navigate(rotaBase);
                  }
                  setSearchTerm('');
                  setSelectionMode(false);
                  setSelectedIds([]);
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
        </div>

        {/* Lista de Requisições */}
        {requisicoesOrdenadas.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <p className="text-gray-500 text-lg">
              Nenhuma {isModoTransferencias ? 'transferência' : 'requisição'} encontrada
            </p>
            {podeCriarOuImportarRequisicao && (
              <Link
                to={isModoTransferencias ? createTransferLink : '/requisicoes/criar'}
                className="mt-4 inline-block text-[#0915FF] hover:underline"
              >
                Criar primeira {isModoTransferencias ? 'transferência' : 'requisição'}
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filtros.status && String(filtros.status) !== 'FINALIZADO' && (
              <div className="text-xs text-gray-600 px-1">
                FIFO ativo: listagem da mais antiga para a mais nova.
              </div>
            )}
            {requisicoesOrdenadas.map((req, idx) => {
              const prepBloqueio = preparacaoReservadaOutroUtilizador(req, user);
              const separadorNome =
                req.separador_nome != null && String(req.separador_nome).trim() !== ''
                  ? String(req.separador_nome).trim()
                  : null;
              return (
              <div
                key={req.id}
                className={`relative overflow-hidden rounded-lg border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
                  selectedIds.includes(req.id)
                    ? 'border-blue-500 bg-blue-50 shadow-md'
                    : req.status === 'FINALIZADO'
                      ? 'border-slate-300 bg-slate-50 shadow-sm opacity-80'
                      : 'border-gray-200 bg-white shadow-sm'
                }`}
                onContextMenu={(e) => handleContextMenu(e, req)}
              >
                {filtros.status && String(filtros.status) !== 'FINALIZADO' && (
                  <span className="absolute left-3 top-3 px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                    FIFO #{idx + 1}
                  </span>
                )}
                {(selectionMode || selectedIds.length > 0) && (
                  <input
                    type="checkbox"
                    className="absolute right-3 top-3 h-4 w-4"
                    checked={selectedIds.includes(req.id)}
                    onChange={(e) => {
                      e.stopPropagation();
                      handleToggleSelect(req.id, e.target.checked);
                    }}
                  />
                )}
                {/* Header da Requisição — clicável para selecionar em modo seleção */}
                <div
                  onClick={() => {
                    if (selectionMode || selectedIds.length > 0) {
                      const isSelected = selectedIds.includes(req.id);
                      handleToggleSelect(req.id, !isSelected);
                    } else if (prepBloqueio) {
                      setToast({
                        type: 'error',
                        message: `Esta requisição está reservada para separação (${separadorNome || 'outro operador'}).`
                      });
                    } else {
                      navigate(rotaPrepararComOrigem(req.id));
                    }
                  }}
                  className="p-6 cursor-pointer hover:bg-gray-50/50 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1">
                      <div>
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <span className="text-lg font-bold text-gray-900">#{req.id}</span>
                          <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadge(req.status)}`}>
                            {getStatusLabel(req.status)}
                          </span>
                          {selectedIds.includes(req.id) && (
                            <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-800 uppercase tracking-wide">
                              Selecionada
                            </span>
                          )}
                          {isRequisicaoDoUtilizadorAtual(req, user) && (
                            <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-violet-100 text-violet-800 uppercase tracking-wide">
                              Minha requisição
                            </span>
                          )}
                          {req.separador_usuario_id != null && separadorNome && (
                            <span
                              className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-amber-100 text-amber-900 uppercase tracking-wide"
                              title="Utilizador que iniciou a separação / preparação"
                            >
                              Separação: {separadorNome}
                            </span>
                          )}
                          {isFluxoRecebimentoMercadoria(req) && getRecebimentoFase(req) && (
                            <span
                              className={`px-2 py-0.5 text-[10px] font-semibold rounded-full uppercase tracking-wide ${
                                recebimentoAguardandoTraOrigem(req)
                                  ? 'bg-amber-100 text-amber-900'
                                  : recebimentoTraConfirmada(req)
                                    ? 'bg-emerald-100 text-emerald-900'
                                    : 'bg-indigo-100 text-indigo-900'
                              }`}
                            >
                              {getRecebimentoFase(req)}
                            </span>
                          )}
                          {getRececaoLabel(req) && (
                            <span
                              className={`px-2 py-0.5 text-[10px] font-semibold rounded-full uppercase tracking-wide ${
                                isAguardandoRececao(req)
                                  ? 'bg-amber-100 text-amber-900'
                                  : String(req?.recepcao_status || '').toUpperCase() === 'RECECIONADA_PARCIAL'
                                    ? 'bg-orange-100 text-orange-900'
                                    : 'bg-emerald-100 text-emerald-900'
                              }`}
                            >
                              {getRececaoLabel(req)}
                            </span>
                          )}
                          {req.itens && req.itens.length > 0 && (
                            <span className="text-xs text-gray-500">
                              {req.itens.length} {req.itens.length === 1 ? 'item' : 'itens'}
                            </span>
                          )}
                          {(req.status === 'pendente' || req.status === 'EM SEPARACAO') && canPrepare && !prepBloqueio && (
                            <span className="text-xs text-[#0915FF] flex items-center gap-1">
                              <FaBoxOpen />{' '}
                              {req.status === 'EM SEPARACAO' ? 'Separação em curso — use Continuar preparação' : 'Use o botão Preparar abaixo'}
                            </span>
                          )}
                          {(req.status === 'pendente' || req.status === 'EM SEPARACAO') && canPrepare && prepBloqueio && (
                            <span className="text-xs text-amber-700 flex items-center gap-1">
                              Em preparação por {separadorNome || 'outro operador'}
                            </span>
                          )}
                          {req.status === 'separado' && req.separacao_confirmada && req.separacao_confirmada_em && (
                            <span className="text-xs text-green-700 flex items-center gap-1">
                              <FaCheck /> Separação confirmada em {new Date(req.separacao_confirmada_em).toLocaleString('pt-BR')}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600 space-y-1">
                          {(() => {
                            const epiColab = getEpiColaboradorFromObs(req);
                            if (!epiColab.nome && !epiColab.numero) return null;
                            return (
                              <>
                                {epiColab.nome && (
                                  <div><strong>Colaborador:</strong> {epiColab.nome}</div>
                                )}
                                {epiColab.numero && (
                                  <div><strong>Nr. Colab.:</strong> {epiColab.numero}</div>
                                )}
                              </>
                            );
                          })()}
                          {(() => {
                            const isReceb = isFluxoRecebimentoMercadoria(req);
                            // No fluxo de recebimento, a modelagem usa:
                            // - armazem_origem_* = armazém de recebimento (destino real)
                            // - armazem_*        = armazém de envio (origem real)
                            const origemLabel = isReceb ? req.armazem_descricao : req.armazem_origem_descricao;
                            const destinoLabel = isReceb ? req.armazem_origem_descricao : req.armazem_descricao;
                            return (
                              <>
                                {origemLabel && (
                                  <div><strong>Origem:</strong> {origemLabel}</div>
                                )}
                                <div><strong>Destino:</strong> {destinoLabel}</div>
                              </>
                            );
                          })()}
                          {req.localizacao && (
                            <div><strong>Localização:</strong> {req.localizacao}</div>
                          )}
                          <div><strong>Criado por:</strong> {formatCriadorRequisicao(req)}</div>
                          <div><strong>Data:</strong> {new Date(req.created_at).toLocaleDateString('pt-BR')}</div>
                          {['Entregue', 'FINALIZADO'].includes(String(req.status || '')) && req.entregue_em && (
                            <div>
                              <strong>Entregue em:</strong>{' '}
                              {new Date(req.entregue_em).toLocaleString('pt-BR')}
                            </div>
                          )}
                          {req.status === 'FINALIZADO' && (req.finalizado_em || req.updated_at) && (
                            <div>
                              <strong>Finalizado em:</strong>{' '}
                              {new Date(req.finalizado_em || req.updated_at).toLocaleString('pt-BR')}
                            </div>
                          )}
                          {isFluxoRecebimentoMercadoria(req) && req.requisicao_origem_tra_numero && (
                            <div><strong>Nº TRA (origem):</strong> {req.requisicao_origem_tra_numero}</div>
                          )}
                          {isFluxoRecebimentoMercadoria(req) && recebimentoAguardandoTraOrigem(req) && (
                            <div><strong>TRA:</strong> Aguardando TRA da origem</div>
                          )}
                          {getRececaoLabel(req) && (
                            <div>
                              <strong>Receção:</strong> {getRececaoLabel(req)}
                            </div>
                          )}
                        </div>
                        {((!isFluxoRecebimentoMercadoria(req) && req.tra_gerada_em) ||
                          (isFluxoRecebimentoMercadoria(req) &&
                            recebimentoAguardandoTraOrigem(req) &&
                            !req.requisicao_origem_id)) && (
                          <div className="mt-3 flex items-end gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                            <div className="flex flex-col">
                              <label className="text-xs font-semibold text-gray-700 mb-1">Nº TRA</label>
                              <input
                                type="text"
                                value={String(traNumeroByReqId[req.id] ?? req.tra_numero ?? '')}
                                onChange={(e) => handleTraNumeroChange(req.id, e.target.value)}
                                placeholder="Digite o número da TRA"
                                disabled={savingTraReqId === req.id || req.status === 'FINALIZADO'}
                                className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-[220px] focus:ring-2 focus:ring-[#0915FF] focus:border-transparent disabled:bg-gray-100 disabled:text-gray-500"
                              />
                            </div>
                            {req.status !== 'FINALIZADO' && (
                              <button
                                type="button"
                                onClick={() => handleGuardarTraNumero(req)}
                                disabled={savingTraReqId === req.id}
                                className="px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 text-sm hover:bg-indigo-50 disabled:opacity-50"
                              >
                                {savingTraReqId === req.id ? 'A guardar...' : 'Guardar Nº TRA'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  <div className="flex gap-2 mt-4 sm:mt-0 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    {isFluxoRecebimentoMercadoria(req) &&
                      canDocsELogisticaPosSeparacao &&
                      req.status === 'EM EXPEDICAO' &&
                      !recebimentoEntregaConfirmada(req) && (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleConfirmarEntregaRecebimento(req.id)}
                        className={`px-3 py-2 rounded-lg bg-amber-600 text-white transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-amber-700'
                        }`}
                        title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Confirmar receção no recebimento'}
                      >
                        CONFIRMAR RECEÇÃO
                      </button>
                    )}
                    {isFluxoRecebimentoMercadoria(req) &&
                      canDocsELogisticaPosSeparacao &&
                      req.status === 'EM EXPEDICAO' &&
                      recebimentoPodeConfirmarTra(req) && (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleConfirmarTraRecebimento(req.id)}
                        className={`px-3 py-2 rounded-lg bg-indigo-600 text-white transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-700'
                        }`}
                        title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Confirmar TRA da origem'}
                      >
                        CONFIRMAR TRA
                      </button>
                    )}
                    {isFluxoRecebimentoMercadoria(req) &&
                      canDocsELogisticaPosSeparacao &&
                      req.status === 'EM EXPEDICAO' &&
                      podeUsarControloStock(user) &&
                      req.tra_gerada_em &&
                      !req.tra_baixa_expedicao_aplicada_em && (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleReceberStockRecebimento(req.id)}
                        className={`px-3 py-2 rounded-lg bg-[#0915FF] text-white transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[#070FCC]'
                        }`}
                        title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Receber stock na localização de recebimento'}
                      >
                        Receber stock
                      </button>
                    )}
                    {isFluxoRecebimentoMercadoria(req) &&
                      canDocsELogisticaPosSeparacao &&
                      req.status === 'EM EXPEDICAO' &&
                      recebimentoPodeFinalizar(req) && (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleFinalizarRecebimento(req.id)}
                        className={`px-3 py-2 bg-slate-700 text-white rounded-lg transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-800'
                        }`}
                        title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Marcar como Finalizado'}
                      >
                        Finalizar
                      </button>
                    )}
                    {canDocsELogisticaPosSeparacao &&
                    !isFluxoRecebimentoMercadoria(req) &&
                    (req.status === 'separado' && req.separacao_confirmada) &&
                    !isFluxoCentralApeadoSemTrfl(req) ? (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleExportTRFL(req)}
                        className={`px-3 py-2 text-blue-700 rounded-lg border border-blue-300 transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-50'
                        }`}
                        title={
                          prepBloqueio
                            ? 'Reservada para separação a outro operador'
                            : 'Gerar TRFL — após confirmar, o status passará a Em expedição'
                        }
                      >
                        GERAR TRFL
                      </button>
                    ) : null}
                    {canPrepare && !isFluxoRecebimentoMercadoria(req) && req.status === 'EM EXPEDICAO' && (
                      <button
                        type="button"
                        disabled={prepBloqueio || isAguardandoRececao(req)}
                        onClick={() => handleEntregar(req)}
                        className={`px-3 py-2 bg-amber-600 text-white rounded-lg transition-colors ${
                          prepBloqueio || isAguardandoRececao(req) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-amber-700'
                        }`}
                        title={
                          prepBloqueio
                            ? 'Reservada para separação a outro operador'
                            : isAguardandoRececao(req)
                              ? 'Aguardando receção no armazém destino'
                              : 'Encaminhar para recebimento no destino'
                        }
                      >
                        {isAguardandoRececao(req) ? 'AGUARDANDO RECEÇÃO' : 'ENTREGAR'}
                      </button>
                    )}
                    {canDocsELogisticaPosSeparacao &&
                    !isFluxoRecebimentoMercadoria(req) &&
                    ((podeGerarTraAposRececao(req) ||
                      (isFluxoCentralApeadoSemTrfl(req) && req.status === 'separado' && req.separacao_confirmada && !req.tra_gerada_em))) && (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleExportTRA(req)}
                        className={`px-3 py-2 text-indigo-700 rounded-lg border border-indigo-300 transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-50'
                        }`}
                        title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Gerar TRA'}
                      >
                        GERAR TRA
                      </button>
                    )}
                    {canDocsELogisticaPosSeparacao &&
                    !isFluxoRecebimentoMercadoria(req) &&
                    ((req.status === 'Entregue' && req.tra_gerada_em) ||
                      (isFluxoCentralApeadoSemTrfl(req) && req.status === 'separado' && req.tra_gerada_em)) &&
                    String(req.tra_numero || '').trim() && (
                      <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleFinalizar(req.id)}
                        className={`px-3 py-2 bg-slate-700 text-white rounded-lg transition-colors ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-800'
                        }`}
                        title={prepBloqueio ? 'Reservada para separação a outro operador' : 'Marcar como Finalizado'}
                      >
                        Finalizar
                      </button>
                    )}
                    {/* Re-download TRFL/TRA fica apenas no menu de contexto */}
                    {req.status === 'separado' && !req.separacao_confirmada && canPrepare && !isFluxoRecebimentoMercadoria(req) && (
                        <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => handleConfirmarSeparacao(req.id)}
                        className={`px-3 py-2 bg-emerald-600 text-white rounded-lg transition-colors flex items-center gap-2 ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-700'
                        }`}
                        title={
                          prepBloqueio
                            ? 'Reservada para separação a outro operador'
                            : 'Confirmar que os itens foram recolhidos (obrigatório antes de TRFL)'
                        }
                      >
                        <FaCheck /> Confirmar separação
                      </button>
                    )}
                    {(req.status === 'pendente' || req.status === 'EM SEPARACAO') && canPrepare && (
                        <button
                        type="button"
                        disabled={prepBloqueio}
                        onClick={() => navigate(rotaPrepararComOrigem(req.id))}
                        className={`px-3 py-2 bg-green-600 text-white rounded-lg transition-colors flex items-center gap-2 ${
                          prepBloqueio ? 'opacity-50 cursor-not-allowed' : 'hover:bg-green-700'
                        }`}
                        title={
                          prepBloqueio
                            ? `Em preparação por ${separadorNome || 'outro operador'}`
                            : req.status === 'EM SEPARACAO' ? 'Continuar separação' : 'Abrir preparação'
                        }
                      >
                        <FaBoxOpen /> {req.status === 'EM SEPARACAO' ? 'Continuar preparação' : 'Preparar'}
                      </button>
                    )}
                    {req.status === 'pendente' && podeCriarOuImportarRequisicao && !isFluxoRecebimentoMercadoria(req) && (
                      <button
                        onClick={() => navigate(`/requisicoes/editar/${req.id}`)}
                        className="px-3 py-2 text-[#0915FF] hover:bg-[#0915FF] hover:text-white rounded-lg transition-colors"
                        title="Editar"
                      >
                        <FaEdit />
                      </button>
                    )}
                    {canDeleteRequisicao(req) && (
                      <button
                        onClick={() => handleDelete(req.id)}
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
          </>
        )}

        {/* Context menu para requisições (clique direito) */}
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
                    message: `Esta requisição está reservada para separação (${nome}).`
                  });
                  setContextMenu(prev => ({ ...prev, visible: false }));
                  return;
                }
                navigate(rotaPrepararComOrigem(contextMenu.req.id));
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Abrir
            </button>
            {podeCriarOuImportarRequisicao && (
              <button
                className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                onClick={() => {
                  setSelectionMode(true);
                  setSelectedIds(prev =>
                    prev.includes(contextMenu.req.id) ? prev : [...prev, contextMenu.req.id]
                  );
                  setContextMenu(prev => ({ ...prev, visible: false }));
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
                  setContextMenu(prev => ({ ...prev, visible: false }));
                }}
              >
                Editar
              </button>
            )}
            {canPrepare && (() => {
              const { ids, reqs, complete } = getActionTargetReqs(contextMenu.req);
              const isMulti = ids.length >= 2;
              const all = (pred) => complete && reqs.every(pred);
              const algumaPrepBloqueio = complete && reqs.some(r => preparacaoReservadaOutroUtilizador(r, user));

              const canGerarTRFL = all(r => r.status === 'separado' && r.separacao_confirmada);
              const canBaixarTRFL = all(r => ['EM EXPEDICAO', 'Entregue', 'FINALIZADO'].includes(r.status));

              const canEntregar = all(r => r.status === 'EM EXPEDICAO' && !isAguardandoRececao(r));

              const canGerarTRA = all(r => podeGerarTraAposRececao(r));
              const canBaixarTRA = all(r => (r.status === 'Entregue' && r.tra_gerada_em) || r.status === 'FINALIZADO');
              const canGerarReporte = all(r => (r.status === 'Entregue' && r.tra_gerada_em) || r.status === 'FINALIZADO');
              const canVoltarEmExpedicao = all(
                (r) =>
                  String(r?.status || '') === 'Entregue' &&
                  !r?.tra_gerada_em &&
                  !isFluxoRecebimentoMercadoria(r)
              );
              const canGerarClog = all(
                (r) =>
                  ((r.status === 'Entregue' && r.tra_gerada_em) || r.status === 'FINALIZADO') &&
                  String(r.tra_numero || '').trim()
              );

              const canBaixarComprovativo = all(r => ['Entregue', 'FINALIZADO'].includes(r.status));
              const canFinalizar = all(
                (r) => r.status === 'Entregue' && r.tra_gerada_em && String(r.tra_numero || '').trim()
              );

              const ctxTrflGerarBloqueado = Boolean(canGerarTRFL && algumaPrepBloqueio);
              const ctxTraGerarBloqueado = Boolean(canGerarTRA && algumaPrepBloqueio);
              const ctxEntregarBloqueado = Boolean(canEntregar && algumaPrepBloqueio);
              const ctxVoltarExpedicaoBloqueado = Boolean(canVoltarEmExpedicao && algumaPrepBloqueio);
              const ctxFinalizarBloqueado = Boolean(canFinalizar && algumaPrepBloqueio);

              return (
                <>
                  {(canDocsELogisticaPosSeparacao && (canGerarTRFL || canBaixarTRFL)) && (
                    <button
                      type="button"
                      disabled={ctxTrflGerarBloqueado}
                      className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                        ctxTrflGerarBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title={ctxTrflGerarBloqueado ? 'Reservada para separação a outro operador' : undefined}
                      onClick={() => {
                        if (isMulti) {
                          handleExportMultiTRFL(ids, { redownload: canBaixarTRFL && !canGerarTRFL });
                        } else {
                          handleExportTRFL(contextMenu.req, { redownload: canBaixarTRFL && !canGerarTRFL });
                        }
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      {canGerarTRFL ? 'GERAR TRFL' : 'Baixar TRFL'}
                    </button>
                  )}

                  {canEntregar && (
                    <button
                      type="button"
                      disabled={ctxEntregarBloqueado}
                      className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                        ctxEntregarBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title={ctxEntregarBloqueado ? 'Reservada para separação a outro operador' : undefined}
                      onClick={() => {
                        if (isMulti) handleEntregarMulti(ids);
                        else handleEntregar(contextMenu.req);
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      ENTREGAR
                    </button>
                  )}

                  {canVoltarEmExpedicao && (
                    <button
                      type="button"
                      disabled={ctxVoltarExpedicaoBloqueado}
                      className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                        ctxVoltarExpedicaoBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title={ctxVoltarExpedicaoBloqueado ? 'Reservada para separação a outro operador' : undefined}
                      onClick={() => {
                        if (isMulti) {
                          setToast({ type: 'error', message: 'Voltar para Em expedição está disponível apenas para uma requisição por vez.' });
                        } else {
                          handleVoltarEmExpedicao(contextMenu.req);
                        }
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      VOLTAR PARA EXPEDIÇÃO
                    </button>
                  )}

                  {(canDocsELogisticaPosSeparacao && (canGerarTRA || canBaixarTRA)) && (
                    <button
                      type="button"
                      disabled={ctxTraGerarBloqueado}
                      className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                        ctxTraGerarBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title={ctxTraGerarBloqueado ? 'Reservada para separação a outro operador' : undefined}
                      onClick={() => {
                        if (isMulti) {
                          handleExportMultiTRA(ids, { redownload: canBaixarTRA && !canGerarTRA });
                        } else {
                          handleExportTRA(contextMenu.req, { redownload: canBaixarTRA && !canGerarTRA });
                        }
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      {canGerarTRA ? 'GERAR TRA' : 'Baixar TRA'}
                    </button>
                  )}

                  {canDocsELogisticaPosSeparacao && canGerarReporte && (
                    <button
                      className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                      onClick={() => {
                        if (isMulti) handleExportMultiReporte(ids);
                        else handleExportReporte(contextMenu.req);
                        setContextMenu(prev => ({ ...prev, visible: false }));
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
                        setContextMenu(prev => ({ ...prev, visible: false }));
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
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      Baixar comprovativo de entrega
                    </button>
                  )}

                  {canDocsELogisticaPosSeparacao && canFinalizar && (
                    <button
                      type="button"
                      disabled={ctxFinalizarBloqueado}
                      className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                        ctxFinalizarBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title={ctxFinalizarBloqueado ? 'Reservada para separação a outro operador' : undefined}
                      onClick={() => {
                        if (isMulti) handleFinalizarMulti(ids);
                        else handleFinalizar(contextMenu.req.id);
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      Finalizar
                    </button>
                  )}
                </>
              );
            })()}
            {canDocsELogisticaPosSeparacao &&
              (() => {
                const { reqs, complete } = getActionTargetReqs(contextMenu.req);
                if (!complete || reqs.length !== 1) return null;
                const r = reqs[0];
                if (
                  !isFluxoRecebimentoMercadoria(r) ||
                  r.status !== 'EM EXPEDICAO' ||
                  !recebimentoEntregaConfirmada(r)
                ) {
                  return null;
                }
                const ctxRecebReporteBloqueado = preparacaoReservadaOutroUtilizador(r, user);
                return (
                  <button
                    type="button"
                    disabled={ctxRecebReporteBloqueado}
                    className={`block w-full text-left px-4 py-2 hover:bg-gray-100 ${
                      ctxRecebReporteBloqueado ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                    title={
                      ctxRecebReporteBloqueado
                        ? 'Reservada para separação a outro operador'
                        : 'Reporte: COD, DESCRIÇÃO, QTD, S/N, LOTE, localização destino'
                    }
                    onClick={() => {
                      handleReporteRecebimentoModal(r);
                      setContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                  >
                    Reporte
                  </button>
                );
              })()}
            {(() => {
              const { reqs, complete } = getActionTargetReqs(contextMenu.req);
              const canDeleteCtx = complete && reqs.length > 0 && reqs.every(canDeleteRequisicao);
              if (!canDeleteCtx) return null;
              return (
              <button
                className="block w-full text-left px-4 py-2 hover:bg-red-50 text-red-600"
                onClick={() => {
                  const ids = getActionTargetIds(contextMenu.req);
                  // confirmar uma vez para todas
                  (async () => {
                    for (const id of ids) {
                      await handleDelete(id);
                    }
                  })();
                  setContextMenu(prev => ({ ...prev, visible: false }));
                }}
              >
                Excluir requisição
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

        {/* Toast */}
        {toast && (
          <Toast
            type={toast.type}
            message={toast.message}
            onClose={() => setToast(null)}
          />
        )}
      </div>
    </div>
  );
};

export default ListarRequisicoes;
