import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Toast from '../components/Toast';

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

const ConsultaMovimentos = () => {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [total, setTotal] = useState(0);
  const [appliedFiltros, setAppliedFiltros] = useState(null);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [offsetHistory, setOffsetHistory] = useState([]);
  const pageSize = 200;
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
    armazem: '',
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
      params.set('page_size', String(pageSize));
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
            <input
              value={filtros.armazem}
              onChange={(e) => setFiltros((p) => ({ ...p, armazem: e.target.value }))}
              placeholder="Novo Armazém"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
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
                  armazem: '',
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
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleRows.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-gray-500" colSpan={columns.length}>
                    Nenhum movimento encontrado.
                  </td>
                </tr>
              )}
              {visibleRows.map((row, idx) => (
                <tr key={`${row['TRA / DEV'] || ''}-${row['REF.'] || ''}-${idx}`} className="hover:bg-gray-50">
                  {columns.map((c) => (
                    <td key={`${c}-${idx}`} className="px-3 py-2 text-gray-800 whitespace-nowrap">
                      {String(row?.[c] ?? '')}
                    </td>
                  ))}
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

        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      </div>
    </div>
  );
};

export default ConsultaMovimentos;
