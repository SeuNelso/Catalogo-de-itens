import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaArrowLeft, FaCheck, FaBox, FaMapMarkerAlt, FaArrowRight, FaEdit, FaQrcode } from 'react-icons/fa';
import axios from 'axios';
import QrScannerModal from '../components/QrScannerModal';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const PrepararRequisicao = () => {
  const { id } = useParams();
  const [requisicao, setRequisicao] = useState(null);
  const [armazemOrigem, setArmazemOrigem] = useState(null);
  const [armazemDestino, setArmazemDestino] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(null);
  const [toast, setToast] = useState(null);
  const [itemPreparando, setItemPreparando] = useState(null);
  const [formItem, setFormItem] = useState({
    quantidade_preparada: '',
    localizacao_origem: '',
    localizacao_origem_custom: '',
    localizacao_destino: '',
    localizacao_destino_custom: '',
    lote: '',
    serialnumber: '',
    bobinas: [] // apenas para itens controlados por lote
  });
  const [showQrScanner, setShowQrScanner] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canPrepare = user && ['admin', 'controller', 'operador', 'backoffice_armazem'].includes(user.role);

  useEffect(() => {
    fetchRequisicao();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
      navigate('/requisicoes');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const abrirPrepararItem = (item) => {
    setItemPreparando(item);
    const locOrigem = item.localizacao_origem || '';
    const isOrigemCustom = locOrigem && locsOrigem.length > 0 && !locsOrigem.includes(locOrigem);
    const qtdPreparada = item.quantidade_preparada !== undefined && item.quantidade_preparada !== null
      ? item.quantidade_preparada
      : item.quantidade;
    setFormItem({
      quantidade_preparada: qtdPreparada,
      localizacao_origem: isOrigemCustom ? '_custom_' : locOrigem,
      localizacao_origem_custom: isOrigemCustom ? locOrigem : '',
      localizacao_destino: '',
      localizacao_destino_custom: '',
      lote: item.lote || '',
      serialnumber: item.serialnumber || '',
      bobinas: item.bobinas || []
    });
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

  const handleExportTRFL = async () => {
    try {
      const ok = await confirm({
        title: 'Gerar TRFL',
        message: 'Deseja continuar? Ao continuar, a requisição será marcada como Em expedição.',
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

  const handleExportTRA = async () => {
    try {
      const ok = await confirm({
        title: 'Gerar TRA',
        message: 'Deseja continuar? Após gerar a TRA, esta requisição ficará apta para FINALIZAR.',
        confirmLabel: 'Continuar'
      });
      if (!ok) return;

      await downloadExport(
        `/api/requisicoes/${id}/export-tra`,
        `TRA_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'TRA gerada com sucesso.'
      );
      await fetchRequisicao(true);
    } catch (error) {
      console.error('Erro ao exportar TRA:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao exportar TRA' });
    }
  };

  const handleExportReporte = async () => {
    try {
      if (!requisicao?.tra_gerada_em || !['Entregue', 'FINALIZADO'].includes(requisicao?.status)) {
        setToast({ type: 'error', message: 'Ficheiro de reporte só está disponível após gerar a TRA.' });
        return;
      }
      const ok = await confirm({
        title: 'Gerar ficheiro de reporte',
        message: 'Deseja continuar?',
        confirmLabel: 'Continuar'
      });
      if (!ok) return;

      await downloadExport(
        `/api/requisicoes/${id}/export-reporte`,
        `REPORTE_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'Ficheiro de reporte gerado com sucesso.'
      );
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao exportar ficheiro de reporte' });
    }
  };

  const handleEntregar = async () => {
    try {
      if (requisicao?.status !== 'EM EXPEDICAO') {
        setToast({ type: 'error', message: 'Só é possível entregar quando a requisição está em expedição.' });
        return;
      }
      const ok = await confirm({
        title: 'Entregar',
        message: 'Tem certeza que deseja continuar? Isso vai alterar o status para Entregue.',
        confirmLabel: 'Sim, entregar',
        variant: 'warning'
      });
      if (!ok) return;

      // PDF com lista de artigos (download antes de mudar status)
      try {
        const today = new Date();
        const dateStr = today.toISOString().slice(0, 10);
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        doc.setFontSize(16);
        doc.text('Comprovativo de Entrega', pageWidth / 2, 48, { align: 'center' });
        doc.setFontSize(10);
        doc.text(`Data: ${today.toLocaleString('pt-BR')}`, 40, 66);
        doc.setFontSize(12);
        doc.text(`Requisição #${id}`, 40, 90);
        doc.setFontSize(10);
        doc.text(`Origem: ${requisicao?.armazem_origem_descricao || ''}`, 40, 106);
        doc.text(`Destino: ${requisicao?.armazem_descricao || ''}`, 40, 122);

        const itens = Array.isArray(requisicao?.itens) ? requisicao.itens : [];
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
          startY: 140,
          head: [['Código', 'Descrição', 'Qtd', 'Lote', 'S/N']],
          body: body.length > 0 ? body : [['', 'Sem itens', '', '', '']],
          styles: { fontSize: 9, cellPadding: 4 },
          headStyles: { textColor: 20, fillColor: [255, 255, 255] },
          theme: 'grid',
          margin: { left: 40, right: 40 }
        });

        // Assinaturas no rodapé (fim da folha)
        const leftX1 = 60;
        const leftX2 = pageWidth / 2 - 20;
        const rightX1 = pageWidth / 2 + 20;
        const rightX2 = pageWidth - 60;

        const sigTop = pageHeight - 60 - 70;
        const lastY = doc.lastAutoTable?.finalY || 220;
        if (lastY + 30 > sigTop) {
          doc.addPage();
        }
        const y = doc.internal.pageSize.getHeight() - 60 - 70;

        doc.setFontSize(10);
        doc.text('Assinatura do Armazém', (leftX1 + leftX2) / 2, y, { align: 'center' });
        doc.line(leftX1, y + 34, leftX2, y + 34);
        doc.text('Nome / assinatura', (leftX1 + leftX2) / 2, y + 52, { align: 'center' });

        doc.text('Assinatura do Recebedor', (rightX1 + rightX2) / 2, y, { align: 'center' });
        doc.line(rightX1, y + 34, rightX2, y + 34);
        doc.text('Nome / assinatura', (rightX1 + rightX2) / 2, y + 52, { align: 'center' });

        doc.save(`ENTREGA_requisicao_${id}_${dateStr}.pdf`);
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

  const fecharPrepararItem = () => {
    setItemPreparando(null);
    setFormItem({ quantidade_preparada: '', localizacao_origem: '', localizacao_origem_custom: '', localizacao_destino: '', localizacao_destino_custom: '', lote: '', serialnumber: '', bobinas: [] });
  };

  const handleCompletarSeparacao = async () => {
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
      setToast({ type: 'success', message: 'Separação da requisição concluída!' });
      setTimeout(() => navigate('/requisicoes'), 1500);
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
    }

    try {
      setSubmitting(itemPreparando.id);
      const token = localStorage.getItem('token');
      await axios.patch(
        `/api/requisicoes/${id}/atender-item`,
        {
          requisicao_item_id: itemPreparando.id,
          quantidade_preparada: tipoControlo === 'LOTE' && bobinasPayload ? bobinasPayload.length : qtdPreparadaNumerica,
          localizacao_origem: locOrigem,
          lote: formItem.lote || null,
          serialnumber: formItem.serialnumber || null,
          bobinas: bobinasPayload
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
  const isSeparado = requisicao.status === 'separado';
  const locsOrigem = armazemOrigem?.localizacoes?.map(l => l.localizacao).filter(Boolean) || [];
  const todosPreparados = requisicao.itens?.every(it => it.preparacao_confirmada === true) ?? false;
  const itensPorConfirmar = requisicao.itens?.filter(it => it.preparacao_confirmada !== true) ?? [];

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
          <button
            onClick={() => navigate('/requisicoes')}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-800"
          >
            <FaArrowLeft /> Voltar
          </button>
          <div className="flex gap-2 flex-wrap">
            {(requisicao.status === 'separado' && requisicao.separacao_confirmada) && (
              <button
                onClick={handleExportTRFL}
                className="px-3 py-2 text-blue-700 hover:bg-blue-50 rounded-lg border border-blue-300 transition-colors"
                title="Gerar TRFL — após confirmar, o status passará a Em expedição"
              >
                GERAR TRFL
              </button>
            )}
            {requisicao.status === 'EM EXPEDICAO' && (
              <button
                onClick={handleEntregar}
                className="px-3 py-2 bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition-colors"
                title="Alterar status para Entregue"
              >
                ENTREGAR
              </button>
            )}
            {requisicao.status === 'Entregue' && !requisicao.tra_gerada_em && (
              <button
                onClick={handleExportTRA}
                className="px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors"
                title="Gerar TRA"
              >
                GERAR TRA
              </button>
            )}
            {['Entregue', 'FINALIZADO'].includes(requisicao.status) && requisicao.tra_gerada_em && (
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
            Preparar Requisição #{id}
          </h1>
          <p className="text-gray-600">
            Prepare cada item: confirme a quantidade e escolha a localização de saída. O destino é sempre <strong>EXPEDICAO</strong>.
          </p>
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
              <span className="text-sm text-gray-500">Status</span>
              <p>
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                  requisicao.status === 'pendente' ? 'bg-yellow-100 text-yellow-800' :
                  requisicao.status === 'separado' ? 'bg-green-100 text-green-800' :
                  requisicao.status === 'EM EXPEDICAO' ? 'bg-blue-100 text-blue-800' :
                  requisicao.status === 'Entregue' ? 'bg-emerald-100 text-emerald-800' :
                  'bg-red-100 text-red-800'
                }`}>
                  {requisicao.status === 'pendente' ? 'Pendente' : requisicao.status === 'separado' ? 'Separado' : requisicao.status === 'EM EXPEDICAO' ? 'Em expedição' : requisicao.status === 'Entregue' ? 'Entregue' : 'Cancelada'}
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
                  key={item.item_id || idx}
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
                    {canPrepare && !item.preparacao_confirmada && (isPendente || isSeparado) && (
                      <button
                        type="button"
                        onClick={() => abrirPrepararItem(item)}
                        disabled={!!itemPreparando}
                        className="px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] disabled:opacity-50 transition-colors flex items-center gap-2"
                      >
                        <FaBox /> Preparar item
                      </button>
                    )}
                    {canPrepare && item.preparacao_confirmada && (isPendente || isSeparado) && (
                      <button
                        type="button"
                        onClick={() => abrirPrepararItem(item)}
                        disabled={!!itemPreparando}
                        className="px-4 py-2 border border-[#0915FF] text-[#0915FF] rounded-lg hover:bg-[#0915FF] hover:text-white disabled:opacity-50 transition-colors flex items-center gap-2"
                      >
                        <FaEdit /> Editar preparação
                      </button>
                    )}
                  </div>

                  {isPreparando && (
                    <form onSubmit={handlePrepararItem} className="mt-4 pt-4 border-t border-gray-200 space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Quantidade preparada</label>
                        <input
                          type="number"
                          min="0"
                          value={formItem.quantidade_preparada}
                          onChange={(e) => setFormItem(prev => ({ ...prev, quantidade_preparada: e.target.value }))}
                          className="w-full sm:w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                          required
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Requisitada: {item.quantidade}. Pode ser diferente (para mais ou para menos); o sistema irá pedir confirmação.
                          Use 0 se não tiver o item.
                        </p>
                      </div>
                      {(item.tipocontrolo || '').toUpperCase() === 'LOTE' && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-700">Bobinas preparadas</span>
                            <button
                              type="button"
                              onClick={() =>
                                setFormItem(prev => ({
                                  ...prev,
                                  bobinas: [...(prev.bobinas || []), { lote: '', serialnumber: '', metros: '' }]
                                }))
                              }
                              className="px-3 py-1 text-xs rounded bg-[#0915FF] text-white hover:bg-[#070FCC]"
                            >
                              Adicionar bobina
                            </button>
                          </div>
                          {(formItem.bobinas || []).length === 0 && (
                            <p className="text-xs text-gray-500">
                              Adicione uma linha por bobina (lote + metros) preparada.
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
                                      setFormItem(prev => ({
                                        ...prev,
                                        bobinas: prev.bobinas.filter((_, i) => i !== idxBob)
                                      }))
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
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Serial number <span className="text-red-600">*</span>
                          </label>
                          <input
                            type="text"
                            value={formItem.serialnumber}
                            onChange={(e) => setFormItem(prev => ({ ...prev, serialnumber: e.target.value }))}
                            className="w-full sm:w-64 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                            placeholder="Informe o serial preparado"
                            required
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

          {isPendente && canPrepare && (
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
              <p className="text-green-600 font-medium">✓ Requisição totalmente preparada (Separado)</p>
            </div>
          )}

          {requisicao.status === 'cancelada' && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <p className="text-red-600 font-medium">Requisição cancelada</p>
            </div>
          )}
        </div>

        {toast && (
          <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
        )}
      </div>
    </div>
  );
};

export default PrepararRequisicao;
