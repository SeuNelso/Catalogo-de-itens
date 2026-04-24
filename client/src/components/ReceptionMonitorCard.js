import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaChevronDown, FaChevronUp } from 'react-icons/fa';
import { FiRefreshCw } from 'react-icons/fi';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../utils/apiUrl';
import { podeUsarConsultaMovimentos } from '../utils/controloStock';

const FALLBACK_LOCATION = 'RECEBIMENTO.E';
const PAGE_SIZE = 40;
const REFRESH_MS = 180000;
const MAX_ITEMS = 8;
const RECEBIMENTO_REFRESH_EVENT = 'recebimento-card-refresh';
const RECEBIMENTO_TRANSFERENCIA_MARKER = 'RECEBIMENTO_TRANSFERENCIA_V1';

const normalizeText = (value) => String(value || '').trim().toUpperCase();

const formatDate = (value) => {
  const s = String(value || '').trim();
  if (!s) return '-';
  return s;
};

const isRecebimentoTraOuDevRow = (row, normalizedTarget) => {
  const destination = normalizeText(row?.['New Localização'] || row?.Loc_Inicial);
  if (!destination || destination !== normalizedTarget) return false;
  const doc = String(row?.['TRA / DEV'] || '').trim();
  if (!doc) return false;
  const docNorm = normalizeText(doc);
  return docNorm.startsWith('TRA') || docNorm.startsWith('DEV');
};

const formatQtyDecimal = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('pt-PT', { maximumFractionDigits: 4 });
};

const markerFlagAtivo = (obsRaw, markerKey) =>
  new RegExp(`${markerKey}:\\s*1`, 'i').test(String(obsRaw || ''));

const firstNonEmpty = (...values) => {
  for (const v of values) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
};

const resolveArmazemLabelFromReq = (reqRow) =>
  firstNonEmpty(
    reqRow?.armazem_destino_codigo,
    reqRow?.armazem_origem_codigo,
    reqRow?.armazem_codigo,
    reqRow?.armazem_destino_descricao,
    reqRow?.armazem_origem_descricao,
    reqRow?.armazem_descricao
  );

const isDevolucaoDevConfirmadaNoArmazem = (reqRow, armazemId) => {
  if (!Number(armazemId)) return false;
  if (!reqRow?.devolucao_tra_gerada_em) return false;
  const candidates = [reqRow?.armazem_id, reqRow?.armazem_destino_id, reqRow?.armazem_origem_id]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  return candidates.includes(Number(armazemId));
};

const getQtdPendenteRececaoDevolucao = (reqRow, itemRow) => {
  const base = Number(itemRow?.quantidade ?? itemRow?.quantidade_confirmada ?? 0) || 0;
  if (base <= 0) return 0;
  // Após gerar TRA APEADOS, apenas o remanescente deve continuar na zona de receção.
  if (reqRow?.devolucao_tra_apeados_gerada_em) {
    const qApeados = Math.max(0, Number(itemRow?.quantidade_apeados ?? 0) || 0);
    return Math.max(0, base - qApeados);
  }
  return base;
};

function ReceptionMonitorCard() {
  const navigate = useNavigate();
  const { isAuthenticated, loading, user } = useAuth();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [loadingRows, setLoadingRows] = useState(false);
  const [targetLocation, setTargetLocation] = useState(FALLBACK_LOCATION);
  const [targetArmazemId, setTargetArmazemId] = useState(null);
  const [targetArmazemLabel, setTargetArmazemLabel] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [totalArtigosRececao, setTotalArtigosRececao] = useState(0);
  const [showAtualizado, setShowAtualizado] = useState(false);
  const hideAtualizadoTimerRef = useRef(null);

  const canView = useMemo(
    () => isAuthenticated && !loading && podeUsarConsultaMovimentos(user),
    [isAuthenticated, loading, user]
  );
  const canArmazenar = ['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador'].includes(
    String(user?.role || '').trim().toLowerCase()
  );

  const resolveTargetLocation = useCallback(async (token) => {
    try {
      const response = await fetch(apiUrl('/api/requisicoes/stock/meus-armazens'), {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!response.ok) return FALLBACK_LOCATION;
      const data = await response.json().catch(() => ({}));
      const first = Array.isArray(data?.rows) ? data.rows[0] : null;
      const loc = String(first?.localizacao_recebimento || '').trim();
      const armazemId = Number(first?.id || 0);
      const armazemLabel = firstNonEmpty(
        first?.codigo && first?.descricao ? `${String(first.codigo).trim()} - ${String(first.descricao).trim()}` : '',
        first?.codigo,
        first?.descricao
      );
      return {
        location: loc || FALLBACK_LOCATION,
        armazemId: Number.isFinite(armazemId) && armazemId > 0 ? armazemId : null,
        armazemLabel,
      };
    } catch (_) {
      return { location: FALLBACK_LOCATION, armazemId: null, armazemLabel: '' };
    }
  }, []);

  const fetchRows = useCallback(async () => {
    if (!canView) return;
    setLoadingRows(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setRows([]);
        return;
      }
      const resolved = await resolveTargetLocation(token);
      const resolvedLocation = String(resolved?.location || FALLBACK_LOCATION).trim() || FALLBACK_LOCATION;
      setTargetLocation(resolvedLocation);
      setTargetArmazemId(Number(resolved?.armazemId || 0) || null);
      setTargetArmazemLabel(String(resolved?.armazemLabel || '').trim());
      const params = new URLSearchParams();
      params.set('localizacao', resolvedLocation);
      params.set('page_size', String(PAGE_SIZE));
      params.set('offset', '0');

      const response = await fetch(apiUrl(`/api/requisicoes/movimentos-clog/consulta?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });

      if (response.status === 403) {
        setRows([]);
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao carregar monitor de recebimento.');
      }

      const data = await response.json().catch(() => ({}));
      const apiRows = Array.isArray(data?.rows) ? data.rows : [];
      const normalizedTarget = normalizeText(resolvedLocation);
      const entradas = apiRows
        .filter((row) => isRecebimentoTraOuDevRow(row, normalizedTarget))
        .map((row) => ({
          codigo: String(row['REF.'] || '').trim(),
          descricao: String(row.DESCRIPTION || '').trim(),
          qtd: Math.abs(Number(row.QTY || 0)) || 0,
          armazem: firstNonEmpty(row['Novo Armazém'], row['New Armazém'], row['Armazém'], row['Armazem']),
          tra: String(row['TRA / DEV'] || '').trim(),
          data: String(row['Dt_Recepção'] || '').trim(),
        }))
        .filter((x) => x.codigo && x.qtd > 0);

      const deltaTicketsPorCodigo = new Map();
      if (resolved?.armazemId) {
        try {
          const tkRes = await fetch(
            apiUrl(`/api/armazens/${resolved.armazemId}/movimentacoes-internas?limit=500`),
            {
              headers: { Authorization: `Bearer ${token}` },
              cache: 'no-store',
            }
          );
          if (tkRes.ok) {
            const tkRows = await tkRes.json().catch(() => []);
            const tickets = Array.isArray(tkRows) ? tkRows : [];
            tickets.forEach((t) => {
                const cod = String(t?.item_codigo || '').trim();
                const qtd = Number(t?.quantidade || 0) || 0;
                if (!cod || qtd <= 0) return;
                const origemNorm = normalizeText(t?.origem_localizacao_label);
                const destinoNorm = normalizeText(t?.destino_localizacao_label);
                let delta = 0;
                if (origemNorm === normalizedTarget) delta -= qtd;
                if (destinoNorm === normalizedTarget) delta += qtd;
                if (delta === 0) return;
                deltaTicketsPorCodigo.set(cod, Number(deltaTicketsPorCodigo.get(cod) || 0) + delta);
              });
          }
        } catch (_) {
          // Se não conseguir carregar tickets, mantém apenas entradas.
        }
      }

      const pendenteByCodigo = new Map();
      entradas.forEach((row) => {
        const prev = pendenteByCodigo.get(row.codigo) || {
          codigo: row.codigo,
          descricao: row.descricao,
          qtd: 0,
          armazem: row.armazem,
          tra: row.tra,
          data: row.data,
        };
        prev.qtd += row.qtd;
        if (!prev.descricao && row.descricao) prev.descricao = row.descricao;
        if (!prev.armazem && row.armazem) prev.armazem = row.armazem;
        if (!prev.tra && row.tra) prev.tra = row.tra;
        if (!prev.data && row.data) prev.data = row.data;
        pendenteByCodigo.set(row.codigo, prev);
      });

      if (resolved?.armazemId) {
        try {
          const [reqRes, reqDevRes] = await Promise.all([
            fetch(apiUrl('/api/requisicoes'), {
              headers: { Authorization: `Bearer ${token}` },
              cache: 'no-store',
            }),
            fetch(apiUrl('/api/requisicoes?devolucoes=1'), {
              headers: { Authorization: `Bearer ${token}` },
              cache: 'no-store',
            }),
          ]);
          if (reqRes.ok || reqDevRes.ok) {
            const reqRows = reqRes.ok ? await reqRes.json().catch(() => []) : [];
            const reqDevRows = reqDevRes.ok ? await reqDevRes.json().catch(() => []) : [];
            const reqMapById = new Map();
            [...(Array.isArray(reqRows) ? reqRows : []), ...(Array.isArray(reqDevRows) ? reqDevRows : [])].forEach(
              (r) => {
                const id = Number(r?.id);
                if (Number.isFinite(id) && id > 0) reqMapById.set(id, r);
              }
            );
            const reqs = [...reqMapById.values()];
            reqs
              .filter((r) => {
                const obs = String(r?.observacoes || '');
                if (!obs.toUpperCase().startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER)) return false;
                if (!markerFlagAtivo(obs, 'TRA_CONFIRMED')) return false;
                return Number(r?.armazem_origem_id) === Number(resolved.armazemId);
              })
              .forEach((r) => {
                const itens = Array.isArray(r?.itens) ? r.itens : [];
                itens.forEach((it) => {
                  const codigo = String(it?.item_codigo || '').trim();
                  if (!codigo) return;
                  const qtd = Number(it?.quantidade ?? it?.quantidade_confirmada ?? 0) || 0;
                  if (qtd <= 0) return;
                  const prev = pendenteByCodigo.get(codigo) || {
                    codigo,
                    descricao: String(it?.item_descricao || '').trim(),
                    qtd: 0,
                    armazem: resolveArmazemLabelFromReq(r),
                    tra: String(r?.tra_numero || 'TRA confirmado').trim(),
                    data: String(r?.created_at || '').trim(),
                  };
                  prev.qtd += qtd;
                  if (!prev.descricao && it?.item_descricao) prev.descricao = String(it.item_descricao).trim();
                  if (!prev.armazem) prev.armazem = resolveArmazemLabelFromReq(r);
                  pendenteByCodigo.set(codigo, prev);
                });
              });

            reqs
              .filter((r) => isDevolucaoDevConfirmadaNoArmazem(r, resolved.armazemId))
              .forEach((r) => {
                const itens = Array.isArray(r?.itens) ? r.itens : [];
                itens.forEach((it) => {
                  const codigo = String(it?.item_codigo || '').trim();
                  if (!codigo) return;
                  const qtd = getQtdPendenteRececaoDevolucao(r, it);
                  if (qtd <= 0) return;
                  const prev = pendenteByCodigo.get(codigo) || {
                    codigo,
                    descricao: String(it?.item_descricao || '').trim(),
                    qtd: 0,
                    armazem: resolveArmazemLabelFromReq(r),
                    tra: String(r?.tra_numero || 'DEV devolução').trim(),
                    data: String(r?.devolucao_tra_gerada_em || r?.created_at || '').trim(),
                  };
                  prev.qtd += qtd;
                  if (!prev.descricao && it?.item_descricao) prev.descricao = String(it.item_descricao).trim();
                  if (!prev.armazem) prev.armazem = resolveArmazemLabelFromReq(r);
                  if (!prev.tra) prev.tra = 'DEV devolução';
                  pendenteByCodigo.set(codigo, prev);
                });
              });
          }
        } catch (_) {
          // Se não conseguir carregar requisições, mantém apenas movimentos/tickets.
        }
      }

      const merged = [...pendenteByCodigo.values()]
        .map((row) => {
          const deltaTicket = Number(deltaTicketsPorCodigo.get(row.codigo) || 0);
          return { ...row, qtd: Number(row.qtd || 0) + deltaTicket };
        })
        .filter((row) => row.qtd > 0);

      setTotalArtigosRececao(merged.length);

      const topRows = merged
        .sort((a, b) => Number(b.qtd || 0) - Number(a.qtd || 0))
        .slice(0, MAX_ITEMS);

      setRows(topRows);
      setError('');
      setShowAtualizado(true);
      if (hideAtualizadoTimerRef.current) window.clearTimeout(hideAtualizadoTimerRef.current);
      hideAtualizadoTimerRef.current = window.setTimeout(() => setShowAtualizado(false), 1800);
    } catch (e) {
      setError(e.message || 'Erro ao carregar monitor de recebimento.');
      setShowAtualizado(false);
    } finally {
      setLoadingRows(false);
    }
  }, [canView, resolveTargetLocation]);

  useEffect(() => () => {
    if (hideAtualizadoTimerRef.current) window.clearTimeout(hideAtualizadoTimerRef.current);
  }, []);

  useEffect(() => {
    if (!canView) return undefined;
    fetchRows();
    const timer = window.setInterval(fetchRows, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [canView, fetchRows]);

  useEffect(() => {
    if (!canView) return undefined;
    const onRefresh = () => {
      fetchRows();
    };
    window.addEventListener(RECEBIMENTO_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(RECEBIMENTO_REFRESH_EVENT, onRefresh);
  }, [canView, fetchRows]);

  if (!canView) return null;

  return (
    <aside className="static z-auto w-full max-w-none rounded-xl border border-gray-200 bg-white shadow-xl sm:fixed sm:bottom-4 sm:right-4 sm:z-[1000] sm:w-[360px] sm:max-w-[calc(100vw-1rem)]">
      <div className={`${collapsed ? '' : 'border-b border-gray-100'} px-4 py-3`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-800">Zona de receção ({totalArtigosRececao})</h3>
            {targetArmazemLabel ? (
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
        {!collapsed && canArmazenar && rows.length > 0 && targetArmazemId ? (
          <button
            type="button"
            className="mt-2 w-full rounded-md border border-[#0915FF] bg-white px-2 py-1.5 text-xs font-semibold text-[#0915FF] hover:bg-[#0915FF]/5"
            onClick={() =>
              navigate('/transferencias/localizacao', {
                state: {
                  recebimentoPrefill: {
                    armazemId: targetArmazemId,
                    origemLocalizacao: targetLocation,
                    items: rows.map((r) => ({
                      codigo: String(r?.codigo || '').trim(),
                      descricao: String(r?.descricao || '').trim(),
                      quantidade: Number(r?.qtd || 0) || 0,
                    })),
                  },
                },
              })
            }
          >
            Armazenar
          </button>
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

        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div key={`${row.codigo || 'mov'}-${idx}`} className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-gray-900">{String(row.codigo || '-')}</div>
                  <div className="line-clamp-2 text-[11px] text-gray-600">{String(row.descricao || '-')}</div>
                </div>
                <span className="shrink-0 rounded bg-white px-2 py-0.5 text-xs font-semibold text-gray-800">
                  {formatQtyDecimal(row.qtd)}
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
