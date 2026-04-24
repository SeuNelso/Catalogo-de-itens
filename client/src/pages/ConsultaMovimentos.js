import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'react-feather';
import Toast from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';

/** Máximo de linhas por página na consulta (alinhado com a API). */
const MOVIMENTOS_PAGE_SIZE = 40;

const DEFAULT_COLUMNS = [
  'Tipo de Movimento',
  'Dt_Recepção',
  'REF.',
  'DESCRIPTION',
  'QTY',
  'Loc_Inicial',
  'S/N',
  'Lote',
  'Novo Armazém',
  'TRA / DEV',
  'New Localização',
  'DEP',
  'Observações',
];

const SN_COLUMN = 'S/N';
/** Texto na célula acima disto → resumo + botão (alinha com split no servidor: \n ; |). */
const SN_INLINE_MAX_LEN = 52;
const SN_MODAL_PAGE_SIZE = 20;

function parseSeriaisMovimento(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/\r?\n|;|\|/)
    .flatMap((part) => String(part || '').split(/\s*,\s*/))
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseListaDeValores(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/\r?\n|;|\|/)
    .flatMap((part) => String(part || '').split(/\s*,\s*/))
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeDateFilterValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    const dd = br[1].padStart(2, '0');
    const mm = br[2].padStart(2, '0');
    const yyyy = br[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  return s;
}

function cellOrDash(row, key) {
  const v = String(row?.[key] ?? '').trim();
  return v || '—';
}

/** Destino na lista Clog: localização nova, com fallback ao código de armazém. */
function destinoResumo(row) {
  const loc = String(row?.['New Localização'] ?? '').trim();
  const arm = String(row?.['Novo Armazém'] ?? '').trim();
  if (loc) return loc;
  if (arm) return arm;
  return '—';
}

/** Conta critérios não vazios em `appliedFiltros` (o que foi aplicado na última consulta). */
function countFiltrosAtivos(f) {
  if (!f) return 0;
  let n = 0;
  if (String(f.q || '').trim()) n += 1;
  if (String(f.data_inicio || '').trim()) n += 1;
  if (String(f.data_fim || '').trim()) n += 1;
  if (String(f.tra_numero || '').trim()) n += 1;
  if (String(f.tipo_movimento || '').trim()) n += 1;
  if (String(f.ref || '').trim()) n += 1;
  if (String(f.description || '').trim()) n += 1;
  if (String(f.serial || '').trim()) n += 1;
  if (String(f.lote || '').trim()) n += 1;
  if (String(f.armazem_id || '').trim()) n += 1;
  if (String(f.localizacao || '').trim()) n += 1;
  if (f.minhas) n += 1;
  return n;
}

const ConsultaMovimentos = () => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [armazens, setArmazens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [total, setTotal] = useState(0);
  const [appliedFiltros, setAppliedFiltros] = useState(null);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [offsetHistory, setOffsetHistory] = useState([]);
  const [editingMovId, setEditingMovId] = useState('');
  const [editingDraft, setEditingDraft] = useState({});
  /** { items, ref, tra, description, page, title, itemLabel } | null */
  const [serialModal, setSerialModal] = useState(null);
  /** Linha cujo detalhe completo está aberto (sheet no telemóvel, modal no desktop). */
  const [detailRow, setDetailRow] = useState(null);
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, row: null });
  const contextMenuRef = useRef(null);
  const [filtrosExpandido, setFiltrosExpandido] = useState(true);
  const pageSize = MOVIMENTOS_PAGE_SIZE;
  const [filtros, setFiltros] = useState({
    q: '',
    data_inicio: '',
    data_fim: '',
    tipo_movimento: '',
    tra_numero: '',
    ref: '',
    description: '',
    serial: '',
    lote: '',
    armazem_id: '',
    localizacao: '',
    minhas: false,
  });

  const fetchMovimentos = useCallback(async (targetFiltros, targetOffset) => {
    try {
      setLoading(true);
      setToast(null);
      const token = localStorage.getItem('token');
      const params = new URLSearchParams();
      Object.entries(targetFiltros || {}).forEach(([k, v]) => {
        if (typeof v === 'boolean') {
          if (k === 'minhas' && v) params.set('minhas', '1');
          return;
        }
        if (k === 'data_inicio' || k === 'data_fim') {
          const normalized = normalizeDateFilterValue(v);
          if (normalized) params.set(k, normalized);
          return;
        }
        if (String(v || '').trim()) params.set(k, String(v).trim());
      });
      params.set('page_size', String(MOVIMENTOS_PAGE_SIZE));
      params.set('offset', String(Number(targetOffset) || 0));

      const response = await fetch(`/api/requisicoes/movimentos-clog/consulta?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao consultar movimentos');
      }
      const data = await response.json();
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setColumns(Array.isArray(data?.columns) && data.columns.length ? data.columns : DEFAULT_COLUMNS);
      setTotal(Number(data?.total) || 0);
      setNextOffset(Number.isFinite(Number(data?.next_offset)) ? Number(data.next_offset) : null);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao consultar movimentos' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!serialModal && !detailRow) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setSerialModal(null);
        if (detailRow) {
          setDetailRow(null);
          cancelarEdicaoLinha();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [serialModal, detailRow]);

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

  useEffect(() => {
    const carregarArmazens = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/requisicoes/stock/meus-armazens', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        setArmazens(rows);
      } catch (_) {
        // Sem bloquear a tela caso o endpoint esteja indisponível.
      }
    };
    carregarArmazens();
  }, []);

  useEffect(() => {
    const initial = { ...filtros };
    setAppliedFiltros(initial);
    setOffset(0);
    setOffsetHistory([]);
    fetchMovimentos(initial, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchMovimentos]);

  const visibleRows = useMemo(() => rows, [rows]);
  const nFiltrosAplicados = useMemo(() => countFiltrosAtivos(appliedFiltros), [appliedFiltros]);

  const aplicarFiltros = () => {
    const next = { ...filtros };
    setAppliedFiltros(next);
    setOffset(0);
    setOffsetHistory([]);
    fetchMovimentos(next, 0);
  };

  const irProximaPagina = () => {
    if (nextOffset === null || !appliedFiltros) return;
    setOffsetHistory((prev) => [...prev, offset]);
    setOffset(nextOffset);
    fetchMovimentos(appliedFiltros, nextOffset);
  };

  const irPaginaAnterior = () => {
    if (!offsetHistory.length || !appliedFiltros) return;
    const prevOffset = offsetHistory[offsetHistory.length - 1];
    setOffsetHistory((prev) => prev.slice(0, -1));
    setOffset(prevOffset);
    fetchMovimentos(appliedFiltros, prevOffset);
  };

  const iniciarEdicaoLinha = (row) => {
    if (!isAdmin) return;
    const movId = String(row?.mov_id || '').trim();
    if (!movId) {
      setToast({ type: 'error', message: 'Linha sem identificador de movimento.' });
      return;
    }
    const draft = {};
    for (const c of columns) {
      draft[c] = String(row?.[c] ?? '');
    }
    setEditingMovId(movId);
    setEditingDraft(draft);
  };

  const cancelarEdicaoLinha = () => {
    setEditingMovId('');
    setEditingDraft({});
  };

  const guardarEdicaoLinha = async () => {
    if (!isAdmin) return;
    const movId = String(editingMovId || '').trim();
    if (!movId) return;
    const patch = { ...editingDraft };
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/requisicoes/movimentos-clog/linha', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mov_id: movId, patch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao editar linha');
      setToast({ type: 'success', message: 'Linha atualizada.' });
      if (detailRow && String(detailRow.mov_id || '').trim() === movId) {
        setDetailRow((prev) => (prev ? { ...prev, ...patch } : prev));
      }
      cancelarEdicaoLinha();
      if (appliedFiltros) await fetchMovimentos(appliedFiltros, offset);
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao editar linha' });
    }
  };

  const apagarLinhaMovimento = async (row) => {
    if (!isAdmin) return false;
    const movId = String(row?.mov_id || '').trim();
    if (!movId) {
      setToast({ type: 'error', message: 'Linha sem identificador de movimento.' });
      return false;
    }
    if (!window.confirm('Deseja apagar esta linha de movimento da consulta?')) return false;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/requisicoes/movimentos-clog/linha', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mov_id: movId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao apagar linha');
      setToast({ type: 'success', message: 'Linha apagada.' });
      if (appliedFiltros) await fetchMovimentos(appliedFiltros, offset);
      return true;
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao apagar linha' });
      return false;
    }
  };

  const openCardValueModal = (row, values, title, itemLabel) => {
    const items = Array.isArray(values)
      ? values.map((v) => String(v || '').trim()).filter(Boolean)
      : parseListaDeValores(values);
    if (!items.length) return;
    setSerialModal({
      items,
      ref: String(row?.['REF.'] ?? ''),
      tra: String(row?.['TRA / DEV'] ?? ''),
      description: String(row?.DESCRIPTION ?? ''),
      page: 1,
      title,
      itemLabel,
    });
  };

  const handleCardContextMenu = (e, row) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      row,
    });
  };

  const renderCellContent = (row, columnName, idx, compact = false) => {
    const cellRaw = String(row?.[columnName] ?? '');
    if (columnName === SN_COLUMN) {
      const serials = parseSeriaisMovimento(cellRaw);
      const longText = cellRaw.length > SN_INLINE_MAX_LEN;
      const many = serials.length > 1;
      const showButton = (many || longText) && cellRaw.length > 0;

      if (showButton) {
        return (
          <button
            type="button"
            onClick={() => openCardValueModal(row, serials.length ? serials : [cellRaw], 'Seriais (S/N)', 'serial')}
            className={`px-2 py-0.5 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50 ${
              compact ? 'mt-0.5' : ''
            }`}
          >
            {many ? `Ver seriais (${serials.length})` : 'Ver completo'}
          </button>
        );
      }
    }
    return cellRaw || '—';
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Consulta de movimentos</h1>
          <p className="text-gray-600 mt-1">
            Histórico de abastecimentos no formato do Clog, com filtros por TRA, artigo, data e localização.
          </p>
        </div>

        <div className="lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start lg:gap-4">
          <div className="mb-3 mr-auto w-full rounded-lg border border-gray-200 bg-white lg:mb-0 lg:sticky lg:top-4">
          <button
            type="button"
            onClick={() => setFiltrosExpandido((v) => !v)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-50"
            aria-expanded={filtrosExpandido}
            aria-controls="movimentos-filtros-painel"
            id="movimentos-filtros-cabecalho"
          >
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium text-gray-800">Filtros de pesquisa</div>
              {!filtrosExpandido && (
                <div className="mt-0.5 text-sm text-gray-500">
                  {nFiltrosAplicados > 0
                    ? `${nFiltrosAplicados} critério${nFiltrosAplicados > 1 ? 's' : ''} ativo${nFiltrosAplicados > 1 ? 's' : ''} · `
                    : 'Nenhum filtro extra · '}
                  {total} linhas
                  {nextOffset !== null ? ' · Há mais páginas' : ''}
                </div>
              )}
            </div>
            <ChevronDown
              size={22}
              className={`shrink-0 text-gray-500 transition-transform duration-200 ${
                filtrosExpandido ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>

          {filtrosExpandido && (
            <div
              id="movimentos-filtros-painel"
              className="border-t border-gray-100 px-3 pb-3 pt-2"
              role="region"
              aria-labelledby="movimentos-filtros-cabecalho"
            >
              <div className="grid grid-cols-1 gap-2">
                <select
                  value={filtros.armazem_id}
                  onChange={(e) => setFiltros((p) => ({ ...p, armazem_id: e.target.value }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Armazém (todos)</option>
                  {armazens.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {`${a.codigo} — ${a.descricao}`}
                    </option>
                  ))}
                </select>
                <select
                  value={filtros.tipo_movimento}
                  onChange={(e) => setFiltros((p) => ({ ...p, tipo_movimento: e.target.value }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Tipo de movimento</option>
                  <option value="saida">Saída de Armazem</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="transf. apeado">Transf. Apeado</option>
                  <option value="devolucao">Devolução de carrinha</option>
                </select>
                <input
                  value={filtros.q}
                  onChange={(e) => setFiltros((p) => ({ ...p, q: e.target.value }))}
                  placeholder="Buscar"
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-medium text-gray-600">
                    Data do movimento (início)
                    <input
                      type="date"
                      value={filtros.data_inicio}
                      onChange={(e) => setFiltros((p) => ({ ...p, data_inicio: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="text-[11px] font-medium text-gray-600">
                    Data do movimento (fim)
                    <input
                      type="date"
                      value={filtros.data_fim}
                      onChange={(e) => setFiltros((p) => ({ ...p, data_fim: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </label>
                </div>
                <input
                  value={filtros.tra_numero}
                  onChange={(e) => setFiltros((p) => ({ ...p, tra_numero: e.target.value }))}
                  placeholder="Nº TRA"
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  value={filtros.serial}
                  onChange={(e) => setFiltros((p) => ({ ...p, serial: e.target.value }))}
                  placeholder="S/N"
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  value={filtros.lote}
                  onChange={(e) => setFiltros((p) => ({ ...p, lote: e.target.value }))}
                  placeholder="Lote"
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  value={filtros.localizacao}
                  onChange={(e) => setFiltros((p) => ({ ...p, localizacao: e.target.value }))}
                  placeholder="Localização (origem/destino)"
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="flex items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={filtros.minhas}
                      onChange={(e) => setFiltros((p) => ({ ...p, minhas: e.target.checked }))}
                    />
                    Apenas abastecimentos criados por mim
                  </label>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={aplicarFiltros}
                  disabled={loading}
                  className="rounded-lg bg-[#0915FF] px-4 py-2 text-sm text-white hover:bg-[#070FCC] disabled:opacity-60"
                >
                  {loading ? 'A carregar...' : 'Aplicar filtros'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setFiltros({
                      q: '',
                      data_inicio: '',
                      data_fim: '',
                      tipo_movimento: '',
                      tra_numero: '',
                      ref: '',
                      description: '',
                      serial: '',
                      lote: '',
                      armazem_id: '',
                      localizacao: '',
                      minhas: false,
                    })
                  }
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                >
                  Limpar
                </button>
                <span className="text-sm text-gray-600">Linhas nesta página: {total}</span>
                <span className="text-xs text-gray-500">Offset: {offset}</span>
              </div>
              {armazens.length > 1 && (
                <p className="mt-2 text-xs text-gray-600">
                  Selecione um armazém para ver os movimentos no contexto desse armazém.
                </p>
              )}
            </div>
          )}
          </div>

        <div className="max-w-none space-y-1.5">
          {visibleRows.length === 0 && (
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500">
              Nenhum movimento encontrado.
            </div>
          )}
          {visibleRows.map((row, idx) => (
            <div
              key={`${row?.mov_id || ''}-${row['TRA / DEV'] || ''}-${row['REF.'] || ''}-${idx}`}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition-colors hover:border-indigo-200 hover:bg-indigo-50/20"
              onContextMenu={(e) => handleCardContextMenu(e, row)}
            >
              <div className="mb-1 border-b border-gray-100 pb-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-indigo-800">
                      {cellOrDash(row, 'Tipo de Movimento')}
                    </span>
                    <span className="shrink-0 text-[10px] font-medium tabular-nums text-gray-600">
                      {cellOrDash(row, 'Dt_Recepção')}
                    </span>
                  </div>
                  <div className="min-w-0 max-w-[62%] flex items-baseline justify-end gap-1.5">
                    <span className="min-w-0 truncate text-[11px] text-gray-700">
                      {cellOrDash(row, 'DESCRIPTION')}
                    </span>
                    <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 font-mono text-[10px] font-bold text-gray-900">
                      {cellOrDash(row, 'REF.')}
                    </span>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-6 gap-x-1.5 gap-y-0">
                <div className="text-[9px] font-medium uppercase tracking-wide text-gray-500">Qtd</div>
                <div className="min-w-0 text-[9px] font-medium uppercase tracking-wide text-gray-500">Seriais</div>
                <div className="min-w-0 text-[9px] font-medium uppercase tracking-wide text-gray-500">Lote</div>
                <div className="min-w-0 text-[9px] font-medium uppercase tracking-wide text-gray-500">Origem</div>
                <div className="min-w-0 text-[9px] font-medium uppercase tracking-wide text-gray-500">Destino</div>
                <div className="min-w-0 text-[9px] font-medium uppercase tracking-wide text-gray-500">TRA / DEV</div>
                <div className="min-w-0 text-[11px] font-semibold tabular-nums text-gray-900">
                  {cellOrDash(row, 'QTY')}
                </div>
                <div className="min-w-0">
                  {(() => {
                    const serials = parseSeriaisMovimento(row?.[SN_COLUMN]);
                    if (!serials.length) return <span className="text-[10px] text-gray-400">—</span>;
                    if (serials.length === 1) {
                      return (
                        <span className="block truncate text-[10px] font-medium text-gray-700" title={serials[0]}>
                          {serials[0]}
                        </span>
                      );
                    }
                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCardValueModal(row, serials, 'Seriais (S/N)', 'serial');
                        }}
                        className="rounded border border-gray-300 px-1.5 py-0.5 text-[9px] text-gray-700 hover:bg-gray-50"
                      >
                        Ver ({serials.length})
                      </button>
                    );
                  })()}
                </div>
                <div className="min-w-0">
                  {(() => {
                    const lotes = parseListaDeValores(row?.Lote);
                    if (!lotes.length) return <span className="text-[10px] text-gray-400">—</span>;
                    if (lotes.length === 1) {
                      return (
                        <span className="block truncate text-[10px] font-medium text-gray-700" title={lotes[0]}>
                          {lotes[0]}
                        </span>
                      );
                    }
                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCardValueModal(row, lotes, 'Lotes', 'lote');
                        }}
                        className="rounded border border-gray-300 px-1.5 py-0.5 text-[9px] text-gray-700 hover:bg-gray-50"
                      >
                        Ver ({lotes.length})
                      </button>
                    );
                  })()}
                </div>
                <div className="line-clamp-2 min-w-0 break-words text-[11px] font-medium leading-snug text-gray-800">
                  {cellOrDash(row, 'Loc_Inicial')}
                </div>
                <div className="line-clamp-2 min-w-0 break-words text-[11px] font-medium leading-snug text-gray-800">
                  {destinoResumo(row)}
                </div>
                <div className="line-clamp-2 min-w-0 break-words text-[10px] font-mono font-semibold leading-snug text-indigo-800">
                  {cellOrDash(row, 'TRA / DEV')}
                </div>
              </div>
            </div>
          ))}
        </div>
        </div>

        {contextMenu.visible && contextMenu.row && (
          <div
            ref={contextMenuRef}
            className="fixed z-50 rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="block w-full px-4 py-2 text-left hover:bg-gray-100"
              onClick={() => {
                setDetailRow(contextMenu.row);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              Abrir
            </button>
          </div>
        )}

        {detailRow && (
          <div
            className="fixed inset-0 z-[10050] flex flex-col justify-end bg-black/45 p-0 lg:items-center lg:justify-center lg:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mov-detalhe-titulo"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setDetailRow(null);
                cancelarEdicaoLinha();
              }
            }}
          >
            <div
              className="flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl lg:max-h-[85vh] lg:max-w-2xl lg:rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
                <h2 id="mov-detalhe-titulo" className="text-base font-semibold text-gray-900">
                  Detalhe do movimento
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setDetailRow(null);
                    cancelarEdicaoLinha();
                  }}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Fechar
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  {columns.map((c) => {
                    const editingThis = isAdmin && editingMovId === String(detailRow?.mov_id || '').trim();
                    if (editingThis) {
                      return (
                        <div key={c} className="border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{c}</div>
                          <input
                            value={editingDraft[c] ?? ''}
                            onChange={(e) => setEditingDraft((p) => ({ ...p, [c]: e.target.value }))}
                            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                            aria-label={c}
                          />
                        </div>
                      );
                    }
                    return (
                      <div key={c} className="border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{c}</div>
                        <div className="mt-1 break-words text-sm text-gray-900">
                          {renderCellContent(detailRow, c, 0, true)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 flex-wrap gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3">
                  {editingMovId === String(detailRow?.mov_id || '').trim() ? (
                    <>
                      <button
                        type="button"
                        onClick={guardarEdicaoLinha}
                        className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50"
                      >
                        Guardar
                      </button>
                      <button
                        type="button"
                        onClick={cancelarEdicaoLinha}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-100"
                      >
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => iniciarEdicaoLinha(detailRow)}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-100"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await apagarLinhaMovimento(detailRow);
                          if (ok) setDetailRow(null);
                        }}
                        className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                      >
                        Apagar
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={irPaginaAnterior}
            disabled={loading || offsetHistory.length === 0}
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Anterior
          </button>
          <button
            type="button"
            onClick={irProximaPagina}
            disabled={loading || nextOffset === null}
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Próxima
          </button>
          <span className="text-xs text-gray-500">
            Página otimizada: no máximo {pageSize} linhas por consulta.
          </span>
        </div>

        {serialModal &&
          (() => {
            const total = Array.isArray(serialModal.items) ? serialModal.items.length : 0;
            const totalPages = Math.max(1, Math.ceil(total / SN_MODAL_PAGE_SIZE));
            const page = Math.min(Math.max(1, Number(serialModal.page) || 1), totalPages);
            const start = (page - 1) * SN_MODAL_PAGE_SIZE;
            const slice = (serialModal.items || []).slice(start, start + SN_MODAL_PAGE_SIZE);
            return (
              <div
                className="fixed inset-0 z-[10060] flex items-center justify-center p-4 bg-black/50"
                aria-modal="true"
                role="dialog"
                aria-labelledby="consulta-seriais-titulo"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setSerialModal(null);
                }}
              >
                <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
                  <div className="flex items-center justify-between gap-2 p-4 border-b border-gray-200 shrink-0">
                    <div>
                      <h3 id="consulta-seriais-titulo" className="text-base font-semibold text-gray-900">
                        {serialModal.title || 'Detalhes'}
                      </h3>
                      <p className="text-xs text-gray-500 mt-1">
                        {serialModal.ref ? (
                          <>
                            REF. <span className="font-medium text-gray-700">{serialModal.ref}</span>
                            {serialModal.tra ? (
                              <>
                                {' · '}
                                TRA / DEV{' '}
                                <span className="font-medium text-gray-700">{serialModal.tra}</span>
                              </>
                            ) : null}
                          </>
                        ) : (
                          serialModal.tra || 'Movimento'
                        )}
                      </p>
                      {serialModal.description ? (
                        <p className="text-xs text-gray-600 mt-1 line-clamp-2">{serialModal.description}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSerialModal(null)}
                      className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 text-sm shrink-0"
                    >
                      Fechar
                    </button>
                  </div>
                  <div className="p-4 overflow-y-auto flex-1 min-h-0">
                    <ol className="list-decimal list-inside space-y-2 text-sm text-gray-800" start={start + 1}>
                      {slice.map((sn, i) => (
                        <li key={`${start + i}-${sn}`} className="break-all pl-1">
                          {sn}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="p-4 border-t flex flex-wrap items-center justify-between gap-2 shrink-0">
                    <span className="text-xs text-gray-600">
                      Página {page} / {totalPages} · {total} {serialModal.itemLabel || 'item'}(s)
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() =>
                          setSerialModal((m) => ({ ...m, page: Math.max(1, (Number(m?.page) || 1) - 1) }))
                        }
                        className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm disabled:opacity-50"
                      >
                        Anterior
                      </button>
                      <button
                        type="button"
                        disabled={page >= totalPages}
                        onClick={() =>
                          setSerialModal((m) => ({
                            ...m,
                            page: Math.min(totalPages, (Number(m?.page) || 1) + 1),
                          }))
                        }
                        className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm disabled:opacity-50"
                      >
                        Seguinte
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      </div>
    </div>
  );
};

export default ConsultaMovimentos;
