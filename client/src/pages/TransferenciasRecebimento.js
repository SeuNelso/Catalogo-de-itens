import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { FaArrowLeft, FaPlus, FaTrash } from 'react-icons/fa';
import Toast from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';
import { podeUsarControloStock } from '../utils/controloStock';

const parseNumberPt = (v) => {
  // aceita "1.234,56" ou "1,234.56" ou "1234.56" ou "1234,56"
  const raw = String(v ?? '').trim();
  if (!raw) return NaN;
  // remove espaços
  const cleaned = raw.replace(/\s+/g, '');
  // se tem vírgula e ponto, assume o último como separador decimal
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    const noThousand = cleaned.split(thousandSep).join('');
    const normalized = decimalSep === ',' ? noThousand.replace(',', '.') : noThousand;
    return Number(normalized);
  }
  if (lastComma !== -1) {
    // vírgula como decimal
    const normalized = cleaned.replace(',', '.');
    return Number(normalized);
  }
  return Number(cleaned);
};

const findHeaderKey = (headers, predicate) => {
  const idx = headers.findIndex((h) => predicate(h));
  return idx >= 0 ? headers[idx] : null;
};

const isCentralWarehouse = (a) => {
  const tipo = String(a?.tipo || '').trim().toLowerCase();
  if (tipo === 'central') return true;
  const codigo = String(a?.codigo || '').trim().toLowerCase();
  const descricao = String(a?.descricao || '').trim().toLowerCase();
  return codigo.includes('central') || descricao.includes('central');
};

const extrairCodigoManual = (valor) => {
  const s = String(valor || '').trim();
  if (!s) return '';
  return s.split(' - ')[0].trim();
};

const TransferenciasRecebimento = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [toast, setToast] = useState(null);

  const [loadingArmazens, setLoadingArmazens] = useState(false);
  const [armazens, setArmazens] = useState([]);

  // "Destino" (recebimento) = onde o utilizador está cadastrado (aproximação pelo escopo atual)
  const receivingWarehouseId = useMemo(() => {
    if (!user) return null;
    if (user.role === 'admin') return null;
    const ids = Array.isArray(user.requisicoes_armazem_origem_ids) ? user.requisicoes_armazem_origem_ids : [];
    if (ids.length === 1) return String(ids[0]);
    return null;
  }, [user]);

  const [receivingWarehouseOverrideId, setReceivingWarehouseOverrideId] = useState('');
  const receivingId = receivingWarehouseId || receivingWarehouseOverrideId;

  const [origemId, setOrigemId] = useState('');
  // Após criar a transferência, o que manda é a requisição no backend.
  const [recebimentoReqId, setRecebimentoReqId] = useState(null);
  const [recebimentoReq, setRecebimentoReq] = useState(null); // contém .itens
  const [confirmQuantByItemId, setConfirmQuantByItemId] = useState({});

  const [importados, setImportados] = useState([]); // linhas de importação e/ou entrada manual

  const [manualCodigo, setManualCodigo] = useState('');
  const [manualQtd, setManualQtd] = useState('');
  const [manualDescricao, setManualDescricao] = useState('');
  const [observacoesVisual, setObservacoesVisual] = useState('');
  const [itensFiltradosManual, setItensFiltradosManual] = useState([]);
  const [itensBuscaManualLoading, setItensBuscaManualLoading] = useState(false);
  const [mostrarListaManual, setMostrarListaManual] = useState(false);
  const [selectedItemManualIndex, setSelectedItemManualIndex] = useState(-1);
  const debounceBuscaManualRef = useRef(null);
  const abortBuscaManualRef = useRef(null);
  const refManualBuscaWrap = useRef(null);
  const refManualLista = useRef(null);

  // 'setup' → 'pendente' → 'em_processo'
  const [stage, setStage] = useState('setup');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingEntrega, setConfirmingEntrega] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [recebendoStock, setRecebendoStock] = useState(false);
  const [reportGerado, setReportGerado] = useState(false);

  const origemOptions = useMemo(() => {
    const rcv = String(receivingId || '');
    const centrais = armazens.filter((a) => isCentralWarehouse(a));
    const base = !rcv ? centrais : centrais.filter((a) => String(a.id) !== rcv);
    return [
      ...base,
      { id: 'FORNECEDOR', codigo: 'FORNECEDOR', descricao: 'FORNECEDOR' }
    ];
  }, [armazens, receivingId]);
  const origemFornecedor = String(origemId || '') === 'FORNECEDOR';

  useEffect(() => {
    const load = async () => {
      try {
        setLoadingArmazens(true);
        const token = localStorage.getItem('token');
        const res = await axios.get('/api/armazens?ativo=true&destino_requisicao=1', {
          headers: { Authorization: `Bearer ${token}` }
        });
        setArmazens(Array.isArray(res.data) ? res.data : []);
      } catch (e) {
        setToast({ type: 'error', message: 'Erro ao carregar armazéns.' });
      } finally {
        setLoadingArmazens(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    setOrigemId('');
    setRecebimentoReqId(null);
    setRecebimentoReq(null);
    setConfirmQuantByItemId({});
    setImportados([]);
    setManualCodigo('');
    setManualQtd('');
    setManualDescricao('');
    setObservacoesVisual('');
    setStage('setup');
  }, [receivingId]);

  useEffect(() => {
    const q = String(manualCodigo || '').trim();
    if (!q || !receivingId || !origemId) {
      if (abortBuscaManualRef.current) abortBuscaManualRef.current.abort();
      setItensFiltradosManual([]);
      setMostrarListaManual(false);
      setSelectedItemManualIndex(-1);
      setItensBuscaManualLoading(false);
      return;
    }
    if (debounceBuscaManualRef.current) clearTimeout(debounceBuscaManualRef.current);
    debounceBuscaManualRef.current = setTimeout(async () => {
      if (abortBuscaManualRef.current) abortBuscaManualRef.current.abort();
      const ac = new AbortController();
      abortBuscaManualRef.current = ac;
      setItensBuscaManualLoading(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/itens', {
          params: {
            search: q,
            limit: 50,
            page: 1,
            incluirInativos: true,
          },
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (abortBuscaManualRef.current !== ac) return;
        const list = Array.isArray(data?.itens) ? data.itens : [];
        setItensFiltradosManual(list);
        setMostrarListaManual(true);
        setSelectedItemManualIndex(list.length > 0 ? 0 : -1);
      } catch (err) {
        if (axios.isCancel?.(err) || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        setItensFiltradosManual([]);
        setMostrarListaManual(false);
      } finally {
        if (abortBuscaManualRef.current === ac) setItensBuscaManualLoading(false);
      }
    }, 280);
    return () => {
      clearTimeout(debounceBuscaManualRef.current);
      abortBuscaManualRef.current?.abort();
    };
  }, [manualCodigo, receivingId, origemId]);

  useEffect(() => {
    if (!mostrarListaManual || selectedItemManualIndex < 0 || !refManualLista.current) return;
    const el = refManualLista.current.querySelector(`[data-manual-item-index="${selectedItemManualIndex}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [mostrarListaManual, selectedItemManualIndex]);

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (refManualBuscaWrap.current && !refManualBuscaWrap.current.contains(e.target)) {
        setMostrarListaManual(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const selecionarItemManual = useCallback((item) => {
    const codigo = String(item?.codigo || '').trim();
    const descricao = String(item?.descricao || '').trim();
    if (!codigo) return;
    setManualCodigo(descricao ? `${codigo} - ${descricao}` : codigo);
    if (!String(manualDescricao || '').trim()) {
      setManualDescricao(descricao);
    }
    setMostrarListaManual(false);
    setSelectedItemManualIndex(-1);
  }, [manualDescricao]);

  const adicionarLinhaManual = useCallback(() => {
    if (!receivingId) {
      setToast({ type: 'error', message: 'Selecione o armazém de recebimento.' });
      return;
    }
    if (!origemId) {
      setToast({ type: 'error', message: 'Selecione o armazém de origem.' });
      return;
    }
    const codigo = extrairCodigoManual(manualCodigo);
    const q = parseNumberPt(manualQtd);
    const descricaoDigitada = String(manualDescricao || '').trim();
    const codigoUpper = String(codigo || '').trim().toUpperCase();
    const descricaoSugerida = (itensFiltradosManual || []).find(
      (it) => String(it?.codigo || '').trim().toUpperCase() === codigoUpper
    )?.descricao;
    const descricao = descricaoDigitada || String(descricaoSugerida || '').trim();
    if (!codigo) {
      setToast({ type: 'error', message: 'Indique o código do artigo.' });
      return;
    }
    if (!Number.isFinite(q) || q <= 0) {
      setToast({ type: 'error', message: 'Indique uma quantidade numérica maior que zero.' });
      return;
    }
    const k = codigo.toUpperCase();
    setImportados((prev) => {
      const idx = prev.findIndex((x) => String(x.codigo || '').trim().toUpperCase() === k);
      if (idx >= 0) {
        const next = [...prev];
        const cur = next[idx];
        next[idx] = {
          ...cur,
          quantidade: Number(cur.quantidade) + q,
          descricao: descricao || cur.descricao || ''
        };
        return next;
      }
      return [...prev, { codigo, quantidade: q, descricao }];
    });
    setManualCodigo('');
    setManualQtd('');
    setManualDescricao('');
  }, [manualCodigo, manualDescricao, manualQtd, origemId, receivingId, itensFiltradosManual]);

  const removerLinhaImportada = useCallback((idx) => {
    setImportados((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      setImporting(true);
      try {
        const name = String(file.name || '');
        const ext = name.split('.').pop()?.toLowerCase();

        if (!['xlsx', 'xls', 'csv', 'pdf'].includes(ext)) {
          setToast({ type: 'error', message: 'Formato não suportado. Use .xlsx, .xls, .csv ou .pdf.' });
          return;
        }
        if (!receivingId) {
          setToast({ type: 'error', message: 'Selecione o armazém de recebimento.' });
          return;
        }
        if (!origemId) {
          setToast({ type: 'error', message: 'Selecione o armazém de origem.' });
          return;
        }

        let parsed = [];
        if (ext === 'pdf') {
          const token = localStorage.getItem('token');
          const form = new FormData();
          form.append('arquivo', file);
          const resp = await fetch('/api/requisicoes/transferencias/recebimento/parse-guia-transporte', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form
          });
          if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            throw new Error(d.error || d.message || 'Erro ao ler PDF da guia de transporte.');
          }
          const data = await resp.json();
          parsed = (data?.itens || []).map((it) => ({
            codigo: String(it?.codigo || '').trim(),
            descricao: String(it?.descricao || '').trim(),
            quantidade: Number(it?.quantidade)
          }));
        } else {
          const XLSX = await import('xlsx');
          const buf = await file.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array' });
          const sheetName = wb.SheetNames?.[0];
          if (!sheetName) throw new Error('Sem folha no ficheiro.');

          const ws = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
          if (!Array.isArray(rows) || rows.length === 0) {
            setToast({ type: 'error', message: 'Ficheiro vazio ou sem linhas.' });
            return;
          }

          // inferir cabeçalhos
          const header = Object.keys(rows[0] || {});
          const codigoKey = findHeaderKey(header, (h) => /codigo|artigo|item.*codigo|item_codigo|cod/i.test(String(h)));
          const descKey = findHeaderKey(header, (h) => /descricao|descri[cç][aã]o|nome/i.test(String(h)));
          const qtyKey = findHeaderKey(header, (h) => /quantidade|qtd|quant|qty/i.test(String(h)));

          if (!codigoKey || !qtyKey) {
            setToast({
              type: 'error',
              message: 'Não consegui identificar as colunas de Código (e Quantidade). Verifique o template.'
            });
            return;
          }

          parsed = rows
            .map((r) => {
              const codigo = String(r[codigoKey] ?? '').trim();
              const descricao = descKey ? String(r[descKey] ?? '').trim() : '';
              const quantidade = parseNumberPt(r[qtyKey]);
              return {
                codigo,
                descricao,
                quantidade: Number.isFinite(quantidade) ? quantidade : NaN
              };
            })
            .filter((x) => x.codigo && Number.isFinite(x.quantidade) && x.quantidade > 0);
        }

        parsed = parsed.filter((x) => x.codigo && Number.isFinite(Number(x.quantidade)) && Number(x.quantidade) > 0);

        if (parsed.length === 0) {
          setToast({ type: 'error', message: 'Nenhuma linha válida (código e quantidade > 0).' });
          return;
        }

        setImportados(parsed);
        setToast({ type: 'success', message: `Importado: ${parsed.length} material(is). A criar transferência…` });
      } catch (e) {
        setToast({ type: 'error', message: e.message || 'Erro ao importar ficheiro.' });
      } finally {
        setImporting(false);
      }
    },
    [origemId, receivingId]
  );

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

  const fetchRequisicaoDetalhe = async (reqId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/requisicoes/${reqId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data;
  };

  const criarTransferenciaRecebimento = useCallback(async () => {
    if (!receivingId) {
      setToast({ type: 'error', message: 'Selecione o armazém de recebimento.' });
      return;
    }
    if (!origemId) {
      setToast({ type: 'error', message: 'Selecione o armazém de origem.' });
      return;
    }
    if (!Array.isArray(importados) || importados.length === 0) {
      setToast({ type: 'error', message: 'Adicione pelo menos uma linha (manual ou ficheiro).' });
      return;
    }
    const ok = importados.every((m) => Number(m.quantidade) > 0);
    if (!ok) {
      setToast({ type: 'error', message: 'Todas as quantidades têm de ser > 0.' });
      return;
    }

    try {
      setCreating(true);
      setToast(null);

      const token = localStorage.getItem('token');
      const res = await fetch('/api/requisicoes/transferencias/recebimento', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origem_armazem_id: origemId === 'FORNECEDOR' ? null : Number(origemId),
          origem_fornecedor: origemId === 'FORNECEDOR',
          recebimento_armazem_id: Number(receivingId),
          itens: importados.map((m) => ({ codigo: m.codigo, quantidade: Number(m.quantidade), descricao: m.descricao })),
          observacoes: 'Recebimento via UI'
        })
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || d.message || 'Erro ao criar transferência a receber.');
      }

      const data = await res.json();
      const id = data?.id ? Number(data.id) : null;
      if (!id) throw new Error('Recebimento criado mas sem id.');

      const detalh = await fetchRequisicaoDetalhe(id);
      setRecebimentoReqId(id);
      setRecebimentoReq(detalh);

      // Inicial: quantidade original importada.
      const map = {};
      for (const it of (detalh?.itens || [])) {
        map[it.id] = Number(it.quantidade_preparada ?? it.quantidade ?? 0) || 0;
      }
      setConfirmQuantByItemId(map);
      setToast({ type: 'success', message: 'Transferência criada. Aceda ao card de recebimento para preparar.' });
      navigate('/transferencias?fluxo=recebimento');
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao criar transferência a receber.' });
    } finally {
      setCreating(false);
    }
  }, [importados, navigate, origemId, receivingId]);

  const confirmarMateriaisRecebimento = useCallback(async () => {
    if (!recebimentoReqId || !recebimentoReq) return;
    const itens = recebimentoReq.itens || [];
    if (!itens.length) {
      setToast({ type: 'error', message: 'Sem itens para confirmar.' });
      return;
    }

    const payloadItens = itens.map((it) => ({
      requisicao_item_id: it.id,
      quantidade_confirmada: Number(confirmQuantByItemId[it.id] ?? 0)
    }));

    const ok = payloadItens.every((x) => Number.isFinite(x.quantidade_confirmada) && x.quantidade_confirmada > 0);
    if (!ok) {
      setToast({ type: 'error', message: 'Todas as quantidades confirmadas têm de ser > 0.' });
      return;
    }

    try {
      setConfirming(true);
      setToast(null);

      const token = localStorage.getItem('token');
      const res = await fetch(`/api/requisicoes/transferencias/recebimento/${recebimentoReqId}/confirmar`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ itens: payloadItens })
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || d.message || 'Erro ao confirmar materiais.');
      }

      const data = await res.json();
      setRecebimentoReq(data);
      setStage('em_processo');
      setReportGerado(false);
      setToast({ type: 'success', message: 'Materiais confirmados. Em processo.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao confirmar materiais.' });
    } finally {
      setConfirming(false);
    }
  }, [confirmQuantByItemId, recebimentoReq, recebimentoReqId]);

  const gerarReportMaterialRecebido = useCallback(async () => {
    if (!recebimentoReqId) return;
    try {
      setExporting(true);
      setToast(null);

      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const filename = `MATERIAL_RECEBIDO_requisicao_${recebimentoReqId}_${dateStr}.xlsx`;

      await downloadExport(
        `/api/requisicoes/transferencias/recebimento/${recebimentoReqId}/export-reporte`,
        filename,
        'Reporte de material recebido gerado.'
      );
      setReportGerado(true);
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao gerar report.' });
    } finally {
      setExporting(false);
    }
  }, [recebimentoReqId]);

  const confirmarEntregaRecebimento = useCallback(async () => {
    if (!recebimentoReqId) return;
    try {
      setConfirmingEntrega(true);
      setToast(null);
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/requisicoes/transferencias/recebimento/${recebimentoReqId}/confirmar-entrega`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || d.message || 'Erro ao confirmar entrega.');
      }
      const data = await res.json();
      setRecebimentoReq(data);
      setToast({ type: 'success', message: 'Entrega confirmada. Status alterado para Entregue.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao confirmar entrega.' });
    } finally {
      setConfirmingEntrega(false);
    }
  }, [recebimentoReqId]);

  const receberStock = useCallback(async () => {
    if (!recebimentoReqId) return;
    try {
      setRecebendoStock(true);
      setToast(null);
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/requisicoes/transferencias/recebimento/${recebimentoReqId}/receber-stock`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || d.message || 'Erro ao receber stock.');
      }
      const data = await res.json();
      setRecebimentoReq(data);
      setToast({ type: 'success', message: 'Stock recebido com sucesso na localização de recebimento.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao receber stock.' });
    } finally {
      setRecebendoStock(false);
    }
  }, [recebimentoReqId]);

  const canUseReceivingOverride = useMemo(() => {
    return user?.role === 'admin' || !receivingWarehouseId;
  }, [receivingWarehouseId, user]);
  const canReceberStock = useMemo(() => {
    return Boolean(
      podeUsarControloStock(user) &&
      stage === 'em_processo' &&
      (reportGerado || recebimentoReq?.tra_gerada_em) &&
      !recebimentoReq?.tra_baixa_expedicao_aplicada_em
    );
  }, [user, stage, reportGerado, recebimentoReq]);

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <button
            type="button"
            onClick={() => navigate('/transferencias')}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-800"
          >
            <FaArrowLeft /> Voltar
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
            Nova tarefa de recebimento de mercadoria
          </h1>
          <p className="text-gray-600">
            Etapa 1: Defina origem, materiais e quantidades. Depois crie a tarefa para confirmação e reporte.
          </p>
        </div>

        {stage === 'setup' && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-4">
            {canUseReceivingOverride && (
              <div className="mb-6 pb-6 border-b border-gray-200">
                <div className="flex flex-col sm:flex-row sm:items-end gap-3 justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-2">Armazém destino (recebimento)</div>
                    <div className="text-xs text-gray-500">
                      O valor é automático só quando o utilizador tem 1 único armazém de escopo.
                    </div>
                  </div>
                  <select
                    value={receivingWarehouseOverrideId}
                    onChange={(e) => setReceivingWarehouseOverrideId(e.target.value)}
                    className="w-full sm:w-[280px] px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  >
                    <option value="">Selecione o destino</option>
                    {armazens
                      .filter((a) => isCentralWarehouse(a))
                      .slice()
                      .sort((a, b) => String(a.codigo || '').localeCompare(String(b.codigo || '')))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.codigo ? `${a.codigo} - ${a.descricao}` : a.descricao}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Armazém origem</label>
              <select
                value={origemId}
                onChange={(e) => setOrigemId(e.target.value)}
                disabled={loadingArmazens || origemOptions.length === 0}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent disabled:opacity-50"
              >
                <option value="">{loadingArmazens ? 'A carregar…' : 'Selecione a origem'}</option>
                {origemOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {String(a.id) === 'FORNECEDOR'
                      ? 'FORNECEDOR'
                      : (a.codigo ? `${a.codigo} - ${a.descricao}` : a.descricao)}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-xs text-gray-500">
                Destino atual: <span className="font-mono">{receivingId || '—'}</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Importar lista de materiais</label>
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                disabled={!receivingId || !origemId || importing}
                onChange={(e) => handleFile(e.target.files?.[0])}
                className="w-full text-sm disabled:opacity-50"
              />
              <div className="mt-1 text-xs text-gray-500">
                Excel/CSV: colunas <span className="font-mono">Código</span> e <span className="font-mono">Quantidade</span>. PDF: usa a cópia ORIGINAL da guia.
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6 mt-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Itens da Requisição</h3>
            <div className="mb-4 p-4 bg-gray-50 rounded-lg">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3 items-end">
              <div className="sm:col-span-7">
                <label className="block text-sm font-medium text-gray-700 mb-2">Buscar Item</label>
                <div className="relative" ref={refManualBuscaWrap}>
                  <input
                    type="text"
                    value={manualCodigo}
                    onChange={(e) => setManualCodigo(e.target.value)}
                    onFocus={() => {
                      if (String(manualCodigo || '').trim()) setMostrarListaManual(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        if (mostrarListaManual && itensFiltradosManual.length > 0) {
                          e.preventDefault();
                          setSelectedItemManualIndex((i) => (i < itensFiltradosManual.length - 1 ? i + 1 : i));
                        }
                      } else if (e.key === 'ArrowUp') {
                        if (mostrarListaManual && itensFiltradosManual.length > 0) {
                          e.preventDefault();
                          setSelectedItemManualIndex((i) => (i > 0 ? i - 1 : 0));
                        }
                      } else if (e.key === 'Enter') {
                        if (mostrarListaManual) {
                          e.preventDefault();
                          if (itensFiltradosManual.length > 0) {
                            const idx = selectedItemManualIndex >= 0 ? selectedItemManualIndex : 0;
                            selecionarItemManual(itensFiltradosManual[idx]);
                          }
                        }
                      } else if (e.key === 'Escape') {
                        setMostrarListaManual(false);
                      }
                    }}
                    disabled={!receivingId || !origemId}
                    placeholder="Ex: ABC123"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent text-sm font-mono disabled:opacity-50"
                  />
                  {mostrarListaManual && (
                    <div
                      ref={refManualLista}
                      className="absolute z-20 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-y-auto"
                    >
                      {itensBuscaManualLoading ? (
                        <div className="px-3 py-2 text-sm text-gray-500">A pesquisar…</div>
                      ) : itensFiltradosManual.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-500">Nenhum item encontrado</div>
                      ) : (
                        <ul className="divide-y divide-gray-100">
                          {itensFiltradosManual.map((item, idx) => (
                            <li key={item.id || `${item.codigo}-${idx}`}>
                              <button
                                type="button"
                                data-manual-item-index={idx}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  selecionarItemManual(item);
                                }}
                                className={`w-full text-left px-3 py-2 text-sm ${
                                  idx === selectedItemManualIndex
                                    ? 'bg-[#0915FF]/15 text-[#0915FF]'
                                    : 'hover:bg-gray-100'
                                }`}
                              >
                                <div className="font-mono font-medium">{item.codigo}</div>
                                <div className="text-xs text-gray-500 truncate">{item.descricao}</div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">Quantidade</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={manualQtd}
                  onChange={(e) => setManualQtd(e.target.value)}
                  disabled={!receivingId || !origemId}
                  placeholder="0"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent text-sm tabular-nums disabled:opacity-50"
                />
              </div>
              <div className="sm:col-span-3">
                <button
                  type="button"
                  disabled={!receivingId || !origemId}
                  onClick={adicionarLinhaManual}
                  className="w-full sm:w-auto min-w-[11rem] px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors flex items-center justify-center gap-2 shrink-0 disabled:opacity-50"
                >
                  <FaPlus /> Adicionar Item
                </button>
              </div>
            </div>
              <p className="mt-2 text-xs text-gray-500">
                O código tem de existir no catálogo. Se repetir o mesmo código, as quantidades são somadas.
              </p>
            </div>
          </div>

              {importados.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    Itens Adicionados ({importados.length})
                  </h4>
                  <div className="space-y-2">
                    {importados.map((it, idx) => (
                      <div
                        key={`${it.codigo}-${idx}`}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
                      >
                        <div className="flex-1">
                          <div className="font-medium text-gray-900">{it.codigo}</div>
                          <div className="text-sm text-gray-500">{it.descricao || '—'}</div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm font-medium text-gray-700">
                            Qtd: <span className="text-[#0915FF]">{Number(it.quantidade) || 0}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => removerLinhaImportada(idx)}
                            className="text-red-600 hover:text-red-800 p-2"
                            aria-label={`Remover item ${it.codigo}`}
                            title="Remover item"
                          >
                            <FaTrash />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Observações
            </label>
            <textarea
              value={observacoesVisual}
              onChange={(e) => setObservacoesVisual(e.target.value)}
              rows="4"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
              placeholder="Observações adicionais sobre a requisição (opcional)"
            />
          </div>

          <div className="flex flex-col sm:flex-row gap-4 pt-4 border-t border-gray-200 mt-4">
            <button
              type="button"
              onClick={() => navigate('/transferencias')}
              className="flex-1 px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={creating || importing || importados.length === 0 || !origemId || !receivingId}
              onClick={criarTransferenciaRecebimento}
              className="flex-1 px-6 py-3 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'A criar…' : 'Criar transferência'}
            </button>
          </div>
        </div>
        )}

        {stage === 'pendente' && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-900">Pendente</div>
                <div className="text-xs text-gray-500">Revise e confirme as quantidades recebidas.</div>
              </div>
            </div>

            {!(recebimentoReq?.itens?.length > 0) ? (
              <p className="text-sm text-gray-500 mt-3">Sem itens para confirmar.</p>
            ) : (
              <div className="mt-4 overflow-x-auto ui-table-wrap">
                <table className="ui-table min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-100 text-xs text-gray-600 uppercase tracking-wide">
                      <th className="px-3 py-2 text-left">Código</th>
                      <th className="px-3 py-2 text-left">Descrição</th>
                      <th className="px-3 py-2 text-right">Quantidade</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {recebimentoReq.itens.map((it) => (
                      <tr key={it.id}>
                        <td className="px-3 py-2 font-mono text-xs">{it.item_codigo}</td>
                        <td className="px-3 py-2 text-xs text-gray-700 max-w-[420px]">
                          {it.item_descricao || '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={String(confirmQuantByItemId[it.id] ?? it.quantidade ?? 0)}
                            onChange={(e) =>
                              setConfirmQuantByItemId((prev) => ({
                                ...prev,
                                [it.id]: parseNumberPt(e.target.value) || 0
                              }))
                            }
                            className="ui-input w-[140px] px-2 py-1.5 text-xs text-right tabular-nums"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-4 pt-4 border-t border-gray-200 mt-4">
              <button
                type="button"
                onClick={() => navigate('/transferencias')}
                className="flex-1 px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={confirming || !(recebimentoReq?.itens?.length > 0)}
                onClick={confirmarMateriaisRecebimento}
                className="flex-1 px-6 py-3 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {confirming ? 'A confirmar…' : 'Confirmar materiais'}
              </button>
            </div>
          </div>
        )}

        {stage === 'em_processo' && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-blue-800">Em processo</div>
                <div className="text-xs text-blue-700/70">Gere o report do material recebido.</div>
              </div>
              <button
                type="button"
                onClick={gerarReportMaterialRecebido}
                disabled={exporting || !recebimentoReqId}
                className="px-6 py-3 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {exporting ? 'A gerar…' : 'Gerar report'}
              </button>
            </div>

            <div className="mt-4 text-xs text-gray-600">
              Origem: <span className="font-mono">{origemId || '—'}</span> · Recebimento: <span className="font-mono">{receivingId || '—'}</span>
              <div className="mt-1">
                Total: <span className="font-mono tabular-nums">{(recebimentoReq?.itens || []).length}</span> linha(s).
              </div>
            </div>

            <div className="mt-4">
              <div className="flex flex-col sm:flex-row gap-4 pt-4 border-t border-gray-200">
                {canReceberStock && (
                  <button
                    type="button"
                    onClick={receberStock}
                    disabled={recebendoStock}
                    className="flex-1 px-6 py-3 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {recebendoStock ? 'A receber stock…' : 'Receber stock'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={confirmarEntregaRecebimento}
                  disabled={confirmingEntrega || !recebimentoReqId}
                  className="flex-1 px-6 py-3 rounded-lg bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {confirmingEntrega ? 'A confirmar receção…' : 'Confirmar receção'}
                </button>
                {recebimentoReq?.tra_baixa_expedicao_aplicada_em && (
                  <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                    Stock já recebido na localização de recebimento.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setStage('pendente')}
                  className="flex-1 px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-sm font-semibold"
                >
                  Voltar e ajustar
                </button>
              </div>
            </div>
          </div>
        )}

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

export default TransferenciasRecebimento;

