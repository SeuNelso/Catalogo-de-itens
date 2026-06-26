import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaChevronDown, FaChevronUp } from 'react-icons/fa';
import { FiRefreshCw } from 'react-icons/fi';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../utils/apiUrl';
import { podeUsarConsultaMovimentos } from '../utils/controloStock';

const FALLBACK_LOCATION = 'RECEBIMENTO.E';
const PAGE_SIZE = 40;
const REFRESH_MS = 60000;
const MAX_ITEMS = 20;
const RECEBIMENTO_REFRESH_EVENT = 'recebimento-card-refresh';

const formatDate = (value) => {
  const s = String(value || '').trim();
  if (!s) return '-';
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return s;
  return dt.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};


const formatQtyDecimal = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('pt-PT', { maximumFractionDigits: 4 });
};

const formatQtyForMonitorRow = (row) => {
  const q = formatQtyDecimal(row?.qtd);
  const tip = String(row?.tipocontrolo || '').trim().toUpperCase();
  if (tip === 'LOTE') return `${q} m`;
  return q;
};

const firstNonEmpty = (...values) => {
  for (const v of values) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
};

function ReceptionMonitorCard() {
  const navigate = useNavigate();
  const { isAuthenticated, loading, user } = useAuth();
  const [rows, setRows] = useState([]);
  const [prefillItems, setPrefillItems] = useState([]);
  const [error, setError] = useState('');
  const [loadingRows, setLoadingRows] = useState(false);
  const [targetLocation, setTargetLocation] = useState(FALLBACK_LOCATION);
  const [targetLocationApeados, setTargetLocationApeados] = useState(FALLBACK_LOCATION);
  const [targetArmazemId, setTargetArmazemId] = useState(null);
  const [targetArmazemLabel, setTargetArmazemLabel] = useState('');
  const [armazensDisponiveis, setArmazensDisponiveis] = useState([]);
  const [selectedArmazemId, setSelectedArmazemId] = useState('');
  const [collapsed, setCollapsed] = useState(true);
  const [totalArtigosRececao, setTotalArtigosRececao] = useState(0);
  const [showAtualizado, setShowAtualizado] = useState(false);
  const [totaisPorCategoria, setTotaisPorCategoria] = useState({});
  const [contagensPorCategoria, setContagensPorCategoria] = useState({});
  const [clearingTest, setClearingTest] = useState(false);
  const hideAtualizadoTimerRef = useRef(null);
  const requestSeqRef = useRef(0);
  const activeAbortRef = useRef(null);

  const canView = useMemo(
    () => isAuthenticated && !loading && podeUsarConsultaMovimentos(user),
    [isAuthenticated, loading, user]
  );
  const canArmazenar = ['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador'].includes(
    String(user?.role || '').trim().toLowerCase()
  );
  const isAdminUser = String(user?.role || '').trim().toLowerCase() === 'admin';

  const resolveTargetLocation = useCallback(async (token) => {
    try {
      const response = await fetch(apiUrl('/api/requisicoes/stock/meus-armazens'), {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!response.ok) {
        return { location: FALLBACK_LOCATION, armazemId: null, armazemLabel: '' };
      }
      const data = await response.json().catch(() => ({}));
      const options = (Array.isArray(data?.rows) ? data.rows : [])
        .filter((row) => String(row?.tipo || '').trim().toLowerCase() === 'central')
        .map((row) => {
          const armazemId = Number(row?.id || 0);
          if (!Number.isFinite(armazemId) || armazemId <= 0) return null;
          return {
            id: String(armazemId),
            label: firstNonEmpty(
              row?.codigo && row?.descricao ? `${String(row.codigo).trim()} - ${String(row.descricao).trim()}` : '',
              row?.codigo,
              row?.descricao
            ),
            location: String(row?.localizacao_recebimento || '').trim() || FALLBACK_LOCATION,
          };
        })
        .filter(Boolean);
      setArmazensDisponiveis(options);
      const selected = options.find((opt) => String(opt.id) === String(selectedArmazemId)) || options[0] || null;
      if (selected && String(selected.id) !== String(selectedArmazemId)) {
        setSelectedArmazemId(String(selected.id));
      }
      return {
        location: selected?.location || FALLBACK_LOCATION,
        armazemId: selected ? Number(selected.id) : null,
        armazemLabel: selected?.label || '',
      };
    } catch (_) {
      return { location: FALLBACK_LOCATION, armazemId: null, armazemLabel: '' };
    }
  }, [selectedArmazemId]);

  const fetchRows = useCallback(async () => {
    if (!canView) return;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
    }
    const ac = new AbortController();
    activeAbortRef.current = ac;
    setLoadingRows(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        if (requestSeq !== requestSeqRef.current) return;
        setRows([]);
        return;
      }
      const resolved = await resolveTargetLocation(token);
      if (requestSeq !== requestSeqRef.current) return;
      const resolvedLocation = String(resolved?.location || FALLBACK_LOCATION).trim() || FALLBACK_LOCATION;
      const resolvedArmazemId = Number(resolved?.armazemId || 0) || null;
      setTargetLocation(resolvedLocation);
      setTargetArmazemId(resolvedArmazemId);
      setTargetArmazemLabel(String(resolved?.armazemLabel || '').trim());

      if (!resolvedArmazemId) {
        setRows([]);
        setPrefillItems([]);
        setTotalArtigosRececao(0);
        setTotaisPorCategoria({});
        setContagensPorCategoria({});
        setError('');
        return;
      }

      const params = new URLSearchParams({
        armazem_id: String(resolvedArmazemId),
        localizacao: resolvedLocation,
        limit: String(PAGE_SIZE),
        offset: '0',
      });
      const response = await fetch(apiUrl(`/api/requisicoes/transferencias/recebimento/monitor?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: ac.signal,
      });

      if (response.status === 403) {
        if (requestSeq !== requestSeqRef.current) return;
        setRows([]);
        setTotalArtigosRececao(0);
        setTotaisPorCategoria({});
        setContagensPorCategoria({});
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao carregar monitor de recebimento.');
      }

      const data = await response.json().catch(() => ({}));
      if (requestSeq !== requestSeqRef.current) return;
      const locApeadosApi = String(data?.localizacao_apeados || '').trim();
      if (locApeadosApi) setTargetLocationApeados(locApeadosApi);
      else setTargetLocationApeados(resolvedLocation);
      const apiRows = Array.isArray(data?.rows) ? data.rows : [];
      const apiPrefillItems = Array.isArray(data?.prefill_items) ? data.prefill_items : [];
      setTotaisPorCategoria(data?.totais_por_categoria && typeof data.totais_por_categoria === 'object' ? data.totais_por_categoria : {});
      setContagensPorCategoria(data?.contagens_por_categoria && typeof data.contagens_por_categoria === 'object' ? data.contagens_por_categoria : {});
      setTotalArtigosRececao(
        Number(data?.total_unidades ?? data?.total ?? apiRows.length) || 0
      );
      setRows(
        apiRows
          .map((r) => ({
            item_id: Number(r?.item_id || 0) || null,
            codigo: String(r?.codigo || '').trim(),
            descricao: String(r?.descricao || '').trim(),
            tipocontrolo: String(r?.tipocontrolo || '').trim(),
            seriais: Array.isArray(r?.seriais)
              ? r.seriais.map((s) => String(s || '').trim()).filter(Boolean)
              : [],
            lotes: Array.isArray(r?.lotes)
              ? r.lotes.map((s) => String(s || '').trim()).filter(Boolean)
              : [],
            qtd: Number(r?.qtd || 0) || 0,
            armazem: String(r?.armazem || '').trim(),
            tra: String(r?.referencia || r?.tra || '').trim(),
            data: String(r?.data || '').trim(),
            categoria: String(r?.categoria || 'devolucao').trim().toLowerCase() || 'devolucao',
          }))
          .filter((r) => r.codigo && r.qtd > 0)
          .slice(0, MAX_ITEMS)
      );
      setPrefillItems(
        apiPrefillItems
          .map((r) => ({
            item_id: Number(r?.item_id || 0) || null,
            codigo: String(r?.codigo || '').trim(),
            descricao: String(r?.descricao || '').trim(),
            tipocontrolo: String(r?.tipocontrolo || '').trim(),
            particao: String(r?.particao || 'normal').trim().toLowerCase() === 'apeado' ? 'apeado' : 'normal',
            quantidade: Number(r?.quantidade || 0) || 0,
            seriais: Array.isArray(r?.seriais)
              ? r.seriais.map((s) => String(s || '').trim()).filter(Boolean)
              : [],
            lotes: Array.isArray(r?.lotes)
              ? r.lotes.map((s) => String(s || '').trim()).filter(Boolean)
              : [],
            referencias: Array.isArray(r?.referencias)
              ? r.referencias.map((s) => String(s || '').trim()).filter(Boolean)
              : [],
            origem_localizacao: String(r?.origem_localizacao || '').trim(),
          }))
          .filter((r) => r.codigo && r.quantidade > 0)
      );
      setError('');
      setShowAtualizado(true);
      if (hideAtualizadoTimerRef.current) window.clearTimeout(hideAtualizadoTimerRef.current);
      hideAtualizadoTimerRef.current = window.setTimeout(() => setShowAtualizado(false), 1800);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (requestSeq !== requestSeqRef.current) return;
      setError(e.message || 'Erro ao carregar monitor de recebimento.');
      setShowAtualizado(false);
    } finally {
      if (requestSeq !== requestSeqRef.current) return;
      if (activeAbortRef.current === ac) activeAbortRef.current = null;
      setLoadingRows(false);
    }
  }, [canView, resolveTargetLocation]);

  useEffect(() => () => {
    if (hideAtualizadoTimerRef.current) window.clearTimeout(hideAtualizadoTimerRef.current);
    if (activeAbortRef.current) activeAbortRef.current.abort();
  }, []);

  useEffect(() => {
    if (!canView) return undefined;
    fetchRows();
    const timer = window.setInterval(fetchRows, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [canView, fetchRows]);

  useEffect(() => {
    if (!canView || !selectedArmazemId) return;
    fetchRows();
  }, [canView, selectedArmazemId, fetchRows]);

  useEffect(() => {
    if (!canView) return undefined;
    const onRefresh = () => {
      fetchRows();
    };
    window.addEventListener(RECEBIMENTO_REFRESH_EVENT, onRefresh);
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchRows();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(RECEBIMENTO_REFRESH_EVENT, onRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [canView, fetchRows]);

  const rowsApeados = useMemo(() => rows.filter((r) => r.categoria === 'apeados'), [rows]);
  const rowsOutros = useMemo(() => rows.filter((r) => r.categoria !== 'apeados'), [rows]);
  const prefillByItemPart = useMemo(() => {
    const map = new Map();
    for (const it of prefillItems) {
      const part = String(it?.particao || 'normal').toLowerCase() === 'apeado' ? 'apeado' : 'normal';
      const key = `${Number(it?.item_id || 0) || 0}::${String(it?.codigo || '').trim().toUpperCase()}::${part}`;
      if (!it?.codigo || Number(it?.quantidade || 0) <= 0) continue;
      map.set(key, it);
    }
    return map;
  }, [prefillItems]);

  const buildPrefillPayload = useCallback((targetParticao) => {
    const part = targetParticao === 'apeado' ? 'apeado' : 'normal';
    const prefillParticionados = prefillItems.filter((it) =>
      part === 'apeado' ? it.particao === 'apeado' : it.particao !== 'apeado'
    );
    const fallbackRows = part === 'apeado' ? rowsApeados : rowsOutros;
    const legacyItems = (prefillParticionados.length > 0 ? prefillParticionados : fallbackRows).map((it) => {
      const fromPrefill = prefillParticionados.length > 0;
      const codigo = String(it?.codigo || '').trim();
      const key = `${Number(it?.item_id || 0) || 0}::${codigo.toUpperCase()}::${part}`;
      const det = prefillByItemPart.get(key);
      const lotesRaw = fromPrefill
        ? (Array.isArray(it?.lotes) ? it.lotes : [])
        : (Array.isArray(det?.lotes) ? det.lotes : (Array.isArray(it?.lotes) ? it.lotes : []));
      const seriaisRaw = fromPrefill
        ? (Array.isArray(it?.seriais) ? it.seriais : [])
        : (Array.isArray(det?.seriais) ? det.seriais : (Array.isArray(it?.seriais) ? it.seriais : []));
      return {
        item_id: Number(it?.item_id || 0) || null,
        codigo,
        descricao: String(it?.descricao || det?.descricao || '').trim(),
        tipocontrolo: String(it?.tipocontrolo || det?.tipocontrolo || '').trim(),
        seriais: seriaisRaw.map((s) => String(s || '').trim()).filter(Boolean),
        lotes: lotesRaw.map((s) => String(s || '').trim()).filter(Boolean),
        quantidade: Number(it?.quantidade ?? it?.qtd ?? det?.quantidade ?? 0) || 0,
      };
    }).filter((it) => it.codigo && it.quantidade > 0);

    const itemsV2 = legacyItems.map((r) => {
      const key = `${Number(r?.item_id || 0) || 0}::${String(r?.codigo || '').trim().toUpperCase()}::${part}`;
      const det = prefillByItemPart.get(key);
      const quantidade = Number(det?.quantidade || r?.quantidade || 0) || 0;
      const seriais = Array.isArray(det?.seriais) && det.seriais.length ? det.seriais : r.seriais;
      const lotes = Array.isArray(det?.lotes) && det.lotes.length ? det.lotes : (Array.isArray(r?.lotes) ? r.lotes : []);
      return {
        item_id: r.item_id,
        codigo: r.codigo,
        descricao: r.descricao,
        tipocontrolo: r.tipocontrolo,
        quantidade_total: quantidade,
        lotes,
        seriais,
        allocations: [
          {
            id: `auto-${Date.now()}-${r.codigo || 'item'}`,
            particao: part,
            quantidade,
            destinoId: '',
            seriais,
            lotes,
          },
        ],
      };
    }).filter((x) => Number(x?.quantidade_total || 0) > 0 && x?.codigo);
    const origemLoc =
      part === 'apeado'
        ? firstNonEmpty(
            ...prefillParticionados.map((it) => it?.origem_localizacao),
            targetLocationApeados,
            targetLocation
          )
        : targetLocation;
    return {
      armazemId: targetArmazemId,
      origemLocalizacao: origemLoc,
      modo: part === 'apeado' ? 'apeado' : undefined,
      prefill_version: 2,
      autoSubmit: false,
      items: legacyItems,
      items_v2: itemsV2,
    };
  }, [prefillItems, rowsApeados, rowsOutros, prefillByItemPart, targetArmazemId, targetLocation, targetLocationApeados]);
  const totalApeados = Number(contagensPorCategoria?.apeados ?? totaisPorCategoria?.apeados ?? rowsApeados.length) || 0;
  const totalOutros = Number(
    (contagensPorCategoria?.devolucao || 0)
    + (contagensPorCategoria?.recebimento || 0)
    || rowsOutros.length
  ) || 0;

  if (!canView) return null;

  return (
    <aside className="static z-auto w-full max-w-none rounded-xl border border-gray-200 bg-white shadow-xl sm:fixed sm:bottom-4 sm:right-4 sm:z-[1000] sm:w-[360px] sm:max-w-[calc(100vw-1rem)]">
      <div className={`${collapsed ? '' : 'border-b border-gray-100'} px-4 py-3`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-800">Zona de receção ({totalArtigosRececao})</h3>
            {!collapsed && armazensDisponiveis.length > 1 ? (
              <div className="mt-1">
                <select
                  value={selectedArmazemId}
                  onChange={(e) => setSelectedArmazemId(e.target.value)}
                  className="w-full rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-800"
                  aria-label="Selecionar armazém da zona de receção"
                >
                  {armazensDisponiveis.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : targetArmazemLabel ? (
              <div className="mt-1">
                <span className="inline-block max-w-full truncate rounded bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 border border-indigo-100">
                  {targetArmazemLabel}
                </span>
              </div>
            ) : null}
            {!collapsed && <p className="mt-0.5 text-xs text-gray-500">Devoluções e entradas de mercadoria</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {showAtualizado && !loadingRows ? (
              <span className="text-[11px] font-medium text-emerald-700 px-1">Atualizado</span>
            ) : null}
            <button
              type="button"
              onClick={fetchRows}
              className="rounded border border-gray-300 p-1.5 text-gray-700 hover:bg-gray-50"
              title="Atualizar agora"
              aria-label="Atualizar agora"
            >
              <FiRefreshCw className={`text-xs ${loadingRows ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="rounded border border-gray-300 p-1.5 text-gray-700 hover:bg-gray-50"
              title={collapsed ? 'Expandir card' : 'Colapsar card'}
              aria-label={collapsed ? 'Expandir card' : 'Colapsar card'}
            >
              {collapsed ? <FaChevronUp className="text-xs" /> : <FaChevronDown className="text-xs" />}
            </button>
          </div>
        </div>
        {!collapsed && canArmazenar && targetArmazemId ? (
          <div className="mt-2 space-y-1.5">
            {isAdminUser && (
              <button
                type="button"
                className="w-full rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                disabled={clearingTest}
                onClick={async () => {
                  if (!window.confirm('Limpar artigos da Zona de receção para testes? O stock actual deixa de aparecer; só entradas novas serão mostradas.')) return;
                  const armazemIdLimpar =
                    Number(selectedArmazemId || targetArmazemId || 0) || null;
                  if (!armazemIdLimpar) {
                    setError('Armazém não identificado para limpar a zona de receção.');
                    return;
                  }
                  try {
                    setClearingTest(true);
                    const token = localStorage.getItem('token');
                    const response = await fetch(apiUrl('/api/requisicoes/transferencias/recebimento/monitor/limpar-teste'), {
                      method: 'POST',
                      headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({ armazem_id: armazemIdLimpar }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) {
                      throw new Error(
                        data?.error
                        || (data?.monitor_baseline === false
                          ? 'Limpeza parcial: execute a migração monitor-rececao-baseline na BD de produção.'
                          : 'Erro ao limpar zona de receção para teste.')
                      );
                    }
                    setRows([]);
                    setPrefillItems([]);
                    setTotalArtigosRececao(0);
                    setTotaisPorCategoria({});
                    setContagensPorCategoria({});
                    setError('');
                    await fetchRows();
                  } catch (e) {
                    setError(e?.message || 'Erro ao limpar zona de receção para teste.');
                  } finally {
                    setClearingTest(false);
                  }
                }}
              >
                {clearingTest ? 'A limpar zona (teste)…' : 'Limpar zona de receção (teste, admin)'}
              </button>
            )}
            {rowsOutros.length > 0 && canArmazenar && (
              <button
                type="button"
                className="w-full rounded-md border border-[#0915FF] bg-white px-2 py-1.5 text-xs font-semibold text-[#0915FF] hover:bg-[#0915FF]/5"
                onClick={() =>
                  navigate('/transferencias/localizacao', {
                    state: {
                      recebimentoPrefill: buildPrefillPayload('normal'),
                    },
                  })
                }
              >
                Armazenar recebimento/devolução
              </button>
            )}
            {rowsApeados.length > 0 && canArmazenar && (
              <button
                type="button"
                className="w-full rounded-md border border-purple-300 bg-purple-50 px-2 py-1.5 text-xs font-semibold text-purple-800 hover:bg-purple-100"
                onClick={() =>
                  navigate('/transferencias/localizacao', {
                    state: {
                      recebimentoPrefill: buildPrefillPayload('apeado'),
                    },
                  })
                }
              >
                Armazenar APEADOS
              </button>
            )}
          </div>
        ) : null}
      </div>

      {!collapsed && <div className="max-h-[340px] overflow-auto px-3 py-2">
        {loadingRows && rows.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-gray-500">A carregar movimentos...</div>
        )}

        {!loadingRows && !error && rows.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-gray-500">
            Sem artigos recentes nesta localização.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {!!rowsOutros.length && (
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
            Recebimento/Devolução ({totalOutros})
          </div>
        )}
        <div className="space-y-2">
          {rowsOutros.map((row, idx) => (
            <div key={`${row.codigo || 'mov'}-${idx}`} className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-gray-900">{String(row.codigo || '-')}</div>
                  <div className="line-clamp-2 text-[11px] text-gray-600">{String(row.descricao || '-')}</div>
                </div>
                <span className="shrink-0 rounded bg-white px-2 py-0.5 text-xs font-semibold text-gray-800">
                  {formatQtyForMonitorRow(row)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-gray-500">
                <span className="truncate">{String(row.tra || '-')}</span>
                <span className="shrink-0">{formatDate(row.data)}</span>
              </div>
            </div>
          ))}
        </div>
        {!!rowsApeados.length && (
          <div className="mt-3 mb-2 text-[11px] font-semibold uppercase tracking-wide text-purple-700">
            APEADOS ({totalApeados})
          </div>
        )}
        <div className="space-y-2">
          {rowsApeados.map((row, idx) => (
            <div key={`ape-${row.codigo || 'mov'}-${idx}`} className="rounded-lg border border-purple-200 bg-purple-50 px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-gray-900">{String(row.codigo || '-')}</div>
                  <div className="line-clamp-2 text-[11px] text-gray-600">{String(row.descricao || '-')}</div>
                </div>
                <span className="shrink-0 rounded bg-white px-2 py-0.5 text-xs font-semibold text-gray-800">
                  {formatQtyForMonitorRow(row)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-gray-500">
                <span className="truncate">{String(row.tra || '-')}</span>
                <span className="shrink-0">{formatDate(row.data)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>}
    </aside>
  );
}

export default ReceptionMonitorCard;
