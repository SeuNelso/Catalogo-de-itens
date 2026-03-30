import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
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

const TransferenciasRecebimento = () => {
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

  const [importados, setImportados] = useState([]); // apenas enquanto importa o ficheiro

  // 'setup' → 'pendente' → 'em_processo'
  const [stage, setStage] = useState('setup');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
    setStage('setup');
  }, [receivingId]);

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
      setToast({ type: 'error', message: 'Importe pelo menos 1 material.' });
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
      setStage('pendente');
      setToast({ type: 'success', message: 'Transferência criada. Verifique em Pendente.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao criar transferência a receber.' });
    } finally {
      setCreating(false);
    }
  }, [importados, origemId, receivingId]);

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
        <div className="mb-5">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">
            Recebimento de transferência entre armazéns
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            1) Escolha origem (diferente do destino) · 2) Importe materiais · 3) Confirme · 4) Gere report.
          </p>
        </div>

        {canUseReceivingOverride && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5 mb-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3 justify-between">
              <div>
                <div className="text-sm font-medium text-gray-800 mb-1">Armazém destino (recebimento)</div>
                <div className="text-xs text-gray-500">
                  O valor é automático só quando o utilizador tem 1 único armazém de escopo.
                </div>
              </div>
              <select
                value={receivingWarehouseOverrideId}
                onChange={(e) => setReceivingWarehouseOverrideId(e.target.value)}
                className="w-full sm:w-[280px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] text-sm"
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

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Armazém origem</label>
              <select
                value={origemId}
                onChange={(e) => setOrigemId(e.target.value)}
                disabled={loadingArmazens || origemOptions.length === 0}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] text-sm disabled:opacity-50"
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
              <div className="text-[11px] text-gray-500 mt-2">
                Destino atual: <span className="font-mono">{receivingId || '—'}</span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Importar lista de materiais</label>
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                disabled={!receivingId || !origemId || importing}
                onChange={(e) => handleFile(e.target.files?.[0])}
                className="w-full text-sm disabled:opacity-50"
              />
              <div className="text-[11px] text-gray-500 mt-2">
                Excel/CSV: colunas <span className="font-mono">Código</span> e <span className="font-mono">Quantidade</span>. PDF: usa a cópia ORIGINAL da guia.
              </div>
            </div>
          </div>
        </div>

        {stage === 'pendente' && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5 mb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-900">Pendente</div>
                <div className="text-xs text-gray-500">Revise e confirme as quantidades recebidas.</div>
              </div>
              <button
                type="button"
                disabled={confirming || !(recebimentoReq?.itens?.length > 0)}
                onClick={confirmarMateriaisRecebimento}
                className="px-3 py-2 rounded-lg bg-[#0915FF] text-white text-sm font-bold hover:bg-[#070FCC] disabled:opacity-50"
              >
                {confirming ? 'A confirmar…' : 'Confirmar materiais'}
              </button>
            </div>

            {!(recebimentoReq?.itens?.length > 0) ? (
              <p className="text-sm text-gray-500 mt-3">Sem itens para confirmar.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
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
                            className="w-[140px] px-2 py-1.5 border border-gray-300 rounded-lg text-xs text-right tabular-nums"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {stage === 'em_processo' && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5 mb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-blue-800">Em processo</div>
                <div className="text-xs text-blue-700/70">Gere o report do material recebido.</div>
              </div>
              <button
                type="button"
                onClick={gerarReportMaterialRecebido}
                disabled={exporting || !recebimentoReqId}
                className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
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
              <div className="flex items-center gap-2 flex-wrap">
                {canReceberStock && (
                  <button
                    type="button"
                    onClick={receberStock}
                    disabled={recebendoStock}
                    className="px-3 py-2 rounded-lg bg-[#0915FF] text-white text-sm font-bold hover:bg-[#070FCC] disabled:opacity-50"
                  >
                    {recebendoStock ? 'A receber stock…' : 'Receber stock'}
                  </button>
                )}
                {recebimentoReq?.tra_baixa_expedicao_aplicada_em && (
                  <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                    Stock já recebido na localização de recebimento.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setStage('pendente')}
                  className="px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm font-semibold hover:bg-gray-50"
                >
                  Voltar e ajustar
                </button>
              </div>
            </div>
          </div>
        )}

        {stage === 'setup' && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5 mb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-900">Setup</div>
                <div className="text-xs text-gray-500">Importe a lista e crie a transferência a receber.</div>
              </div>
              <button
                type="button"
                disabled={creating || importing || importados.length === 0 || !origemId || !receivingId}
                onClick={criarTransferenciaRecebimento}
                className="px-3 py-2 rounded-lg bg-[#0915FF] text-white text-sm font-bold hover:bg-[#070FCC] disabled:opacity-50"
              >
                {creating ? 'A criar…' : 'Criar transferência'}
              </button>
            </div>
            {importados.length > 0 && (
              <>
                <div className="mt-3 text-xs text-gray-600">
                  Importados: <span className="font-mono tabular-nums">{importados.length}</span> linha(s).
                </div>
                <div className="mt-3 overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="bg-gray-100 text-xs text-gray-600 uppercase tracking-wide">
                        <th className="px-3 py-2 text-left">Código</th>
                        <th className="px-3 py-2 text-left">Descrição</th>
                        <th className="px-3 py-2 text-right">Quantidade</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {importados.map((it, idx) => (
                        <tr key={`${it.codigo}-${idx}`}>
                          <td className="px-3 py-2 font-mono text-xs">{it.codigo}</td>
                          <td className="px-3 py-2 text-xs text-gray-700 max-w-[420px]">{it.descricao || '—'}</td>
                          <td className="px-3 py-2 text-right text-xs tabular-nums">{Number(it.quantidade) || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
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

