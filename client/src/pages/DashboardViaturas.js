import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Toast from '../components/Toast';

const PAGE_SIZE = 40;
const MAX_PAGES = 80;
const VIATURAS_PAGE_SIZE = 10;
const STATUS_PENDENTES = new Set(['pendente', 'em separacao', 'separado', 'em expedicao', 'apeados']);

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

function statusRequisicaoPendente(rawStatus) {
  const s = String(rawStatus || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return STATUS_PENDENTES.has(s);
}

function formatDateTime(value) {
  if (!value) return '—';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '—';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function extrairSeriaisDoItem(item) {
  const out = [];
  const addStr = (v) => {
    for (const s of parseSeriais(v)) out.push(s);
  };
  const addArr = (arr) => {
    for (const v of arr || []) addStr(v);
  };

  if (Array.isArray(item?.seriais)) addArr(item.seriais);
  if (Array.isArray(item?.serials)) addArr(item.serials);
  if (Array.isArray(item?.serial_numbers)) addArr(item.serial_numbers);
  addStr(item?.seriais_texto);
  addStr(item?.serialnumber);
  addStr(item?.serialnumbers);
  addStr(item?.serial);
  addStr(item?.sn);

  return Array.from(new Set(out.filter(Boolean)));
}

const DashboardViaturas = () => {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [armazens, setArmazens] = useState([]);
  const [rows, setRows] = useState([]);
  const [requisicoesPendentesEntrega, setRequisicoesPendentesEntrega] = useState([]);
  const [requisicoesPendentesDevolucao, setRequisicoesPendentesDevolucao] = useState([]);
  const [selectedViaturaId, setSelectedViaturaId] = useState('');
  const [filtroViaturaBusca, setFiltroViaturaBusca] = useState('');
  const [filtroViaturaOpen, setFiltroViaturaOpen] = useState(false);
  const [viaturasPage, setViaturasPage] = useState(1);
  const [cardFiltroAtivo, setCardFiltroAtivo] = useState('viaturas');
  const [selectedReqDetail, setSelectedReqDetail] = useState(null);
  const [selectedReqSeriais, setSelectedReqSeriais] = useState(null);
  const [reporteReqRows, setReporteReqRows] = useState([]);
  const [reporteReqLoading, setReporteReqLoading] = useState(false);
  const [expandReqPend, setExpandReqPend] = useState(false);
  const [expandReqConc, setExpandReqConc] = useState(false);
  const [expandDevPend, setExpandDevPend] = useState(false);
  const [expandDevConc, setExpandDevConc] = useState(false);
  const [filtroReqPend, setFiltroReqPend] = useState('');
  const [filtroReqConc, setFiltroReqConc] = useState('');
  const [filtroDevPend, setFiltroDevPend] = useState('');
  const [filtroDevConc, setFiltroDevConc] = useState('');
  const [filtros, setFiltros] = useState({
    data_inicio: '',
    data_fim: '',
    armazem_id: '',
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
      const rowsAll = Array.isArray(dataAll)
        ? dataAll
        : (Array.isArray(dataAll?.armazens)
            ? dataAll.armazens
            : (Array.isArray(dataAll?.rows) ? dataAll.rows : []));
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

  const fetchRequisicoesPendentes = useCallback(async () => {
    const token = localStorage.getItem('token');
    const [resEntrega, resDevolucao] = await Promise.all([
      fetch('/api/requisicoes', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
      fetch('/api/requisicoes?devolucoes=1', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
    ]);
    if (!resEntrega.ok || !resDevolucao.ok) {
      const dataEntrega = await resEntrega.json().catch(() => ({}));
      const dataDevolucao = await resDevolucao.json().catch(() => ({}));
      throw new Error(
        dataEntrega?.error ||
          dataDevolucao?.error ||
          'Erro ao carregar pendentes de entrega/devolução'
      );
    }
    const dataEntrega = await resEntrega.json().catch(() => ([]));
    const dataDevolucao = await resDevolucao.json().catch(() => ([]));
    return {
      entrega: Array.isArray(dataEntrega) ? dataEntrega : [],
      devolucao: Array.isArray(dataDevolucao) ? dataDevolucao : [],
    };
  }, []);

  const carregarDashboard = useCallback(async () => {
    try {
      setLoading(true);
      setToast(null);
      const [{ entrega, devolucao }, allRows] = await Promise.all([
        fetchRequisicoesPendentes(),
        fetchAllRows(filtros),
      ]);
      setRequisicoesPendentesEntrega(entrega);
      setRequisicoesPendentesDevolucao(devolucao);
      setRows(allRows);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'Erro ao carregar dashboard' });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [fetchAllRows, fetchRequisicoesPendentes, filtros]);

  const abrirDetalheRequisicao = useCallback(async (reqRow) => {
    const reqId = Number(reqRow?.id || 0);
    if (!reqId) return;
    try {
      setReporteReqLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/reporte-dados`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setReporteReqRows(Array.isArray(data?.rows) ? data.rows : []);
      } else {
        setReporteReqRows([]);
      }
      setSelectedReqDetail(reqRow);
    } catch (_) {
      setReporteReqRows([]);
      setSelectedReqDetail(reqRow);
    } finally {
      setReporteReqLoading(false);
    }
  }, []);

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
    let totalPendentesEntrega = 0;
    let totalDevolucoesPendentes = 0;

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
        abastecido_qtd: 0,
        devolvido: 0,
        devolvido_qtd: 0,
        requisicoes_atendidas_set: new Set(),
        devolucoes_set: new Set(),
        pendentes_entrega: 0,
        devolucoes_pendentes: 0,
        movimentos: 0,
        ultimo_ts: 0,
        ultimo_texto: '',
      };

      if (v.sentido === 'entrada') {
        current.abastecido_qtd += qtdAbs;
        const reqId = Number(row?.requisicao_id || 0);
        if (reqId > 0) current.requisicoes_atendidas_set.add(reqId);
      } else {
        current.devolvido_qtd += qtdAbs;
        const reqId = Number(row?.requisicao_id || 0);
        if (reqId > 0) current.devolucoes_set.add(reqId);
      }
      current.movimentos += 1;
      const ts = parseDateBR(row?.['Dt_Recepção']);
      if (ts >= current.ultimo_ts) {
        current.ultimo_ts = ts;
        current.ultimo_texto = String(row?.['Dt_Recepção'] || '').trim();
      }
      byViatura.set(key, current);
    }

    const pendentesEntregaPorViatura = new Map();
    for (const req of requisicoesPendentesEntrega || []) {
      if (!statusRequisicaoPendente(req?.status)) continue;
      const viaturaId = Number(req?.armazem_id || 0);
      if (!viaturaId || !viaturaIdsFallback.has(viaturaId)) continue;
      const set = pendentesEntregaPorViatura.get(viaturaId) || new Set();
      set.add(Number(req?.id || 0));
      pendentesEntregaPorViatura.set(viaturaId, set);
    }

    const devolucoesPendentesPorViatura = new Map();
    for (const req of requisicoesPendentesDevolucao || []) {
      if (!statusRequisicaoPendente(req?.status)) continue;
      const viaturaId = Number(req?.armazem_origem_id || 0);
      if (!viaturaId || !viaturaIdsFallback.has(viaturaId)) continue;
      const set = devolucoesPendentesPorViatura.get(viaturaId) || new Set();
      set.add(Number(req?.id || 0));
      devolucoesPendentesPorViatura.set(viaturaId, set);
    }

    const lista = Array.from(byViatura.values())
      .map((x) => {
        const requisicoesAtendidas = x.requisicoes_atendidas_set.size;
        const devolucoes = x.devolucoes_set.size;
        const pendentesEntrega = (pendentesEntregaPorViatura.get(Number(x.viatura_id || 0)) || new Set()).size;
        const devolucoesPendentes = (devolucoesPendentesPorViatura.get(Number(x.viatura_id || 0)) || new Set()).size;
        totalAbastecido += requisicoesAtendidas;
        totalDevolvido += devolucoes;
        totalPendentesEntrega += pendentesEntrega;
        totalDevolucoesPendentes += devolucoesPendentes;
        return {
          ...x,
          abastecido: requisicoesAtendidas,
          devolvido: devolucoes,
          pendentes_entrega: pendentesEntrega,
          devolucoes_pendentes: devolucoesPendentes,
        };
      })
      .sort((a, b) => b.abastecido - a.abastecido || b.movimentos - a.movimentos);

    return {
      lista,
      totalAbastecido,
      totalDevolvido,
      totalPendentesEntrega,
      totalDevolucoesPendentes,
      totalViaturas: lista.length,
    };
  }, [rows, viaturaIdsFallback, requisicoesPendentesEntrega, requisicoesPendentesDevolucao]);

  const detalhesViatura = useMemo(() => {
    const selected = Number(selectedViaturaId || 0);
    if (!selected) {
      return {
        requisicoesPendentes: [],
        requisicoesConcluidas: [],
        devolucoesPendentes: [],
        devolucoesConcluidas: [],
      };
    }
    const normalizeReq = (req) => ({
      id: Number(req?.id || 0),
      status: String(req?.status || '').trim() || '—',
      data: formatDateTime(req?.created_at),
      tra_dev: String(req?.tra_numero || req?.devolucao_tra_apeados_numero || '').trim() || '—',
      descricao: String(req?.descricao || req?.armazem_descricao || '').trim() || '—',
      itens: Array.isArray(req?.itens) ? req.itens : [],
      raw: req,
    });

    const reqBase = (requisicoesPendentesEntrega || [])
      .filter((req) => Number(req?.armazem_id || 0) === selected)
      .map(normalizeReq)
      .sort((a, b) => b.id - a.id);
    const devBase = (requisicoesPendentesDevolucao || [])
      .filter((req) => Number(req?.armazem_origem_id || 0) === selected)
      .map(normalizeReq)
      .sort((a, b) => b.id - a.id);

    return {
      requisicoesPendentes: reqBase.filter((x) => statusRequisicaoPendente(x.status)),
      requisicoesConcluidas: reqBase.filter((x) => !statusRequisicaoPendente(x.status)),
      devolucoesPendentes: devBase.filter((x) => statusRequisicaoPendente(x.status)),
      devolucoesConcluidas: devBase.filter((x) => !statusRequisicaoPendente(x.status)),
    };
  }, [selectedViaturaId, requisicoesPendentesEntrega, requisicoesPendentesDevolucao]);

  const filtrarListaReq = useCallback((lista, filtro) => {
    const q = String(filtro || '').trim().toLowerCase();
    if (!q) return Array.isArray(lista) ? lista : [];
    const match = (r) => {
      const idTxt = String(r?.id || '').toLowerCase();
      const dataTxt = String(r?.data || '').toLowerCase();
      const traTxt = String(r?.tra_dev || '').toLowerCase();
      return idTxt.includes(q) || dataTxt.includes(q) || traTxt.includes(q);
    };
    return (lista || []).filter(match);
  }, []);

  const reqPendLista = useMemo(
    () => filtrarListaReq(detalhesViatura.requisicoesPendentes, filtroReqPend),
    [detalhesViatura.requisicoesPendentes, filtroReqPend, filtrarListaReq]
  );
  const reqConcLista = useMemo(
    () => filtrarListaReq(detalhesViatura.requisicoesConcluidas, filtroReqConc),
    [detalhesViatura.requisicoesConcluidas, filtroReqConc, filtrarListaReq]
  );
  const devPendLista = useMemo(
    () => filtrarListaReq(detalhesViatura.devolucoesPendentes, filtroDevPend),
    [detalhesViatura.devolucoesPendentes, filtroDevPend, filtrarListaReq]
  );
  const devConcLista = useMemo(
    () => filtrarListaReq(detalhesViatura.devolucoesConcluidas, filtroDevConc),
    [detalhesViatura.devolucoesConcluidas, filtroDevConc, filtrarListaReq]
  );

  const itensRequisicaoSelecionada = useMemo(() => {
    const itensReq = Array.isArray(selectedReqDetail?.itens) ? selectedReqDetail.itens : [];
    const descricaoByRef = new Map();
    for (const it of itensReq) {
      const ref = String(it?.item_codigo || it?.codigo || '').trim();
      const desc = String(it?.item_descricao || it?.descricao || '').trim();
      if (ref && desc && !descricaoByRef.has(ref)) descricaoByRef.set(ref, desc);
    }

    if (Array.isArray(reporteReqRows) && reporteReqRows.length > 0) {
      return reporteReqRows.map((row, idx) => {
        const ref = String(row?.Artigo || row?.Article || row?.['REF.'] || row?.REF || '').trim() || '—';
        const descricao =
          descricaoByRef.get(ref) ||
          String(row?.['Descrição'] || row?.Description || row?.DESCRIPTION || '').trim() ||
          '—';
        const qtd = Number(row?.Quantidade ?? row?.Quatity ?? row?.QTY ?? 0);
        const serialsRaw = [row?.['S/N'], row?.SerialNumber1, row?.SerialNumber2].filter(Boolean).join('\n');
        const seriais = parseSeriais(serialsRaw);
        return {
          key: `${selectedReqDetail?.id || 'req'}-rep-${idx}`,
          ref,
          descricao,
          qtd: Number.isFinite(qtd) ? qtd : 0,
          lote: String(row?.LOTE || row?.Batch || '').trim() || '—',
          seriais,
        };
      });
    }

    return itensReq.map((it, idx) => {
      const seriais = extrairSeriaisDoItem(it);
      const ref = String(it?.item_codigo || it?.codigo || '').trim() || '—';
      return {
        key: `${selectedReqDetail?.id || 'req'}-${Number(it?.id || 0) || idx}`,
        ref,
        descricao: String(it?.item_descricao || it?.descricao || '').trim() || '—',
        qtd: Number(it?.quantidade_preparada ?? it?.quantidade ?? 0) || 0,
        lote: String(it?.lote || it?.batch || '').trim() || '—',
        seriais,
      };
    });
  }, [selectedReqDetail, reporteReqRows]);

  const viaturasSelectOptions = useMemo(() => {
    const byId = new Map();
    for (const v of armazensViatura) {
      const id = Number(v?.id || 0);
      if (!id) continue;
      byId.set(id, String(v?.descricao || v?.codigo || `Viatura ${id}`).trim());
    }
    return Array.from(byId.entries())
      .map(([id, nome]) => ({ id, nome: nome || `Viatura ${id}` }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }, [armazensViatura]);

  const viaturasSelectFiltradas = useMemo(() => {
    const q = String(filtroViaturaBusca || '').trim().toLowerCase();
    const base = Array.isArray(viaturasSelectOptions) ? viaturasSelectOptions : [];
    if (!q) return base.slice(0, 60);
    return base
      .filter((v) => String(v?.nome || '').toLowerCase().includes(q) || String(v?.id || '').includes(q))
      .slice(0, 60);
  }, [viaturasSelectOptions, filtroViaturaBusca]);

  useEffect(() => {
    const id = Number(filtros.armazem_id || 0);
    if (!id) {
      setFiltroViaturaBusca('');
      return;
    }
    const selected = (viaturasSelectOptions || []).find((v) => Number(v?.id || 0) === id);
    if (selected) setFiltroViaturaBusca(String(selected.nome || ''));
  }, [filtros.armazem_id, viaturasSelectOptions]);

  const viaturasFiltradasPorCard = useMemo(() => {
    const base = Array.isArray(agregados.lista) ? agregados.lista : [];
    if (cardFiltroAtivo === 'abastecido') return base.filter((x) => Number(x?.abastecido || 0) > 0);
    if (cardFiltroAtivo === 'devolvido') return base.filter((x) => Number(x?.devolvido || 0) > 0);
    if (cardFiltroAtivo === 'pendentes_entrega') return base.filter((x) => Number(x?.pendentes_entrega || 0) > 0);
    if (cardFiltroAtivo === 'devolucoes_pendentes') return base.filter((x) => Number(x?.devolucoes_pendentes || 0) > 0);
    return base;
  }, [agregados.lista, cardFiltroAtivo]);

  const totalPaginasViaturas = useMemo(
    () => Math.max(1, Math.ceil((viaturasFiltradasPorCard || []).length / VIATURAS_PAGE_SIZE)),
    [viaturasFiltradasPorCard]
  );

  const viaturasPaginaAtual = useMemo(
    () => Math.min(Math.max(1, Number(viaturasPage) || 1), totalPaginasViaturas),
    [viaturasPage, totalPaginasViaturas]
  );

  const viaturasPaginadas = useMemo(() => {
    const start = (viaturasPaginaAtual - 1) * VIATURAS_PAGE_SIZE;
    return (viaturasFiltradasPorCard || []).slice(start, start + VIATURAS_PAGE_SIZE);
  }, [viaturasFiltradasPorCard, viaturasPaginaAtual]);

  useEffect(() => {
    setViaturasPage(1);
  }, [filtros.data_inicio, filtros.data_fim, filtros.armazem_id, cardFiltroAtivo]);

  useEffect(() => {
    if (viaturasPage > totalPaginasViaturas) setViaturasPage(totalPaginasViaturas);
  }, [viaturasPage, totalPaginasViaturas]);

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
              <div className="relative min-w-[220px]">
                <input
                  value={filtroViaturaBusca}
                  onFocus={() => setFiltroViaturaOpen(true)}
                  onBlur={() => {
                    setTimeout(() => setFiltroViaturaOpen(false), 120);
                  }}
                  onChange={(e) => {
                    const txt = e.target.value;
                    setFiltroViaturaBusca(txt);
                    setFiltros((prev) => ({ ...prev, armazem_id: '' }));
                    setSelectedViaturaId('');
                    setFiltroViaturaOpen(true);
                  }}
                  placeholder="Pesquisar viatura"
                  className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
                />
                {filtroViaturaOpen && (
                  <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setFiltros((prev) => ({ ...prev, armazem_id: '' }));
                        setSelectedViaturaId('');
                        setFiltroViaturaBusca('');
                        setFiltroViaturaOpen(false);
                      }}
                      className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm hover:bg-indigo-50"
                    >
                      Todas
                    </button>
                    {viaturasSelectFiltradas.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          const viaturaId = String(v.id || '');
                          setFiltros((prev) => ({ ...prev, armazem_id: viaturaId }));
                          setSelectedViaturaId(viaturaId);
                          setFiltroViaturaBusca(String(v.nome || ''));
                          setFiltroViaturaOpen(false);
                        }}
                        className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm hover:bg-indigo-50"
                      >
                        {v.nome}
                      </button>
                    ))}
                    {!viaturasSelectFiltradas.length && (
                      <div className="px-3 py-2 text-sm text-gray-500">Sem resultados</div>
                    )}
                  </div>
                )}
              </div>
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

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <button
            type="button"
            onClick={() => setCardFiltroAtivo('viaturas')}
            className={`text-left rounded-xl p-4 border ${
              cardFiltroAtivo === 'viaturas'
                ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-200'
                : 'bg-white border-blue-100'
            }`}
          >
            <div className="text-xs text-gray-500">Viaturas com movimentos</div>
            <div className="text-2xl font-bold text-gray-900">{agregados.totalViaturas}</div>
          </button>
          <button
            type="button"
            onClick={() => setCardFiltroAtivo((v) => (v === 'abastecido' ? 'viaturas' : 'abastecido'))}
            className={`text-left rounded-xl p-4 border ${
              cardFiltroAtivo === 'abastecido'
                ? 'bg-emerald-50 border-emerald-300 ring-1 ring-emerald-200'
                : 'bg-white border-emerald-100'
            }`}
          >
            <div className="text-xs text-gray-500">Req. atendidas</div>
            <div className="text-2xl font-bold text-emerald-700">{agregados.totalAbastecido}</div>
          </button>
          <button
            type="button"
            onClick={() => setCardFiltroAtivo((v) => (v === 'devolvido' ? 'viaturas' : 'devolvido'))}
            className={`text-left rounded-xl p-4 border ${
              cardFiltroAtivo === 'devolvido'
                ? 'bg-amber-50 border-amber-300 ring-1 ring-amber-200'
                : 'bg-white border-amber-100'
            }`}
          >
            <div className="text-xs text-gray-500">Devoluções</div>
            <div className="text-2xl font-bold text-amber-700">{agregados.totalDevolvido}</div>
          </button>
          <button
            type="button"
            onClick={() => setCardFiltroAtivo((v) => (v === 'pendentes_entrega' ? 'viaturas' : 'pendentes_entrega'))}
            className={`text-left rounded-xl p-4 border ${
              cardFiltroAtivo === 'pendentes_entrega'
                ? 'bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200'
                : 'bg-white border-indigo-100'
            }`}
          >
            <div className="text-xs text-gray-500">Requisições pendentes</div>
            <div className="text-2xl font-bold text-indigo-700">{agregados.totalPendentesEntrega}</div>
          </button>
          <button
            type="button"
            onClick={() =>
              setCardFiltroAtivo((v) => (v === 'devolucoes_pendentes' ? 'viaturas' : 'devolucoes_pendentes'))
            }
            className={`text-left rounded-xl p-4 border ${
              cardFiltroAtivo === 'devolucoes_pendentes'
                ? 'bg-violet-50 border-violet-300 ring-1 ring-violet-200'
                : 'bg-white border-violet-100'
            }`}
          >
            <div className="text-xs text-gray-500">Devoluções pendentes</div>
            <div className="text-2xl font-bold text-violet-700">{agregados.totalDevolucoesPendentes}</div>
          </button>
        </div>

        <div className="bg-white border border-blue-100 rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#F6F8FF] text-gray-700">
                <tr>
                  <th className="text-center px-4 py-3">Viatura</th>
                  <th className="text-center px-4 py-3">Abastecido</th>
                  <th className="text-center px-4 py-3">Devolvido</th>
                  <th className="text-center px-4 py-3">Requisições pendentes</th>
                  <th className="text-center px-4 py-3">Devoluções pendentes</th>
                  <th className="text-center px-4 py-3">Movimentos</th>
                  <th className="text-center px-4 py-3">Último movimento</th>
                </tr>
              </thead>
              <tbody>
                {viaturasPaginadas.map((row) => {
                  const active = Number(selectedViaturaId || 0) === Number(row.viatura_id || 0);
                  return (
                    <tr
                      key={`${row.viatura_id || row.viatura_nome}`}
                      onClick={() => setSelectedViaturaId(String(row.viatura_id || ''))}
                      className={`border-t cursor-pointer ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 text-center font-medium text-gray-900">{row.viatura_nome}</td>
                      <td className="px-4 py-3 text-center text-emerald-700 font-semibold">{row.abastecido}</td>
                      <td className="px-4 py-3 text-center text-amber-700 font-semibold">{row.devolvido}</td>
                      <td className="px-4 py-3 text-center font-semibold">{row.pendentes_entrega}</td>
                      <td className="px-4 py-3 text-center">{row.devolucoes_pendentes}</td>
                      <td className="px-4 py-3 text-center">{row.movimentos}</td>
                      <td className="px-4 py-3 text-center">{row.ultimo_texto || '—'}</td>
                    </tr>
                  );
                })}
                {!loading && viaturasFiltradasPorCard.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      Sem viaturas para o card/filtros selecionados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {viaturasFiltradasPorCard.length > 0 && (
            <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 bg-white">
              <button
                type="button"
                onClick={() => setViaturasPage((p) => Math.max(1, p - 1))}
                disabled={viaturasPaginaAtual <= 1}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-gray-50"
              >
                Anterior
              </button>
              <span className="text-sm text-gray-600">
                Página {viaturasPaginaAtual} / {totalPaginasViaturas}
              </span>
              <button
                type="button"
                onClick={() => setViaturasPage((p) => Math.min(totalPaginasViaturas, p + 1))}
                disabled={viaturasPaginaAtual >= totalPaginasViaturas}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-gray-50"
              >
                Próxima
              </button>
            </div>
          )}
        </div>

        {Number(selectedViaturaId || 0) > 0 && (
          <div className="bg-white border border-blue-100 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b bg-[#F6F8FF]">
              <h3 className="font-semibold text-gray-900">Requisições e devoluções da viatura selecionada</h3>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 p-4">
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b font-medium text-gray-800">Requisições pendentes</div>
                {expandReqPend && (
                  <div className="px-3 py-2 border-b bg-white">
                    <input
                      value={filtroReqPend}
                      onChange={(e) => setFiltroReqPend(e.target.value)}
                      placeholder="Filtrar por nº requisição, data ou TRA/DEV"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div className={`${expandReqPend ? 'max-h-[220px]' : ''} overflow-y-auto`}>
                  <table className="w-full text-sm">
                    <thead className="bg-white text-gray-600">
                      <tr>
                        <th className="text-center px-3 py-2">ID</th>
                        <th className="text-center px-3 py-2">Status</th>
                        <th className="text-center px-3 py-2">Data</th>
                        <th className="text-center px-3 py-2">TRA/DEV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(expandReqPend ? reqPendLista.slice(0, 5) : reqPendLista.slice(0, 2)).map((r) => (
                        <tr
                          key={`rp-${r.id}`}
                          className="border-t cursor-pointer hover:bg-blue-50"
                          onClick={() => abrirDetalheRequisicao(r)}
                        >
                          <td className="text-center px-3 py-2 font-medium">{r.id}</td>
                          <td className="text-center px-3 py-2">{r.status}</td>
                          <td className="text-center px-3 py-2">{r.data}</td>
                          <td className="text-center px-3 py-2">{r.tra_dev}</td>
                        </tr>
                      ))}
                      {!reqPendLista.length && (
                        <tr>
                          <td colSpan={4} className="text-center px-3 py-4 text-gray-500">Sem requisições pendentes.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 border-t bg-white">
                  <button
                    type="button"
                    onClick={() => setExpandReqPend((v) => !v)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {expandReqPend ? 'Ver menos' : 'Ver mais'}
                  </button>
                </div>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b font-medium text-gray-800">Requisições concluídas</div>
                {expandReqConc && (
                  <div className="px-3 py-2 border-b bg-white">
                    <input
                      value={filtroReqConc}
                      onChange={(e) => setFiltroReqConc(e.target.value)}
                      placeholder="Filtrar por nº requisição, data ou TRA/DEV"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div className={`${expandReqConc ? 'max-h-[220px]' : ''} overflow-y-auto`}>
                  <table className="w-full text-sm">
                    <thead className="bg-white text-gray-600">
                      <tr>
                        <th className="text-center px-3 py-2">ID</th>
                        <th className="text-center px-3 py-2">Status</th>
                        <th className="text-center px-3 py-2">Data</th>
                        <th className="text-center px-3 py-2">TRA/DEV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(expandReqConc ? reqConcLista.slice(0, 5) : reqConcLista.slice(0, 2)).map((r) => (
                        <tr
                          key={`rc-${r.id}`}
                          className="border-t cursor-pointer hover:bg-blue-50"
                          onClick={() => abrirDetalheRequisicao(r)}
                        >
                          <td className="text-center px-3 py-2 font-medium">{r.id}</td>
                          <td className="text-center px-3 py-2">{r.status}</td>
                          <td className="text-center px-3 py-2">{r.data}</td>
                          <td className="text-center px-3 py-2">{r.tra_dev}</td>
                        </tr>
                      ))}
                      {!reqConcLista.length && (
                        <tr>
                          <td colSpan={4} className="text-center px-3 py-4 text-gray-500">Sem requisições concluídas.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 border-t bg-white">
                  <button
                    type="button"
                    onClick={() => setExpandReqConc((v) => !v)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {expandReqConc ? 'Ver menos' : 'Ver mais'}
                  </button>
                </div>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b font-medium text-gray-800">Devoluções pendentes</div>
                {expandDevPend && (
                  <div className="px-3 py-2 border-b bg-white">
                    <input
                      value={filtroDevPend}
                      onChange={(e) => setFiltroDevPend(e.target.value)}
                      placeholder="Filtrar por nº requisição, data ou TRA/DEV"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div className={`${expandDevPend ? 'max-h-[220px]' : ''} overflow-y-auto`}>
                  <table className="w-full text-sm">
                    <thead className="bg-white text-gray-600">
                      <tr>
                        <th className="text-center px-3 py-2">ID</th>
                        <th className="text-center px-3 py-2">Status</th>
                        <th className="text-center px-3 py-2">Data</th>
                        <th className="text-center px-3 py-2">TRA/DEV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(expandDevPend
                        ? devPendLista.slice(0, 5)
                        : devPendLista.slice(0, 2)
                      ).map((r) => (
                        <tr
                          key={`dp-${r.id}`}
                          className="border-t cursor-pointer hover:bg-blue-50"
                          onClick={() => abrirDetalheRequisicao(r)}
                        >
                          <td className="text-center px-3 py-2 font-medium">{r.id}</td>
                          <td className="text-center px-3 py-2">{r.status}</td>
                          <td className="text-center px-3 py-2">{r.data}</td>
                          <td className="text-center px-3 py-2">{r.tra_dev}</td>
                        </tr>
                      ))}
                      {!devPendLista.length && (
                        <tr>
                          <td colSpan={4} className="text-center px-3 py-4 text-gray-500">Sem devoluções pendentes.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 border-t bg-white">
                  <button
                    type="button"
                    onClick={() => setExpandDevPend((v) => !v)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {expandDevPend ? 'Ver menos' : 'Ver mais'}
                  </button>
                </div>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b font-medium text-gray-800">Devoluções concluídas</div>
                {expandDevConc && (
                  <div className="px-3 py-2 border-b bg-white">
                    <input
                      value={filtroDevConc}
                      onChange={(e) => setFiltroDevConc(e.target.value)}
                      placeholder="Filtrar por nº requisição, data ou TRA/DEV"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div className={`${expandDevConc ? 'max-h-[220px]' : ''} overflow-y-auto`}>
                  <table className="w-full text-sm">
                    <thead className="bg-white text-gray-600">
                      <tr>
                        <th className="text-center px-3 py-2">ID</th>
                        <th className="text-center px-3 py-2">Status</th>
                        <th className="text-center px-3 py-2">Data</th>
                        <th className="text-center px-3 py-2">TRA/DEV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(expandDevConc
                        ? devConcLista.slice(0, 5)
                        : devConcLista.slice(0, 2)
                      ).map((r) => (
                        <tr
                          key={`dc-${r.id}`}
                          className="border-t cursor-pointer hover:bg-blue-50"
                          onClick={() => abrirDetalheRequisicao(r)}
                        >
                          <td className="text-center px-3 py-2 font-medium">{r.id}</td>
                          <td className="text-center px-3 py-2">{r.status}</td>
                          <td className="text-center px-3 py-2">{r.data}</td>
                          <td className="text-center px-3 py-2">{r.tra_dev}</td>
                        </tr>
                      ))}
                      {!devConcLista.length && (
                        <tr>
                          <td colSpan={4} className="text-center px-3 py-4 text-gray-500">Sem devoluções concluídas.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 border-t bg-white">
                  <button
                    type="button"
                    onClick={() => setExpandDevConc((v) => !v)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {expandDevConc ? 'Ver menos' : 'Ver mais'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {selectedReqDetail && (
        <div
          className="fixed inset-0 z-[10070] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedReqDetail(null);
              setReporteReqRows([]);
            }
          }}
        >
          <div className="w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div>
                <h3 className="text-base font-semibold text-gray-900">
                  Requisição #{selectedReqDetail.id}
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Status: {selectedReqDetail.status} · Data: {selectedReqDetail.data} · TRA/DEV: {selectedReqDetail.tra_dev}
                </p>
                {reporteReqLoading ? (
                  <p className="text-xs text-gray-500 mt-1">A carregar lotes/metragens do reporte...</p>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={() => {
                  setSelectedReqDetail(null);
                  setReporteReqRows([]);
                }}
              >
                Fechar
              </button>
            </div>
            <div className="max-h-[calc(90vh-64px)] overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="text-center px-4 py-3">REF.</th>
                    <th className="text-center px-4 py-3">Descrição</th>
                    <th className="text-center px-4 py-3">Qtd</th>
                    <th className="text-center px-4 py-3">Lote</th>
                    <th className="text-center px-4 py-3">S/N</th>
                  </tr>
                </thead>
                <tbody>
                  {itensRequisicaoSelecionada.map((it) => (
                    <tr key={it.key} className="border-t">
                      <td className="text-center px-4 py-3 font-medium">{it.ref}</td>
                      <td className="text-center px-4 py-3">{it.descricao}</td>
                      <td className="text-center px-4 py-3">{it.qtd}</td>
                      <td className="text-center px-4 py-3">{it.lote}</td>
                      <td className="text-center px-4 py-3">
                        {it.seriais.length <= 1 ? (
                          it.seriais[0] || '—'
                        ) : (
                          <button
                            type="button"
                            className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
                            onClick={() => setSelectedReqSeriais({ title: it.ref, items: it.seriais })}
                          >
                            Ver {it.seriais.length} seriais
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!itensRequisicaoSelecionada.length && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        Sem itens atrelados a esta requisição.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {selectedReqSeriais && (
        <div
          className="fixed inset-0 z-[10080] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedReqSeriais(null);
          }}
        >
          <div className="w-full max-w-lg max-h-[85vh] overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h3 className="text-base font-semibold text-gray-900">Seriais · {selectedReqSeriais.title || 'Item'}</h3>
              <button
                type="button"
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={() => setSelectedReqSeriais(null)}
              >
                Fechar
              </button>
            </div>
            <div className="max-h-[calc(85vh-64px)] overflow-auto px-4 py-3">
              <ol className="list-decimal list-inside space-y-1 text-sm text-gray-800">
                {selectedReqSeriais.items.map((sn, idx) => (
                  <li key={`${idx}-${sn}`} className="break-all">{sn}</li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
};

export default DashboardViaturas;
