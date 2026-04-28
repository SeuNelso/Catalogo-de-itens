import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Toast from '../components/Toast';

const PAGE_SIZE = 40;
const MAX_PAGES = 250;

function normalizeDateFilterValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return s;
}

function numberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDateBR(v) {
  const s = String(v || '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return 0;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function parseSeriais(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/\r?\n|;|\|/)
    .flatMap((part) => String(part || '').split(/\s*,\s*/))
    .map((x) => x.trim())
    .filter(Boolean);
}

function detectarViaturaDaLinha(row, tiposPorId, viaturaIdsFallback) {
  const origemId = Number(row?.armazem_origem_id || 0);
  const destinoId = Number(row?.armazem_id || 0);
  const origemTipoRow = String(row?.armazem_origem_tipo || '').trim().toLowerCase();
  const destinoTipoRow = String(row?.armazem_destino_tipo || '').trim().toLowerCase();
  const origemTipo = origemTipoRow || tiposPorId.get(origemId) || '';
  const destinoTipo = destinoTipoRow || tiposPorId.get(destinoId) || '';
  const origemDesc = String(row?.armazem_origem_descricao || row?.Loc_Inicial || '').trim();
  const destinoDesc = String(
    row?.armazem_destino_descricao || row?.['Novo Armazém'] || row?.['New Localização'] || ''
  ).trim();

  if (destinoTipo === 'viatura' || viaturaIdsFallback.has(destinoId)) {
    return { id: destinoId, nome: destinoDesc || `Viatura #${destinoId}`, sentido: 'entrada' };
  }
  if (origemTipo === 'viatura' || viaturaIdsFallback.has(origemId)) {
    return { id: origemId, nome: origemDesc || `Viatura #${origemId}`, sentido: 'saida' };
  }
  return null;
}

const DashboardViaturas = () => {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [armazens, setArmazens] = useState([]);
  const [rows, setRows] = useState([]);
  const [selectedViaturaId, setSelectedViaturaId] = useState('');
  const [filtros, setFiltros] = useState({
    data_inicio: '',
    data_fim: '',
    armazem_id: '',
    ref: '',
    description: '',
  });

  const tiposPorId = useMemo(() => {
    const map = new Map();
    for (const arm of armazens || []) {
      const id = Number(arm?.id || 0);
      if (!id) continue;
      map.set(id, String(arm?.tipo || '').trim().toLowerCase());
    }
    return map;
  }, [armazens]);

  const viaturaIdsFallback = useMemo(() => {
    const all = (armazens || []).filter((a) => Number(a?.id) > 0);
    const explicitas = all.filter((a) => String(a?.tipo || '').trim().toLowerCase() === 'viatura');
    if (explicitas.length > 0) {
      return new Set(explicitas.map((a) => Number(a.id)));
    }
    // Fallback: alguns payloads não trazem `tipo`; nesse caso, usar armazéns não-centrais.
    return new Set(
      all
        .filter((a) => String(a?.tipo || '').trim().toLowerCase() !== 'central')
        .map((a) => Number(a.id))
    );
  }, [armazens]);

  const armazensViatura = useMemo(() => {
    const all = Array.isArray(armazens) ? armazens : [];
    const byId = new Map();
    for (const arm of all) {
      const id = Number(arm?.id || 0);
      if (!id || !viaturaIdsFallback.has(id)) continue;
      if (!byId.has(id)) byId.set(id, arm);
    }
    return Array.from(byId.values());
  }, [armazens, viaturaIdsFallback]);

  const carregarArmazens = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const responseMeus = await fetch('/api/requisicoes/stock/meus-armazens', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const responseAll = await fetch('/api/armazens?ativo=true', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const dataMeus = responseMeus.ok ? await responseMeus.json().catch(() => ({})) : {};
      const dataAll = responseAll.ok ? await responseAll.json().catch(() => ({})) : {};
      const rowsMeus = Array.isArray(dataMeus?.rows) ? dataMeus.rows : [];
      const rowsAll = Array.isArray(dataAll?.armazens)
        ? dataAll.armazens
        : (Array.isArray(dataAll?.rows) ? dataAll.rows : []);
      const merged = new Map();
      for (const a of [...rowsAll, ...rowsMeus]) {
        const id = Number(a?.id || 0);
        if (id > 0) merged.set(id, a);
      }
      setArmazens(Array.from(merged.values()));
    } catch (_) {
      setArmazens([]);
    }
  }, []);

  const fetchAllRows = useCallback(async (targetFiltros) => {
    const token = localStorage.getItem('token');
    const rowsOut = [];
    const visitedOffsets = new Set();
    let offset = 0;
    let page = 0;

    while (page < MAX_PAGES) {
      if (visitedOffsets.has(offset)) break;
      visitedOffsets.add(offset);
      const params = new URLSearchParams();
      params.set('page_size', String(PAGE_SIZE));
      params.set('offset', String(offset));
      const dataInicioNorm = normalizeDateFilterValue(targetFiltros?.data_inicio);
      const dataFimNorm = normalizeDateFilterValue(targetFiltros?.data_fim);
      if (dataInicioNorm) params.set('data_inicio', dataInicioNorm);
      if (dataFimNorm) params.set('data_fim', dataFimNorm);
      if (String(targetFiltros?.armazem_id || '').trim()) params.set('armazem_id', String(targetFiltros.armazem_id));
      if (String(targetFiltros?.ref || '').trim()) params.set('ref', String(targetFiltros.ref).trim());
      if (String(targetFiltros?.description || '').trim()) params.set('description', String(targetFiltros.description).trim());

      const response = await fetch(`/api/requisicoes/movimentos-clog/consulta?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || 'Erro ao carregar movimentos das viaturas');
      }
      const data = await response.json();
      const batch = Array.isArray(data?.rows) ? data.rows : [];
      rowsOut.push(...batch);
      const next = Number.isFinite(Number(data?.next_offset)) ? Number(data.next_offset) : null;
      if (next === null || next <= offset) break;
      offset = next;
      page += 1;
    }

    return rowsOut;
  }, []);

  const carregarDashboard = useCallback(async () => {
    try {
      setLoading(true);
      setToast(null);
      const allRows = await fetchAllRows(filtros);
      setRows(allRows);
      if (selectedViaturaId && !allRows.some((r) => Number(r?.armazem_id || 0) === Number(selectedViaturaId) || Number(r?.armazem_origem_id || 0) === Number(selectedViaturaId))) {
        setSelectedViaturaId('');
      }
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao carregar dashboard' });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [fetchAllRows, filtros, selectedViaturaId]);

  useEffect(() => {
    carregarArmazens();
  }, [carregarArmazens]);

  useEffect(() => {
    carregarDashboard();
  }, [carregarDashboard]);

  useEffect(() => {
    const id = String(filtros.armazem_id || '').trim();
    if (!id) return;
    setSelectedViaturaId(id);
  }, [filtros.armazem_id]);

  const agregados = useMemo(() => {
    const byViatura = new Map();
    let totalAbastecido = 0;
    let totalDevolvido = 0;
    let totalSeriais = 0;

    for (const row of rows || []) {
      const v = detectarViaturaDaLinha(row, tiposPorId, viaturaIdsFallback);
      if (!v) continue;

      const qtyRaw = numberOrZero(row?.QTY);
      const qtdAbs = Math.abs(qtyRaw);
      const key = Number(v.id || 0) || v.nome;
      const nome = String(v.nome || '').trim() || `Viatura ${key}`;
      const current = byViatura.get(key) || {
        viatura_id: Number(v.id || 0) || null,
        viatura_nome: nome,
        abastecido: 0,
        devolvido: 0,
        movimentos: 0,
        serials: 0,
        ultimo_ts: 0,
        ultimo_texto: '',
      };

      if (v.sentido === 'entrada') {
        current.abastecido += qtdAbs;
        totalAbastecido += qtdAbs;
      } else {
        current.devolvido += qtdAbs;
        totalDevolvido += qtdAbs;
      }
      const serialCount = parseSeriais(row?.['S/N']).length;
      current.serials += serialCount;
      totalSeriais += serialCount;
      current.movimentos += 1;
      const ts = parseDateBR(row?.['Dt_Recepção']);
      if (ts >= current.ultimo_ts) {
        current.ultimo_ts = ts;
        current.ultimo_texto = String(row?.['Dt_Recepção'] || '').trim();
      }
      byViatura.set(key, current);
    }

    const lista = Array.from(byViatura.values())
      .map((x) => ({ ...x, saldo: x.abastecido - x.devolvido }))
      .sort((a, b) => b.abastecido - a.abastecido || b.movimentos - a.movimentos);

    return {
      lista,
      totalAbastecido,
      totalDevolvido,
      totalSeriais,
      totalViaturas: lista.length,
    };
  }, [rows, tiposPorId, viaturaIdsFallback]);

  const detalhesViatura = useMemo(() => {
    const selected = Number(selectedViaturaId || 0);
    if (!selected) return [];
    const itens = new Map();
    for (const row of rows || []) {
      const v = detectarViaturaDaLinha(row, tiposPorId, viaturaIdsFallback);
      if (!v || Number(v.id || 0) !== selected) continue;
      const ref = String(row?.['REF.'] || '').trim();
      const desc = String(row?.DESCRIPTION || '').trim();
      const key = `${ref}__${desc}`;
      const current = itens.get(key) || { ref, description: desc, abastecido: 0, devolvido: 0, saldo: 0 };
      const qty = Math.abs(numberOrZero(row?.QTY));
      if (v.sentido === 'entrada') current.abastecido += qty;
      else current.devolvido += qty;
      current.saldo = current.abastecido - current.devolvido;
      itens.set(key, current);
    }
    return Array.from(itens.values()).sort((a, b) => b.abastecido - a.abastecido);
  }, [rows, selectedViaturaId, tiposPorId, viaturaIdsFallback]);

  const viaturasSelectOptions = useMemo(() => {
    const byId = new Map();
    for (const v of armazensViatura) {
      const id = Number(v?.id || 0);
      if (!id) continue;
      byId.set(id, String(v?.descricao || v?.codigo || `Viatura ${id}`).trim());
    }
    for (const agg of agregados.lista || []) {
      const id = Number(agg?.viatura_id || 0);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, String(agg?.viatura_nome || `Viatura ${id}`).trim());
    }
    return Array.from(byId.entries())
      .map(([id, nome]) => ({ id, nome: nome || `Viatura ${id}` }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }, [armazensViatura, agregados.lista]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 via-indigo-50 to-white p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-white border border-blue-100 rounded-2xl p-4 md:p-5 shadow-sm">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Data início</label>
              <input
                type="date"
                value={filtros.data_inicio}
                onChange={(e) => setFiltros((prev) => ({ ...prev, data_inicio: e.target.value }))}
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Data fim</label>
              <input
                type="date"
                value={filtros.data_fim}
                onChange={(e) => setFiltros((prev) => ({ ...prev, data_fim: e.target.value }))}
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Viatura</label>
              <select
                value={filtros.armazem_id}
                onChange={(e) => {
                  const viaturaId = String(e.target.value || '');
                  setFiltros((prev) => ({ ...prev, armazem_id: viaturaId }));
                  setSelectedViaturaId(viaturaId);
                }}
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm min-w-[220px]"
              >
                <option value="">Todas</option>
                {viaturasSelectOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.nome}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">REF.</label>
              <input
                value={filtros.ref}
                onChange={(e) => setFiltros((prev) => ({ ...prev, ref: e.target.value }))}
                placeholder="Filtrar por referência"
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Descrição</label>
              <input
                value={filtros.description}
                onChange={(e) => setFiltros((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Filtrar por descrição"
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={carregarDashboard}
              disabled={loading}
              className="h-10 px-4 rounded-lg bg-[#0915FF] text-white text-sm font-semibold disabled:opacity-60"
            >
              {loading ? 'A carregar...' : 'Atualizar'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="bg-white border border-blue-100 rounded-xl p-4">
            <div className="text-xs text-gray-500">Viaturas com movimentos</div>
            <div className="text-2xl font-bold text-gray-900">{agregados.totalViaturas}</div>
          </div>
          <div className="bg-white border border-emerald-100 rounded-xl p-4">
            <div className="text-xs text-gray-500">Total abastecido</div>
            <div className="text-2xl font-bold text-emerald-700">{agregados.totalAbastecido}</div>
          </div>
          <div className="bg-white border border-amber-100 rounded-xl p-4">
            <div className="text-xs text-gray-500">Total devolvido</div>
            <div className="text-2xl font-bold text-amber-700">{agregados.totalDevolvido}</div>
          </div>
          <div className="bg-white border border-violet-100 rounded-xl p-4">
            <div className="text-xs text-gray-500">Seriais movimentados</div>
            <div className="text-2xl font-bold text-violet-700">{agregados.totalSeriais}</div>
          </div>
        </div>

        <div className="bg-white border border-blue-100 rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#F6F8FF] text-gray-700">
                <tr>
                  <th className="text-left px-4 py-3">Viatura</th>
                  <th className="text-right px-4 py-3">Abastecido</th>
                  <th className="text-right px-4 py-3">Devolvido</th>
                  <th className="text-right px-4 py-3">Saldo</th>
                  <th className="text-right px-4 py-3">Movimentos</th>
                  <th className="text-right px-4 py-3">Seriais</th>
                  <th className="text-right px-4 py-3">Último movimento</th>
                </tr>
              </thead>
              <tbody>
                {agregados.lista.map((row) => {
                  const active = Number(selectedViaturaId || 0) === Number(row.viatura_id || 0);
                  return (
                    <tr
                      key={`${row.viatura_id || row.viatura_nome}`}
                      onClick={() => setSelectedViaturaId(String(row.viatura_id || ''))}
                      className={`border-t cursor-pointer ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{row.viatura_nome}</td>
                      <td className="px-4 py-3 text-right text-emerald-700 font-semibold">{row.abastecido}</td>
                      <td className="px-4 py-3 text-right text-amber-700 font-semibold">{row.devolvido}</td>
                      <td className="px-4 py-3 text-right font-semibold">{row.saldo}</td>
                      <td className="px-4 py-3 text-right">{row.movimentos}</td>
                      <td className="px-4 py-3 text-right">{row.serials}</td>
                      <td className="px-4 py-3 text-right">{row.ultimo_texto || '—'}</td>
                    </tr>
                  );
                })}
                {!loading && agregados.lista.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      Sem dados para o período/filtros selecionados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {Number(selectedViaturaId || 0) > 0 && (
          <div className="bg-white border border-blue-100 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b bg-[#F6F8FF]">
              <h3 className="font-semibold text-gray-900">Materiais da viatura selecionada</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-gray-700 bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3">REF.</th>
                    <th className="text-left px-4 py-3">Descrição</th>
                    <th className="text-right px-4 py-3">Abastecido</th>
                    <th className="text-right px-4 py-3">Devolvido</th>
                    <th className="text-right px-4 py-3">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhesViatura.map((item) => (
                    <tr key={`${item.ref}__${item.description}`} className="border-t">
                      <td className="px-4 py-3 font-medium">{item.ref || '—'}</td>
                      <td className="px-4 py-3">{item.description || '—'}</td>
                      <td className="px-4 py-3 text-right text-emerald-700 font-semibold">{item.abastecido}</td>
                      <td className="px-4 py-3 text-right text-amber-700 font-semibold">{item.devolvido}</td>
                      <td className="px-4 py-3 text-right font-semibold">{item.saldo}</td>
                    </tr>
                  ))}
                  {!loading && detalhesViatura.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                        Sem materiais para esta viatura nos filtros atuais.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
};

export default DashboardViaturas;
