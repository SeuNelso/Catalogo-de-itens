import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

function parseSeriaisMovimento(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/\r?\n|;|\|/)
    .flatMap((part) => String(part || '').split(/\s*,\s*/))
    .map((x) => x.trim())
    .filter(Boolean);
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
  /** { serials, ref, tra, description } | null */
  const [serialModal, setSerialModal] = useState(null);
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
    if (!serialModal) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setSerialModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [serialModal]);

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
      cancelarEdicaoLinha();
      if (appliedFiltros) await fetchMovimentos(appliedFiltros, offset);
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao editar linha' });
    }
  };

  const apagarLinhaMovimento = async (row) => {
    if (!isAdmin) return;
    const movId = String(row?.mov_id || '').trim();
    if (!movId) {
      setToast({ type: 'error', message: 'Linha sem identificador de movimento.' });
      return;
    }
    if (!window.confirm('Deseja apagar esta linha de movimento da consulta?')) return;
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
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao apagar linha' });
    }
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

        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
            <input
              value={filtros.q}
              onChange={(e) => setFiltros((p) => ({ ...p, q: e.target.value }))}
              placeholder="Busca geral"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="date"
              value={filtros.data_inicio}
              onChange={(e) => setFiltros((p) => ({ ...p, data_inicio: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="date"
              value={filtros.data_fim}
              onChange={(e) => setFiltros((p) => ({ ...p, data_fim: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              value={filtros.tra_numero}
              onChange={(e) => setFiltros((p) => ({ ...p, tra_numero: e.target.value }))}
              placeholder="Nº TRA"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <select
              value={filtros.tipo_movimento}
              onChange={(e) => setFiltros((p) => ({ ...p, tipo_movimento: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">Tipo de movimento</option>
              <option value="saida">Saída de Armazem</option>
              <option value="transferencia">Transferencia</option>
              <option value="transf. apeado">Transf. Apeado</option>
              <option value="devolucao">Devolução de carrinha</option>
            </select>
            <input
              value={filtros.ref}
              onChange={(e) => setFiltros((p) => ({ ...p, ref: e.target.value }))}
              placeholder="REF. artigo"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              value={filtros.description}
              onChange={(e) => setFiltros((p) => ({ ...p, description: e.target.value }))}
              placeholder="Descrição"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              value={filtros.serial}
              onChange={(e) => setFiltros((p) => ({ ...p, serial: e.target.value }))}
              placeholder="S/N"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              value={filtros.lote}
              onChange={(e) => setFiltros((p) => ({ ...p, lote: e.target.value }))}
              placeholder="Lote"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <select
              value={filtros.armazem_id}
              onChange={(e) => setFiltros((p) => ({ ...p, armazem_id: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">Armazém (todos)</option>
              {armazens.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {`${a.codigo} — ${a.descricao}`}
                </option>
              ))}
            </select>
            <input
              value={filtros.localizacao}
              onChange={(e) => setFiltros((p) => ({ ...p, localizacao: e.target.value }))}
              placeholder="Localização (origem/destino)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
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

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={aplicarFiltros}
              disabled={loading}
              className="px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] disabled:opacity-60 text-sm"
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
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
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

        <div className="bg-white rounded-lg border border-gray-200 overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 border-b border-gray-200 text-left text-gray-700 whitespace-nowrap">
                    {c}
                  </th>
                ))}
                {isAdmin && (
                  <th className="px-3 py-2 border-b border-gray-200 text-left text-gray-700 whitespace-nowrap">
                    Ações
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleRows.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-gray-500" colSpan={columns.length + (isAdmin ? 1 : 0)}>
                    Nenhum movimento encontrado.
                  </td>
                </tr>
              )}
              {visibleRows.map((row, idx) => (
                <tr key={`${row['TRA / DEV'] || ''}-${row['REF.'] || ''}-${idx}`} className="hover:bg-gray-50">
                  {columns.map((c) => {
                    const editingRow = editingMovId === String(row?.mov_id || '').trim();
                    const cellRaw = String(row?.[c] ?? '');

                    if (editingRow) {
                      return (
                        <td key={`${c}-${idx}`} className="px-3 py-2 text-gray-800 whitespace-nowrap">
                          <input
                            value={editingDraft[c] ?? ''}
                            onChange={(e) => setEditingDraft((p) => ({ ...p, [c]: e.target.value }))}
                            className="px-2 py-1 border border-gray-300 rounded text-xs min-w-[120px]"
                          />
                        </td>
                      );
                    }

                    if (c === SN_COLUMN) {
                      const serials = parseSeriaisMovimento(cellRaw);
                      const longText = cellRaw.length > SN_INLINE_MAX_LEN;
                      const many = serials.length > 1;
                      const showButton = (many || longText) && cellRaw.length > 0;

                      if (showButton) {
                        return (
                          <td key={`${c}-${idx}`} className="px-3 py-2 text-gray-800 align-top whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() =>
                                setSerialModal({
                                  serials: serials.length ? serials : [cellRaw],
                                  ref: String(row['REF.'] ?? ''),
                                  tra: String(row['TRA / DEV'] ?? ''),
                                  description: String(row.DESCRIPTION ?? ''),
                                })
                              }
                              className="px-2 py-0.5 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                            >
                              {many ? `Ver seriais (${serials.length})` : 'Ver completo'}
                            </button>
                          </td>
                        );
                      }

                      return (
                        <td key={`${c}-${idx}`} className="px-3 py-2 text-gray-800 whitespace-nowrap">
                          {cellRaw}
                        </td>
                      );
                    }

                    return (
                      <td key={`${c}-${idx}`} className="px-3 py-2 text-gray-800 whitespace-nowrap">
                        {cellRaw}
                      </td>
                    );
                  })}
                  {isAdmin && (
                    <td className="px-3 py-2 text-gray-800 whitespace-nowrap">
                      {editingMovId === String(row?.mov_id || '').trim() ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={guardarEdicaoLinha}
                            className="px-2 py-1 text-xs rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          >
                            Guardar
                          </button>
                          <button
                            type="button"
                            onClick={cancelarEdicaoLinha}
                            className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => iniciarEdicaoLinha(row)}
                            className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            onClick={() => apagarLinhaMovimento(row)}
                            className="px-2 py-1 text-xs rounded border border-red-300 text-red-700 hover:bg-red-50"
                          >
                            Apagar
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

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

        {serialModal && (
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
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
                    Seriais (S/N)
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
                <ol className="list-decimal list-inside space-y-2 text-sm text-gray-800">
                  {serialModal.serials.map((sn, i) => (
                    <li key={`${i}-${sn}`} className="break-all pl-1">
                      {sn}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        )}

        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      </div>
    </div>
  );
};

export default ConsultaMovimentos;
