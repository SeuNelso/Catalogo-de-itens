import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaSearch, FaPlus, FaEdit, FaTrash, FaFilter, FaBoxOpen, FaChevronDown, FaChevronUp, FaCheck, FaFileImport } from 'react-icons/fa';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const ListarRequisicoes = () => {
  const [requisicoes, setRequisicoes] = useState([]);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filtros, setFiltros] = useState({
    status: '',
    armazem_id: ''
  });
  const [armazens, setArmazens] = useState([]);
  const [mostrarFiltros, setMostrarFiltros] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, req: null });
  const contextMenuRef = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canCreateOrEdit = user && ['admin', 'controller', 'backoffice_operations', 'backoffice_armazem'].includes(user.role);
  const canDelete = user && ['admin', 'controller', 'backoffice_armazem'].includes(user.role);
  const canPrepare = user && ['admin', 'controller', 'operador', 'backoffice_armazem'].includes(user.role);

  useEffect(() => {
    fetchArmazens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchRequisicoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtros]);

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

  const fetchArmazens = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/armazens?ativo=true', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setArmazens(data);
      }
    } catch (error) {
      console.error('Erro ao buscar armazéns:', error);
    }
  };

  const fetchRequisicoes = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      const params = new URLSearchParams();
      if (filtros.status) params.append('status', filtros.status);
      if (filtros.armazem_id) params.append('armazem_id', filtros.armazem_id);

      const response = await fetch(`/api/requisicoes?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setRequisicoes(data);
        return data;
      } else {
        setToast({ type: 'error', message: 'Erro ao carregar requisições' });
        return null;
      }
    } catch (error) {
      console.error('Erro ao buscar requisições:', error);
      setToast({ type: 'error', message: 'Erro ao carregar requisições' });
      return null;
    } finally {
      setLoading(false);
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
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFontSize(16);
    doc.text('Comprovativo de Entrega', pageWidth / 2, 48, { align: 'center' });
    doc.setFontSize(10);
    doc.text(`Data: ${today.toLocaleString('pt-BR')}`, 40, 66);

    let cursorY = 90;

    arr.forEach((req, idx) => {
      if (idx > 0) cursorY += 18;
      const id = req?.id ?? '';
      const origem = req?.armazem_origem_descricao || '';
      const destino = req?.armazem_descricao || '';

      doc.setFontSize(12);
      doc.text(`Requisição #${id}`, 40, cursorY);
      doc.setFontSize(10);
      doc.text(`Origem: ${origem}`, 40, cursorY + 14);
      doc.text(`Destino: ${destino}`, 40, cursorY + 28);

      const itens = Array.isArray(req?.itens) ? req.itens : [];
      const body = [];
      for (const it of itens) {
        const codigo = String(it.item_codigo ?? it.codigo ?? '');
        const desc = String(it.item_descricao ?? it.descricao ?? '');
        const qtyBase = it.quantidade_preparada ?? it.quantidade ?? 0;
        const qty = Number(qtyBase) || 0;

        const bobinas = Array.isArray(it.bobinas) ? it.bobinas : [];
        if (bobinas.length > 0) {
          for (const b of bobinas) {
            body.push([
              codigo,
              desc,
              String(b.metros ?? ''),
              String(b.lote ?? ''),
              String(b.serialnumber ?? '')
            ]);
          }
        } else {
          body.push([
            codigo,
            desc,
            String(qty),
            String(it.lote ?? ''),
            String(it.serialnumber ?? '')
          ]);
        }
      }

      autoTable(doc, {
        startY: cursorY + 40,
        head: [['Código', 'Descrição', 'Qtd', 'Lote', 'S/N']],
        body: body.length > 0 ? body : [['', 'Sem itens', '', '', '']],
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { textColor: 20, fillColor: [255, 255, 255] },
        theme: 'grid',
        margin: { left: 40, right: 40 }
      });

      cursorY = (doc.lastAutoTable?.finalY || (cursorY + 120));
      // Mantém espaço para assinaturas no rodapé da página final
      const sigTop = pageHeight - 60 - 70;
      if (cursorY + 30 > sigTop) {
        doc.addPage();
        cursorY = 60;
      }
    });

    // Assinaturas no rodapé (última página)
    const sigTop = pageHeight - 60 - 70;
    const lastY = doc.lastAutoTable?.finalY || cursorY;
    if (lastY + 30 > sigTop) {
      doc.addPage();
    }
    desenharAssinaturasRodape(doc);

    const filename = arr.length === 1
      ? `ENTREGA_requisicao_${arr[0]?.id || ''}_${dateStr}.pdf`
      : `ENTREGA_multi_${dateStr}.pdf`;

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
      setToast({ type: 'success', message: 'Requisição marcada como Entregue.' });
      await fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao entregar' });
    }
  };

  const handleEntregarMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map(x => parseInt(x, 10)).filter(Boolean);
    const entregaveis = uniqueIds.filter(id => {
      const r = requisicoes.find(x => x.id === id);
      return r?.status === 'EM EXPEDICAO';
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
      setToast({ type: 'success', message: 'Requisições marcadas como Entregue.' });
      await fetchRequisicoes();
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao entregar' });
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
      await fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRA:', error);
      const msg = error.response?.data?.error || error.message || 'Erro ao exportar TRA';
      setToast({ type: 'error', message: msg });
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

  const handleFinalizarMulti = async (ids) => {
    const uniqueIds = Array.from(new Set(ids || [])).map(x => parseInt(x, 10)).filter(Boolean);
    if (uniqueIds.length === 0) return;

    // Finalizar apenas as que estão Entregue e já tiveram TRA gerada ao menos 1x
    const byId = new Map((requisicoes || []).map(r => [r.id, r]));
    const elegiveis = uniqueIds.filter(id => {
      const r = byId.get(id);
      return r?.status === 'Entregue' && Boolean(r?.tra_gerada_em);
    });
    const ignoradas = uniqueIds.filter(id => !elegiveis.includes(id));

    if (elegiveis.length === 0) {
      setToast({ type: 'error', message: 'Nenhuma requisição selecionada está elegível para finalizar (precisa estar Entregue e ter TRA gerada).' });
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
      separado: 'Separado',
      'EM EXPEDICAO': 'Em expedição',
      Entregue: 'Entregue',
      FINALIZADO: 'Finalizado',
      cancelada: 'Cancelada'
    };
    return labels[status] || status;
  };

  const filteredRequisicoes = requisicoes.filter(req => {
    const searchLower = searchTerm.toLowerCase();
    return (
      req.armazem_descricao?.toLowerCase().includes(searchLower) ||
      req.usuario_nome?.toLowerCase().includes(searchLower) ||
      req.itens?.some(item => 
        item.item_codigo?.toLowerCase().includes(searchLower) ||
        item.item_descricao?.toLowerCase().includes(searchLower)
      )
    );
  });

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
        {/* Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Requisições</h1>
            <p className="text-gray-600">Lista de requisições. Clique em uma para preparar e atender os itens.</p>
          </div>
          {canCreateOrEdit && (
            <div className="flex flex-wrap gap-2 justify-end">
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
                onClick={() => navigate('/requisicoes/importar')}
                className="inline-flex items-center gap-2 px-4 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors text-sm"
              >
                <FaFileImport /> Importar requisição
              </button>
              <Link
                to="/requisicoes/criar"
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors"
              >
                <FaPlus /> Nova Requisição
              </Link>
            </div>
          )}
        </div>

        {/* Filtros e Busca */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Busca */}
            <div className="flex-1 relative">
              <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar por armazém, item ou usuário..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
              />
            </div>

            {/* Botão Filtros */}
            <button
              onClick={() => setMostrarFiltros(!mostrarFiltros)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
            >
              <FaFilter /> Filtros
            </button>
          </div>

          {/* Painel de Filtros */}
          {mostrarFiltros && (
            <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={filtros.status}
                  onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                >
                  <option value="">Todos</option>
                  <option value="pendente">Pendente</option>
                  <option value="separado">Separado</option>
                  <option value="EM EXPEDICAO">Em expedição</option>
                  <option value="Entregue">Entregue</option>
                  <option value="cancelada">Cancelada</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Armazém</label>
                <select
                  value={filtros.armazem_id}
                  onChange={(e) => setFiltros({ ...filtros, armazem_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                >
                  <option value="">Todos</option>
                  {armazens.map((armazem) => (
                    <option key={armazem.id} value={armazem.id}>
                      {armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : armazem.descricao}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Lista de Requisições */}
        {filteredRequisicoes.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <p className="text-gray-500 text-lg">Nenhuma requisição encontrada</p>
            {canCreateOrEdit && (
              <Link
                to="/requisicoes/criar"
                className="mt-4 inline-block text-[#0915FF] hover:underline"
              >
                Criar primeira requisição
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredRequisicoes.map((req) => (
              <div
                key={req.id}
                className={`relative overflow-hidden rounded-lg border transition-all ${
                  selectedIds.includes(req.id)
                    ? 'border-blue-500 bg-blue-50 shadow-md'
                    : req.status === 'FINALIZADO'
                      ? 'border-slate-300 bg-slate-50 shadow-sm opacity-80'
                      : 'border-gray-200 bg-white shadow-sm'
                }`}
                onContextMenu={(e) => handleContextMenu(e, req)}
              >
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
                {/* Header da Requisição — clicável para expandir/recolher itens ou selecionar em modo seleção */}
                <div
                  onClick={() => {
                    if (selectionMode || selectedIds.length > 0) {
                      const isSelected = selectedIds.includes(req.id);
                      handleToggleSelect(req.id, !isSelected);
                    } else {
                      setExpandedId(prev => prev === req.id ? null : req.id);
                    }
                  }}
                  className="p-6 cursor-pointer hover:bg-gray-50/50 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 flex items-start gap-3">
                      <span className="text-gray-400 mt-0.5">
                        {expandedId === req.id ? <FaChevronUp /> : <FaChevronDown />}
                      </span>
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
                          {req.itens && req.itens.length > 0 && (
                            <span className="text-xs text-gray-500">
                              {req.itens.length} {req.itens.length === 1 ? 'item' : 'itens'} — clique para {expandedId === req.id ? 'recolher' : 'ver'}
                            </span>
                          )}
                          {req.status === 'pendente' && canPrepare && (
                            <span className="text-xs text-[#0915FF] flex items-center gap-1">
                              <FaBoxOpen /> Use o botão Preparar abaixo
                            </span>
                          )}
                          {req.status === 'separado' && req.separacao_confirmada && req.separacao_confirmada_em && (
                            <span className="text-xs text-green-700 flex items-center gap-1">
                              <FaCheck /> Separação confirmada em {new Date(req.separacao_confirmada_em).toLocaleString('pt-BR')}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600 space-y-1">
                          {req.armazem_origem_descricao && (
                            <div><strong>Origem:</strong> {req.armazem_origem_descricao}</div>
                          )}
                          <div><strong>Destino:</strong> {req.armazem_descricao}</div>
                          {req.localizacao && (
                            <div><strong>Localização:</strong> {req.localizacao}</div>
                          )}
                          <div><strong>Criado por:</strong> {req.usuario_nome || 'N/A'}</div>
                          <div><strong>Data:</strong> {new Date(req.created_at).toLocaleDateString('pt-BR')}</div>
                        </div>
                      </div>
                    </div>
                  <div className="flex gap-2 mt-4 sm:mt-0 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    {canPrepare && (req.status === 'separado' && req.separacao_confirmada) ? (
                      <button
                        onClick={() => handleExportTRFL(req)}
                        className="px-3 py-2 text-blue-700 hover:bg-blue-50 rounded-lg border border-blue-300 transition-colors"
                        title="Gerar TRFL — após confirmar, o status passará a Em expedição"
                      >
                        GERAR TRFL
                      </button>
                    ) : null}
                    {canPrepare && req.status === 'EM EXPEDICAO' && (
                      <button
                        onClick={() => handleEntregar(req)}
                        className="px-3 py-2 bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition-colors"
                        title="Alterar status para Entregue"
                      >
                        ENTREGAR
                      </button>
                    )}
                    {canPrepare && (req.status === 'Entregue' && !req.tra_gerada_em) && (
                      <button
                        onClick={() => handleExportTRA(req)}
                        className="px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors"
                        title="Gerar TRA"
                      >
                        GERAR TRA
                      </button>
                    )}
                    {canPrepare && req.status === 'Entregue' && req.tra_gerada_em && (
                      <button
                        onClick={() => handleFinalizar(req.id)}
                        className="px-3 py-2 bg-slate-700 text-white hover:bg-slate-800 rounded-lg transition-colors"
                        title="Marcar como Finalizado"
                      >
                        Finalizar
                      </button>
                    )}
                    {/* Re-download TRFL/TRA fica apenas no menu de contexto */}
                    {req.status === 'separado' && !req.separacao_confirmada && canPrepare && (
                        <button
                        onClick={() => handleConfirmarSeparacao(req.id)}
                        className="px-3 py-2 bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg transition-colors flex items-center gap-2"
                        title="Confirmar que os itens foram recolhidos (obrigatório antes de TRFL)"
                      >
                        <FaCheck /> Confirmar separação
                      </button>
                    )}
                    {req.status === 'pendente' && canPrepare && (
                        <button
                        onClick={() => navigate(`/requisicoes/preparar/${req.id}`)}
                        className="px-3 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg transition-colors flex items-center gap-2"
                      >
                        <FaBoxOpen /> Preparar
                      </button>
                    )}
                    {req.status === 'pendente' && canCreateOrEdit && (
                      <button
                        onClick={() => navigate(`/requisicoes/editar/${req.id}`)}
                        className="px-3 py-2 text-[#0915FF] hover:bg-[#0915FF] hover:text-white rounded-lg transition-colors"
                        title="Editar"
                      >
                        <FaEdit />
                      </button>
                    )}
                    {canDelete && (
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

                {/* Itens e Observações — só visíveis ao expandir */}
                {expandedId === req.id && (
                  <div className="px-6 pb-6 pt-0 border-t border-gray-200 bg-gray-50/50">
                    {req.itens && req.itens.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-medium text-gray-700 mb-2">
                          Itens ({req.itens.length})
                        </h4>
                        <div className="space-y-2">
                          {req.itens.map((item, index) => (
                            <div
                              key={item.item_id || index}
                              className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-100"
                            >
                              <div className="flex-1">
                                <div className="font-medium text-gray-900">{item.item_codigo}</div>
                                <div className="text-sm text-gray-500">{item.item_descricao}</div>
                              </div>
                              <div className="text-sm font-medium text-gray-700">
                                Qtd: <span className="text-[#0915FF]">{item.quantidade}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {req.observacoes && (
                      <div>
                        <p className="text-sm text-gray-600">
                          <strong>Observações:</strong> {req.observacoes}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
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
                navigate(`/requisicoes/preparar/${contextMenu.req.id}`);
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Abrir
            </button>
            {canCreateOrEdit && (
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
            {canCreateOrEdit && contextMenu.req.status === 'pendente' && (
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

              const canGerarTRFL = all(r => r.status === 'separado' && r.separacao_confirmada);
              const canBaixarTRFL = all(r => ['EM EXPEDICAO', 'Entregue', 'FINALIZADO'].includes(r.status));

              const canEntregar = all(r => r.status === 'EM EXPEDICAO');

              const canGerarTRA = all(r => r.status === 'Entregue' && !r.tra_gerada_em);
              const canBaixarTRA = all(r => (r.status === 'Entregue' && r.tra_gerada_em) || r.status === 'FINALIZADO');

              const canBaixarComprovativo = all(r => ['Entregue', 'FINALIZADO'].includes(r.status));
              const canFinalizar = all(r => r.status === 'Entregue' && r.tra_gerada_em);

              return (
                <>
                  {(canGerarTRFL || canBaixarTRFL) && (
                    <button
                      className="block w-full text-left px-4 py-2 hover:bg-gray-100"
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
                      className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                      onClick={() => {
                        if (isMulti) handleEntregarMulti(ids);
                        else handleEntregar(contextMenu.req);
                        setContextMenu(prev => ({ ...prev, visible: false }));
                      }}
                    >
                      ENTREGAR
                    </button>
                  )}

                  {(canGerarTRA || canBaixarTRA) && (
                    <button
                      className="block w-full text-left px-4 py-2 hover:bg-gray-100"
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

                  {canFinalizar && (
                    <button
                      className="block w-full text-left px-4 py-2 hover:bg-gray-100"
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
            {canDelete && (
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
            )}
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
