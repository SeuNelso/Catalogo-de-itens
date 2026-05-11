import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  FaChevronDown,
  FaExchangeAlt,
  FaList,
  FaMapMarkerAlt,
  FaQrcode,
  FaSearch,
  FaWarehouse
} from 'react-icons/fa';
import QrScannerModal from '../components/QrScannerModal';
import PesquisaComLeitorQr from '../components/PesquisaComLeitorQr';
import { FORMATOS_QR_BARCODE } from '../utils/qrBarcodeFormats';
import { useAuth } from '../contexts/AuthContext';
import { podeUsarControloStock } from '../utils/controloStock';
import { podeGerarTrflMovimentacaoInterna } from '../utils/roles';
import Toast from '../components/Toast';

const MAX_SUGESTOES = 40;
const RECEBIMENTO_REFRESH_EVENT = 'recebimento-card-refresh';
const TICKETS_PAGE_SIZE = 14;
const MAX_SUGESTOES_CODIGO_ARTIGO = 8;

const normBusca = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const normalizarLocStockApi = (v) =>
  String(v || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const formatMetrosLoteWizard = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '');
  if (Math.abs(num) < 1e-12) return '0';
  return num.toString();
};

/** Soma `quantidade_disponivel` em `stock_lote` para os códigos de lote selecionados. */
function somaMetragemLotesSelecionados(opcoes, codigosSel) {
  const norm = (s) => String(s || '').trim().toUpperCase();
  const setSel = new Set((codigosSel || []).map(norm));
  let sum = 0;
  for (const l of opcoes || []) {
    if (setSel.has(norm(l.lote))) {
      sum += Number(l.quantidade_disponivel) || 0;
    }
  }
  return sum;
}

const pickDestinoPadraoApeado = (locs = []) => {
  if (!Array.isArray(locs) || locs.length === 0) return null;
  const prioridade = ['reception', 'rececao', 'recepcao', 'receção', 'entrada', 'guarda'];
  for (const termo of prioridade) {
    const hit = locs.find((l) => normBusca(l?.localizacao || '').includes(termo));
    if (hit) return hit;
  }
  return locs[0];
};

const isTipoControloSerial = (tipoControlo) => {
  const raw = String(tipoControlo || '').trim().toUpperCase();
  const norm = raw.replace(/\s+/g, '');
  return norm === 'S/N' || norm === 'SN' || norm === 'SERIAL';
};

const extrairCodigoArtigo = (valor) => {
  const s = String(valor || '').trim();
  if (!s) return '';
  return s.split(' - ')[0].trim();
};

const resolveRowStockPrefill = (linhas, prefillItem) => {
  const itemId = Number(prefillItem?.item_id || 0);
  if (Number.isFinite(itemId) && itemId > 0) {
    const byId = (linhas || []).find((r) => Number(r?.item_id || 0) === itemId);
    if (byId) return byId;
  }
  const codigo = String(prefillItem?.codigo || '').trim().toUpperCase();
  if (!codigo) return null;
  return (linhas || []).find((r) => String(r?.codigo || '').trim().toUpperCase() === codigo) || null;
};

const normalizarParticaoPrefill = (raw, modoFallback = 'normal') => {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'apeado' || v === 'apeados') return 'apeado';
  if (v === 'normal') return 'normal';
  return String(modoFallback || '').trim().toLowerCase() === 'apeado' ? 'apeado' : 'normal';
};

const mapPrefillPayloadToRows = (payload) => {
  const modoFallback = normalizarParticaoPrefill(payload?.modo, 'normal');
  const rows = [];
  if (Array.isArray(payload?.items_v2) && payload.items_v2.length > 0) {
    payload.items_v2.forEach((it, idxItem) => {
      const codigo = String(it?.codigo || '').trim();
      if (!codigo) return;
      const itemId = Number(it?.item_id || 0);
      const basePart = normalizarParticaoPrefill(it?.particao, modoFallback);
      const allocations = Array.isArray(it?.allocations) && it.allocations.length > 0
        ? it.allocations
        : [{ id: `auto-${idxItem}`, particao: basePart, quantidade: Number(it?.quantidade_total || 0) || 0, destinoId: '', seriais: it?.seriais || [] }];
      const totalFromAlloc = allocations.reduce((s, a) => s + (Number(a?.quantidade || 0) || 0), 0);
      const quantidadeTotal = Number(it?.quantidade_total || totalFromAlloc || 0) || 0;
      allocations.forEach((al, idxAl) => {
        const qtd = Number(al?.quantidade || 0) || 0;
        if (qtd <= 0) return;
        const particao = normalizarParticaoPrefill(al?.particao, basePart);
        rows.push({
          item_id: Number.isFinite(itemId) && itemId > 0 ? itemId : null,
          codigo,
          descricao: String(it?.descricao || '').trim(),
          tipocontrolo: String(it?.tipocontrolo || '').trim(),
          seriais_sugeridos: Array.isArray(al?.seriais)
            ? [...new Set(al.seriais.map((s) => String(s || '').trim()).filter(Boolean))]
            : (Array.isArray(it?.seriais) ? [...new Set(it.seriais.map((s) => String(s || '').trim()).filter(Boolean))] : []),
          lotes_sugeridos: Array.isArray(al?.lotes)
            ? [...new Set(al.lotes.map((s) => String(s || '').trim()).filter(Boolean))]
            : [],
          quantidade: qtd,
          quantidade_total_item: quantidadeTotal,
          particao,
          grupo_key: `${Number(itemId || 0) || 0}::${codigo.toUpperCase()}::${particao}`,
          allocation_id: String(al?.id || `alloc-${idxItem}-${idxAl}`),
          destinoId: String(al?.destinoId || ''),
          serials: Array.isArray(al?.seriais)
            ? [...new Set(al.seriais.map((s) => String(s || '').trim()).filter(Boolean))]
            : [],
          lotes: Array.isArray(al?.lotes)
            ? [...new Set(al.lotes.map((s) => String(s || '').trim()).filter(Boolean))]
            : [],
        });
      });
    });
    return rows;
  }

  const byCodigo = new Map();
  (Array.isArray(payload?.items) ? payload.items : []).forEach((it) => {
    const codigo = String(it?.codigo || '').trim();
    const qtd = Number(it?.quantidade || 0) || 0;
    if (!codigo || qtd <= 0) return;
    const itemId = Number(it?.item_id || 0);
    const key = Number.isFinite(itemId) && itemId > 0 ? `ID:${itemId}` : `COD:${codigo.toUpperCase()}`;
    const prev = byCodigo.get(key) || {
      item_id: Number.isFinite(itemId) && itemId > 0 ? itemId : null,
      codigo,
      descricao: String(it?.descricao || '').trim(),
      tipocontrolo: String(it?.tipocontrolo || '').trim(),
      seriais_sugeridos: Array.isArray(it?.seriais)
        ? [...new Set(it.seriais.map((s) => String(s || '').trim()).filter(Boolean))]
        : [],
      quantidade: 0,
      destinoId: '',
      serials: [],
      quantidade_total_item: 0,
      particao: modoFallback,
      grupo_key: `${Number(itemId || 0) || 0}::${codigo.toUpperCase()}::${modoFallback}`,
      allocation_id: `legacy-${key}`,
    };
    prev.quantidade += qtd;
    prev.quantidade_total_item += qtd;
    if (!prev.descricao) prev.descricao = String(it?.descricao || '').trim();
    if (!prev.tipocontrolo) prev.tipocontrolo = String(it?.tipocontrolo || '').trim();
    if (Array.isArray(it?.seriais) && it.seriais.length > 0) {
      prev.seriais_sugeridos = [
        ...new Set([...(prev.seriais_sugeridos || []), ...it.seriais.map((s) => String(s || '').trim()).filter(Boolean)]),
      ];
    }
    byCodigo.set(key, prev);
  });
  return [...byCodigo.values()];
};

const makeGrupoKey = (row, modoFallback = 'normal') => {
  const particao = normalizarParticaoPrefill(row?.particao, modoFallback);
  return String(
    row?.grupo_key
    || `${Number(row?.item_id || 0) || 0}::${String(row?.codigo || '').trim().toUpperCase()}::${particao}`
  );
};

/**
 * Uma única caixa: escrever filtra; clique na seta ou foco mostra lista; «Ler» mantém-se à direita.
 */
function LocalizacaoCombobox({
  instanceId,
  options,
  inputValue,
  selectedId,
  inputId,
  onInputChange,
  onSelect,
  onBlurCommitExact,
  disabled,
  lerDisabled,
  onLerClick,
  placeholder,
  lerTitle,
  lerAriaLabel,
  emptyListMessage,
  filterNoMatchMessage
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const listId = `${instanceId}-loc-list`;

  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const handleInputChange = (e) => {
    onInputChange(e.target.value);
    setOpen(true);
  };

  const handleInputBlur = () => {
    window.setTimeout(() => {
      if (wrapRef.current?.contains(document.activeElement)) return;
      setOpen(false);
      onBlurCommitExact?.();
    }, 120);
  };

  const showList = open && !disabled;
  const hasOptions = options.length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex gap-2 min-w-0">
        <div className="relative flex-1 min-w-0">
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none z-[1]" />
          <input
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            value={inputValue}
            onChange={handleInputChange}
            onFocus={() => !disabled && setOpen(true)}
            onBlur={handleInputBlur}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            className="w-full pl-9 pr-10 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#0915FF]"
          />
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => !disabled && setOpen((o) => !o)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-40"
            title="Mostrar localizações"
            aria-label="Abrir lista de localizações"
          >
            <FaChevronDown className={`text-sm transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </div>
        <button
          type="button"
          onClick={onLerClick}
          disabled={lerDisabled || disabled}
          className="shrink-0 px-3 py-2 border border-gray-300 rounded-lg text-sm flex items-center justify-center gap-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-45 disabled:cursor-not-allowed"
          title={lerTitle}
          aria-label={lerAriaLabel || lerTitle}
        >
          <FaQrcode className="text-base text-[#0915FF]" />
          <span className="hidden sm:inline whitespace-nowrap">Ler</span>
        </button>
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-[100] left-0 right-0 mt-1 max-h-[min(240px,42vh)] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1"
        >
          {!hasOptions ? (
            <li className="px-3 py-3 text-xs text-gray-500 text-center">{filterNoMatchMessage}</li>
          ) : (
            options.map((l) => (
              <li key={l.id} role="option" aria-selected={String(l.id) === String(selectedId ?? '')}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[#0915FF]/10 font-mono"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(l);
                    setOpen(false);
                  }}
                >
                  {l.localizacao}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {emptyListMessage ? <p className="text-[11px] text-amber-800 mt-1">{emptyListMessage}</p> : null}
    </div>
  );
}

const TransferenciaLocalizacao = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [armazens, setArmazens] = useState([]);
  const [loadingArmazens, setLoadingArmazens] = useState(true);
  const [modoTransferencia, setModoTransferencia] = useState('localizacao');
  const [armazemId, setArmazemId] = useState('');
  const [apeadoArmazemId, setApeadoArmazemId] = useState('');
  const [origemId, setOrigemId] = useState('');
  const [destinoId, setDestinoId] = useState('');
  const [linhasOrigem, setLinhasOrigem] = useState([]);
  const [loadingEstoque, setLoadingEstoque] = useState(false);
  const [codigoArtigo, setCodigoArtigo] = useState('');
  const [qtdDigitada, setQtdDigitada] = useState('');
  /** Uma única linha por movimentação (1 artigo por ticket). */
  const [linhaPendente, setLinhaPendente] = useState(null);
  const [qrLeitorOpen, setQrLeitorOpen] = useState(false);
  const [qrLeitorPurpose, setQrLeitorPurpose] = useState(null);
  const qrLeitorPurposeRef = useRef(null);
  const [filtroOrigemLoc, setFiltroOrigemLoc] = useState('');
  const [filtroDestinoLoc, setFiltroDestinoLoc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  const [tickets, setTickets] = useState([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [ticketsSoPendentesTrfl, setTicketsSoPendentesTrfl] = useState(true);
  const [selectedTicketIds, setSelectedTicketIds] = useState([]);
  const [exportingTrfl, setExportingTrfl] = useState(false);
  const [deletingTickets, setDeletingTickets] = useState(false);
  const [ticketsPage, setTicketsPage] = useState(1);
  const [sugestoesRemotasCodigo, setSugestoesRemotasCodigo] = useState([]);
  const [sugestoesCodigoLoading, setSugestoesCodigoLoading] = useState(false);
  const [mostrarListaCodigoArtigo, setMostrarListaCodigoArtigo] = useState(false);
  const [selectedCodigoIndex, setSelectedCodigoIndex] = useState(-1);
  const [pesquisaArtigo, setPesquisaArtigo] = useState('');
  const [loteRecebimento, setLoteRecebimento] = useState([]);
  const [serialOptionsByItemId, setSerialOptionsByItemId] = useState({});
  const [serialPickerIdx, setSerialPickerIdx] = useState(null);
  const [loteOrigemLabel, setLoteOrigemLabel] = useState('');
  const [submittingLote, setSubmittingLote] = useState(false);
  const prefillConsumidoRef = useRef(false);
  const wizardCatalogMetaReqIdRef = useRef(0);
  /** 1=origem, 2=artigo, 3=quantidade, 4=destino, 5=confirmar */
  const [wizardStep, setWizardStep] = useState(1);
  /** Linha de stock escolhida no passo 2 → passo 3 */
  const [artigoCorrente, setArtigoCorrente] = useState(null);
  /** Wizard (passo 3): seriais escolhidos para artigo S/N quando `pode` e há lista na origem */
  const [wizardSerialsOpcoes, setWizardSerialsOpcoes] = useState([]);
  const [wizardSerialsLoading, setWizardSerialsLoading] = useState(false);
  /** Mensagem da API (ex.: 403) para não confundir com “não há seriais na origem”. */
  const [wizardSerialsErro, setWizardSerialsErro] = useState('');
  const [wizardSerialsSel, setWizardSerialsSel] = useState([]);
  /** Passo 3 · artigos LOTE: lotes em `stock_lote` na localização de origem */
  const [wizardLotesOpcoes, setWizardLotesOpcoes] = useState([]);
  const [wizardLotesLoading, setWizardLotesLoading] = useState(false);
  const [wizardLotesErro, setWizardLotesErro] = useState('');
  /** Passo 3 · LOTE: um ou mais lotes; a quantidade segue a soma das metragens (ajustável depois). */
  const [wizardLotesSel, setWizardLotesSel] = useState([]);
  /** Sem controlo de stock: metadados do artigo resolvidos por API (para S/N no assistente) */
  const [wizardItemMetaNoPode, setWizardItemMetaNoPode] = useState(null);
  const [wizardItemMetaLoading, setWizardItemMetaLoading] = useState(false);
  const refCodigoArtigoWrap = useRef(null);
  const refCodigoArtigoInput = useRef(null);
  const refListaCodigoArtigo = useRef(null);

  useEffect(() => {
    const p = new URLSearchParams(location.search || '');
    const modo = String(p.get('modo') || '').trim().toLowerCase();
    if (modo === 'apeado') setModoTransferencia('apeado');
    else if (modo === 'localizacao') setModoTransferencia('localizacao');
  }, [location.search]);

  const pode = user && podeUsarControloStock(user);
  const podeCriarTickets =
    user &&
    ['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador'].includes(
      String(user.role || '').toLowerCase()
    );
  const podeExportarTrfl = podeGerarTrflMovimentacaoInterna(user?.role);

  const WIZARD_STEPS = [
    { n: 1, label: 'Origem' },
    { n: 2, label: 'Artigo' },
    { n: 3, label: 'Quantidade' },
    { n: 4, label: 'Destino' },
    { n: 5, label: 'Confirmar' }
  ];

  useEffect(() => {
    if (prefillConsumidoRef.current) return;
    const payload = location.state?.recebimentoPrefill;
    const hasV2 = Array.isArray(payload?.items_v2) && payload.items_v2.length > 0;
    const hasV1 = Array.isArray(payload?.items) && payload.items.length > 0;
    if (!payload || (!hasV2 && !hasV1)) return;
    prefillConsumidoRef.current = true;

    const modoPrefill = String(payload.modo || '').trim().toLowerCase();
    if (modoPrefill === 'apeado') setModoTransferencia('apeado');

    const armazemPrefill = String(payload.armazemId || '').trim();
    if (armazemPrefill) setArmazemId(armazemPrefill);

    const origemLabel = String(payload.origemLocalizacao || '').trim();
    setLoteOrigemLabel(origemLabel);
    if (origemLabel) setFiltroOrigemLoc(origemLabel);

    setLoteRecebimento(mapPrefillPayloadToRows(payload));
  }, [location.state]);

  useEffect(() => {
    if (!loteRecebimento.length || !armazemId || !origemId) {
      setSerialOptionsByItemId({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const serialRows = [];
        for (const it of loteRecebimento) {
          const rowStock = resolveRowStockPrefill(linhasOrigem, it);
          const tipocontroloItem = String(rowStock?.tipocontrolo || it?.tipocontrolo || '').trim();
          if (!isTipoControloSerial(tipocontroloItem)) continue;
          const itemId = Number(rowStock?.item_id || it?.item_id || 0);
          if (!Number.isFinite(itemId) || itemId <= 0) continue;
          const { data } = await axios.get(
            `/api/armazens/${armazemId}/localizacoes/${origemId}/itens/${itemId}/seriais-disponiveis`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          serialRows.push([String(itemId), Array.isArray(data) ? data : []]);
        }
        if (cancelled) return;
        setSerialOptionsByItemId(Object.fromEntries(serialRows));
      } catch {
        if (!cancelled) setSerialOptionsByItemId({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loteRecebimento, linhasOrigem, armazemId, origemId]);

  useEffect(() => {
    setWizardSerialsSel([]);
    setWizardSerialsOpcoes([]);
    setWizardSerialsErro('');
    setWizardLotesOpcoes([]);
    setWizardLotesErro('');
    setWizardLotesSel([]);
  }, [artigoCorrente?.item_id, artigoCorrente?.codigo, origemId, wizardItemMetaNoPode?.item_id]);

  useEffect(() => {
    const lim = Math.max(0, Math.floor(Number(qtdDigitada) || 0));
    setWizardSerialsSel((prev) => (prev.length > lim ? prev.slice(0, lim) : prev));
  }, [qtdDigitada]);

  useEffect(() => {
    if (pode || wizardStep !== 3) {
      setWizardItemMetaNoPode(null);
      setWizardItemMetaLoading(false);
      return;
    }
    const cod = String(artigoCorrente?.codigo || extrairCodigoArtigo(codigoArtigo) || '').trim();
    if (!cod) {
      setWizardItemMetaNoPode(null);
      setWizardItemMetaLoading(false);
      return;
    }
    setWizardItemMetaLoading(true);
    const reqId = ++wizardCatalogMetaReqIdRef.current;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/itens', {
          params: { search: cod, limit: 40, page: 1, incluirInativos: true },
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled || wizardCatalogMetaReqIdRef.current !== reqId) return;
        const itens = Array.isArray(data?.itens) ? data.itens : [];
        const up = cod.toUpperCase();
        const hit = itens.find((it) => String(it?.codigo || '').trim().toUpperCase() === up);
        if (!hit) {
          setWizardItemMetaNoPode(null);
          return;
        }
        const itemId = Number(hit.id ?? hit.item_id ?? 0);
        setWizardItemMetaNoPode({
          item_id: Number.isFinite(itemId) && itemId > 0 ? itemId : null,
          codigo: String(hit.codigo || cod).trim(),
          descricao: String(hit.descricao || hit.nome || '').trim(),
          tipocontrolo: String(hit.tipocontrolo || '').trim(),
        });
      } catch {
        if (!cancelled && wizardCatalogMetaReqIdRef.current === reqId) setWizardItemMetaNoPode(null);
      } finally {
        if (!cancelled && wizardCatalogMetaReqIdRef.current === reqId) {
          setWizardItemMetaLoading(false);
        }
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pode, wizardStep, artigoCorrente?.codigo, codigoArtigo]);

  useEffect(() => {
    if (wizardStep !== 3 || !armazemId || !origemId) {
      setWizardSerialsOpcoes([]);
      setWizardSerialsErro('');
      setWizardSerialsLoading(false);
      return;
    }
    const meta = pode ? artigoCorrente : wizardItemMetaNoPode;
    if (!meta) {
      setWizardSerialsOpcoes([]);
      setWizardSerialsErro('');
      setWizardSerialsLoading(false);
      return;
    }
    const tipocontroloItem = String(meta.tipocontrolo || '').trim();
    if (!isTipoControloSerial(tipocontroloItem)) {
      setWizardSerialsOpcoes([]);
      setWizardSerialsErro('');
      setWizardSerialsLoading(false);
      return;
    }
    const itemId = Number(meta.item_id || 0);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      setWizardSerialsOpcoes([]);
      setWizardSerialsErro('');
      setWizardSerialsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setWizardSerialsLoading(true);
      setWizardSerialsErro('');
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get(
          `/api/armazens/${armazemId}/localizacoes/${origemId}/itens/${itemId}/seriais-disponiveis`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : [];
        setWizardSerialsOpcoes(
          rows.map((r) => ({
            id: r?.id,
            serialnumber: String(r?.serialnumber ?? r?.serial ?? '').trim(),
          })).filter((r) => r.serialnumber)
        );
        setWizardSerialsErro('');
      } catch (e) {
        if (!cancelled) {
          setWizardSerialsOpcoes([]);
          const apiMsg = e?.response?.data?.error;
          const st = e?.response?.status;
          setWizardSerialsErro(
            st === 403 || st === 401
              ? String(apiMsg || 'Sem permissão para listar seriais nesta localização.')
              : apiMsg
                ? String(apiMsg)
                : 'Não foi possível carregar os seriais. Tente novamente.'
          );
        }
      } finally {
        if (!cancelled) setWizardSerialsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wizardStep, armazemId, origemId, pode, artigoCorrente, wizardItemMetaNoPode]);

  const limparPrefillRecebimento = useCallback(() => {
    setLoteRecebimento([]);
    setLoteOrigemLabel('');
    setOrigemId('');
    setFiltroOrigemLoc('');
    setWizardStep(1);
    // Limpa o state da rota para não reaplicar o pré-preenchimento ao regressar.
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate]);

  useEffect(() => {
    const load = async () => {
      try {
        setLoadingArmazens(true);
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/armazens?ativo=true&consulta_estoque_localizacao=1', {
          headers: { Authorization: `Bearer ${token}` }
        });
        setArmazens(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error(e);
        setToast({ type: 'error', message: 'Erro ao carregar armazéns.' });
      } finally {
        setLoadingArmazens(false);
      }
    };
    load();
  }, []);

  const centrais = useMemo(
    () => (armazens || []).filter((a) => String(a?.tipo || '').trim().toLowerCase() === 'central'),
    [armazens]
  );

  const armazemUnico = centrais.length === 1;

  useEffect(() => {
    if (loadingArmazens || centrais.length !== 1) return;
    setArmazemId((prev) => (prev ? prev : String(centrais[0].id)));
  }, [loadingArmazens, centrais]);

  const armazemSel = useMemo(
    () => centrais.find((a) => String(a.id) === String(armazemId)),
    [centrais, armazemId]
  );
  const apeadosVinculados = useMemo(
    () =>
      (armazens || []).filter(
        (a) =>
          String(a?.tipo || '').trim().toLowerCase() === 'apeado' &&
          Number(a?.armazem_central_vinculado_id || 0) === Number(armazemId || 0)
      ),
    [armazens, armazemId]
  );
  const apeadoSel = useMemo(
    () => apeadosVinculados.find((a) => String(a.id) === String(apeadoArmazemId)),
    [apeadosVinculados, apeadoArmazemId]
  );

  const armazemExibicao = armazemSel || (armazemUnico ? centrais[0] : null);

  const locsComId = useMemo(() => {
    const locs = armazemSel?.localizacoes || [];
    return locs.filter((l) => l && l.id != null);
  }, [armazemSel]);
  const locsApeadoComId = useMemo(() => {
    const locs = apeadoSel?.localizacoes || [];
    return locs.filter((l) => l && l.id != null);
  }, [apeadoSel]);

  const locsComIdFiltradasOrigem = useMemo(() => {
    const q = normBusca(filtroOrigemLoc);
    if (!q) return locsComId;
    return locsComId.filter((l) => normBusca(l.localizacao || '').includes(q));
  }, [locsComId, filtroOrigemLoc]);

  const locsDestinoCandidatas = useMemo(
    () =>
      modoTransferencia === 'apeado'
        ? locsApeadoComId
        : locsComId.filter((l) => String(l.id) !== String(origemId)),
    [modoTransferencia, locsApeadoComId, locsComId, origemId]
  );

  const locsComIdFiltradasDestino = useMemo(() => {
    const q = normBusca(filtroDestinoLoc);
    if (!q) return locsDestinoCandidatas;
    return locsDestinoCandidatas.filter((l) => normBusca(l.localizacao || '').includes(q));
  }, [locsDestinoCandidatas, filtroDestinoLoc]);

  useEffect(() => {
    if (wizardStep !== 3 || !armazemId || !origemId) {
      setWizardLotesOpcoes([]);
      setWizardLotesErro('');
      setWizardLotesLoading(false);
      return;
    }
    const meta = pode ? artigoCorrente : wizardItemMetaNoPode;
    if (!meta) {
      setWizardLotesOpcoes([]);
      setWizardLotesErro('');
      setWizardLotesLoading(false);
      return;
    }
    if (String(meta.tipocontrolo || '').trim().toUpperCase() !== 'LOTE') {
      setWizardLotesOpcoes([]);
      setWizardLotesErro('');
      setWizardLotesLoading(false);
      return;
    }
    const itemId = Number(meta.item_id || 0);
    const locLabel = normalizarLocStockApi(
      (locsComId || []).find((x) => String(x.id) === String(origemId))?.localizacao || ''
    );
    if (!Number.isFinite(itemId) || itemId <= 0 || !locLabel) {
      setWizardLotesOpcoes([]);
      setWizardLotesErro('');
      setWizardLotesLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setWizardLotesLoading(true);
      setWizardLotesErro('');
      try {
        const token = localStorage.getItem('token');
        const p = new URLSearchParams();
        p.set('item_id', String(itemId));
        p.set('armazem_id', String(Number(armazemId)));
        p.set('localizacao', locLabel);
        const response = await fetch(`/api/requisicoes/stock/disponibilidade?${p.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Erro ao carregar lotes');
        if (cancelled) return;
        const lotes = Array.isArray(data.lotes) ? data.lotes : [];
        setWizardLotesOpcoes(lotes);
        setWizardLotesErro('');
      } catch (e) {
        if (!cancelled) {
          setWizardLotesOpcoes([]);
          setWizardLotesErro(
            e && e.message ? String(e.message) : 'Não foi possível carregar os lotes nesta origem.'
          );
        }
      } finally {
        if (!cancelled) setWizardLotesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wizardStep, armazemId, origemId, pode, artigoCorrente, wizardItemMetaNoPode, locsComId]);

  /** Marcar/desmarcar lotes recalcula a caixa «Quantidade» = soma das metragens disponíveis (limitada ao stock agregado na origem, se aplicável). */
  useEffect(() => {
    if (wizardStep !== 3) return;
    if (wizardLotesSel.length === 0) {
      setQtdDigitada('');
      return;
    }
    let sum = somaMetragemLotesSelecionados(wizardLotesOpcoes, wizardLotesSel);
    if (pode && artigoCorrente) {
      const maxAgg = Number(artigoCorrente.quantidade) || 0;
      sum = Math.min(sum, maxAgg);
    }
    setQtdDigitada(formatMetrosLoteWizard(Math.max(0, sum)));
  }, [wizardStep, wizardLotesSel, wizardLotesOpcoes, pode, artigoCorrente]);

  const toggleWizardLoteSel = useCallback((loteCod) => {
    const key = String(loteCod || '').trim();
    if (!key) return;
    setWizardLotesSel((prev) => {
      const norm = (s) => String(s || '').trim().toUpperCase();
      const k = norm(key);
      const has = prev.some((p) => norm(p) === k);
      if (has) return prev.filter((p) => norm(p) !== k);
      return [...prev, key];
    });
  }, []);

  const abrirLeitorQr = (purpose) => {
    qrLeitorPurposeRef.current = purpose;
    setQrLeitorPurpose(purpose);
    setQrLeitorOpen(true);
  };

  const aplicarScanOrigem = useCallback(
    (texto) => {
      const trimmed = String(texto || '').trim();
      if (!trimmed) return;
      const byId = locsComId.find((l) => String(l.id) === trimmed);
      if (byId) {
        setFiltroOrigemLoc(byId.localizacao || trimmed);
        setOrigemId(String(byId.id));
        setToast({ type: 'success', message: `Origem: ${byId.localizacao}` });
        return;
      }
      const n = normBusca(trimmed);
      const exact = locsComId.filter((l) => normBusca(l.localizacao || '') === n);
      if (exact.length === 1) {
        setFiltroOrigemLoc(trimmed);
        setOrigemId(String(exact[0].id));
        setToast({ type: 'success', message: `Origem: ${exact[0].localizacao}` });
        return;
      }
      setFiltroOrigemLoc(trimmed);
      const filtered = locsComId.filter((l) => normBusca(l.localizacao || '').includes(n));
      if (filtered.length === 1) {
        setOrigemId(String(filtered[0].id));
        setToast({ type: 'success', message: `Origem: ${filtered[0].localizacao}` });
      } else if (filtered.length === 0) {
        setToast({ type: 'error', message: 'Localização não encontrada neste armazém.' });
      } else {
        setToast({ type: 'info', message: 'Filtro aplicado; escolha a localização na lista.' });
      }
    },
    [locsComId]
  );

  const aplicarScanDestino = useCallback(
    (texto) => {
      const trimmed = String(texto || '').trim();
      if (!trimmed) return;
      const list = locsDestinoCandidatas;
      const byId = list.find((l) => String(l.id) === trimmed);
      if (byId) {
        setFiltroDestinoLoc(byId.localizacao || trimmed);
        setDestinoId(String(byId.id));
        setToast({ type: 'success', message: `Destino: ${byId.localizacao}` });
        return;
      }
      const n = normBusca(trimmed);
      const exact = list.filter((l) => normBusca(l.localizacao || '') === n);
      if (exact.length === 1) {
        setFiltroDestinoLoc(trimmed);
        setDestinoId(String(exact[0].id));
        setToast({ type: 'success', message: `Destino: ${exact[0].localizacao}` });
        return;
      }
      setFiltroDestinoLoc(trimmed);
      const filtered = list.filter((l) => normBusca(l.localizacao || '').includes(n));
      if (filtered.length === 1) {
        setDestinoId(String(filtered[0].id));
        setToast({ type: 'success', message: `Destino: ${filtered[0].localizacao}` });
      } else if (filtered.length === 0) {
        setToast({ type: 'error', message: 'Localização de destino não encontrada.' });
      } else {
        setToast({ type: 'info', message: 'Filtro aplicado; escolha o destino na lista.' });
      }
    },
    [locsDestinoCandidatas]
  );

  useEffect(() => {
    setOrigemId('');
    setDestinoId('');
    setLinhasOrigem([]);
    setCodigoArtigo('');
    setQtdDigitada('');
    setLinhaPendente(null);
    setPesquisaArtigo('');
    setWizardStep(1);
    setArtigoCorrente(null);
    setFiltroOrigemLoc('');
    setFiltroDestinoLoc('');
  }, [armazemId, modoTransferencia, apeadoArmazemId]);

  useEffect(() => {
    if (modoTransferencia !== 'apeado') {
      setApeadoArmazemId('');
      return;
    }
    if (apeadosVinculados.length === 0) {
      setApeadoArmazemId('');
      return;
    }
    if (!apeadoArmazemId || !apeadosVinculados.some((a) => String(a.id) === String(apeadoArmazemId))) {
      setApeadoArmazemId(String(apeadosVinculados[0].id));
    }
  }, [modoTransferencia, apeadosVinculados, apeadoArmazemId]);

  useEffect(() => {
    if (!loteRecebimento.length || origemId || !loteOrigemLabel || !locsComId.length) return;
    const n = normBusca(loteOrigemLabel);
    const exact = locsComId.find((l) => normBusca(l?.localizacao || '') === n);
    if (exact) {
      setOrigemId(String(exact.id));
      setFiltroOrigemLoc(exact.localizacao || loteOrigemLabel);
    }
  }, [loteRecebimento, origemId, loteOrigemLabel, locsComId]);

  useEffect(() => {
    if (modoTransferencia !== 'apeado' || !loteRecebimento.length || !origemId) return;
    const destinoPadrao = pickDestinoPadraoApeado(locsApeadoComId);
    if (!destinoPadrao?.id) return;
    const destinoPadraoId = String(destinoPadrao.id);
    setLoteRecebimento((prev) =>
      prev.map((it) => {
        const atual = String(it?.destinoId || '').trim();
        return atual && atual !== String(origemId) ? it : { ...it, destinoId: destinoPadraoId };
      })
    );
  }, [modoTransferencia, loteRecebimento.length, origemId, locsApeadoComId]);

  useEffect(() => {
    setLinhasOrigem([]);
    setCodigoArtigo('');
    setQtdDigitada('');
    setLinhaPendente(null);
    setDestinoId('');
    setFiltroDestinoLoc('');
    setPesquisaArtigo('');
    setWizardStep(1);
    setArtigoCorrente(null);
    if (!pode || !armazemId || !origemId) return;
    let cancelled = false;
    (async () => {
      setLoadingEstoque(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get(
          `/api/armazens/${armazemId}/localizacoes/${origemId}/estoque`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!cancelled) {
          setLinhasOrigem(Array.isArray(data) ? data : []);
        }
      } catch (e) {
        const d = e.response?.data;
        if (!cancelled) {
          setLinhasOrigem([]);
          setToast({
            type: 'error',
            message: (d?.error || 'Erro ao carregar stock da origem.') + (d?.hint ? ` ${d.hint}` : '')
          });
        }
      } finally {
        if (!cancelled) setLoadingEstoque(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armazemId, origemId]);

  const loadTickets = useCallback(async () => {
    if (!armazemId) {
      setTickets([]);
      return;
    }
    setLoadingTickets(true);
    try {
      const token = localStorage.getItem('token');
      const q = ticketsSoPendentesTrfl ? '?limit=200&pendente_trfl=1' : '?limit=200';
      const { data } = await axios.get(`/api/armazens/${armazemId}/movimentacoes-internas${q}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const all = Array.isArray(data) ? data : [];
      const filtrados =
        modoTransferencia === 'apeado'
          ? all.filter((t) => String(t?.destino_armazem_tipo || '').trim().toLowerCase() === 'apeado')
          : all.filter((t) => String(t?.destino_armazem_tipo || '').trim().toLowerCase() !== 'apeado');
      setTickets(filtrados);
    } catch (e) {
      console.error(e);
      setTickets([]);
    } finally {
      setLoadingTickets(false);
    }
  }, [armazemId, ticketsSoPendentesTrfl, modoTransferencia]);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    setTicketsPage(1);
  }, [ticketsSoPendentesTrfl, armazemId]);

  const labelLoc = (id) => {
    const l = locsComId.find((x) => String(x.id) === String(id));
    return l ? l.localizacao : '';
  };
  const labelDestino = (id) => {
    const l = locsDestinoCandidatas.find((x) => String(x.id) === String(id));
    return l ? l.localizacao : '';
  };
  const nomeDocumentoFila = modoTransferencia === 'apeado' ? 'TRA APEADO' : 'TRFL';

  const handleOrigemComboboxInput = useCallback(
    (val) => {
      setFiltroOrigemLoc(val);
      setOrigemId((cur) => {
        if (!cur) return '';
        const l = locsComId.find((x) => String(x.id) === String(cur));
        const label = l ? String(l.localizacao || '') : '';
        if (normBusca(val) !== normBusca(label)) return '';
        return cur;
      });
    },
    [locsComId]
  );

  const commitOrigemSeCorrespondenciaExata = useCallback(() => {
    if (origemId) return;
    const q = normBusca(filtroOrigemLoc);
    if (!q) return;
    const exact = locsComId.filter((l) => normBusca(l.localizacao || '') === q);
    if (exact.length === 1) setOrigemId(String(exact[0].id));
  }, [origemId, filtroOrigemLoc, locsComId]);

  const handleDestinoComboboxInput = useCallback(
    (val) => {
      setFiltroDestinoLoc(val);
      setDestinoId((cur) => {
        if (!cur) return '';
        const l = locsDestinoCandidatas.find((x) => String(x.id) === String(cur));
        const label = l ? String(l.localizacao || '') : '';
        if (normBusca(val) !== normBusca(label)) return '';
        return cur;
      });
    },
    [locsDestinoCandidatas]
  );

  const commitDestinoSeCorrespondenciaExata = useCallback(() => {
    if (destinoId) return;
    const q = normBusca(filtroDestinoLoc);
    if (!q) return;
    const exact = locsDestinoCandidatas.filter((l) => normBusca(l.localizacao || '') === q);
    if (exact.length === 1) setDestinoId(String(exact[0].id));
  }, [destinoId, filtroDestinoLoc, locsDestinoCandidatas]);

  const { artigosFiltradosPesquisa, pesquisaResultadosTruncados } = useMemo(() => {
    const q = normBusca(pesquisaArtigo);
    if (!q || !linhasOrigem.length) {
      return { artigosFiltradosPesquisa: [], pesquisaResultadosTruncados: false };
    }
    const all = linhasOrigem.filter((row) => {
      const c = normBusca(row.codigo);
      const d = normBusca(row.descricao);
      return c.includes(q) || d.includes(q);
    });
    return {
      artigosFiltradosPesquisa: all.slice(0, MAX_SUGESTOES),
      pesquisaResultadosTruncados: all.length > MAX_SUGESTOES
    };
  }, [linhasOrigem, pesquisaArtigo]);

  const opcoesArtigoLoteManual = useMemo(() => {
    const byKey = new Map();
    for (const r of linhasOrigem || []) {
      const itemId = Number(r?.item_id || 0);
      const codigo = String(r?.codigo || '').trim();
      if (!codigo) continue;
      const key = itemId > 0 ? `ID:${itemId}` : `COD:${codigo.toUpperCase()}`;
      byKey.set(key, {
        value: key,
        item_id: itemId > 0 ? itemId : null,
        codigo,
        descricao: String(r?.descricao || '').trim(),
        tipocontrolo: String(r?.tipocontrolo || '').trim(),
      });
    }
    if (byKey.size === 0) {
      for (const it of loteRecebimento || []) {
        const itemId = Number(it?.item_id || 0);
        const codigo = String(it?.codigo || '').trim();
        if (!codigo) continue;
        const key = itemId > 0 ? `ID:${itemId}` : `COD:${codigo.toUpperCase()}`;
        if (byKey.has(key)) continue;
        byKey.set(key, {
          value: key,
          item_id: itemId > 0 ? itemId : null,
          codigo,
          descricao: String(it?.descricao || '').trim(),
          tipocontrolo: String(it?.tipocontrolo || '').trim(),
        });
      }
    }
    return [...byKey.values()];
  }, [linhasOrigem, loteRecebimento]);

  const resumoGrupoAlloc = useMemo(() => {
    const map = new Map();
    for (const row of loteRecebimento || []) {
      const key = String(row?.grupo_key || `${Number(row?.item_id || 0) || 0}::${String(row?.codigo || '').trim().toUpperCase()}::${normalizarParticaoPrefill(row?.particao, modoTransferencia)}`);
      const qtd = Number(row?.quantidade || 0) || 0;
      const total = Number(row?.quantidade_total_item || 0) || 0;
      const prev = map.get(key) || { alocado: 0, total: 0 };
      prev.alocado += Math.max(0, qtd);
      if (total > prev.total) prev.total = total;
      map.set(key, prev);
    }
    return map;
  }, [loteRecebimento, modoTransferencia]);

  const sugestoesCodigoArtigo = useMemo(() => {
    const byCodigo = new Map();
    (linhasOrigem || []).forEach((r) => {
      const codigo = String(r?.codigo || '').trim();
      if (!codigo) return;
      const key = codigo.toUpperCase();
      if (byCodigo.has(key)) return;
      byCodigo.set(key, {
        codigo,
        descricao: String(r?.descricao || '').trim(),
      });
    });
    (tickets || []).forEach((t) => {
      const codigo = String(t?.item_codigo || '').trim();
      if (!codigo) return;
      const key = codigo.toUpperCase();
      if (byCodigo.has(key)) return;
      byCodigo.set(key, {
        codigo,
        descricao: String(t?.item_descricao || '').trim(),
      });
    });

    const q = normBusca(extrairCodigoArtigo(codigoArtigo));
    if (!q) return [];

    const locais = [...byCodigo.values()]
      .filter((x) => normBusca(x.codigo).includes(q) || normBusca(x.descricao).includes(q))
      .slice(0, MAX_SUGESTOES_CODIGO_ARTIGO);

    sugestoesRemotasCodigo.forEach((x) => {
      const codigo = String(x?.codigo || '').trim();
      if (!codigo) return;
      const key = codigo.toUpperCase();
      if (!byCodigo.has(key)) {
        byCodigo.set(key, { codigo, descricao: String(x?.descricao || '').trim() });
      }
    });

    return [...locais, ...[...byCodigo.values()].filter((x) => !locais.some((l) => l.codigo === x.codigo))]
      .slice(0, MAX_SUGESTOES_CODIGO_ARTIGO);
  }, [linhasOrigem, tickets, codigoArtigo, sugestoesRemotasCodigo]);

  useEffect(() => {
    if (wizardStep !== 2) {
      setMostrarListaCodigoArtigo(false);
      setSelectedCodigoIndex(-1);
      return;
    }
    if (!mostrarListaCodigoArtigo) return;
    const hasSugestoes = sugestoesCodigoArtigo.length > 0;
    if (hasSugestoes) {
      setSelectedCodigoIndex((idx) => {
        if (idx < 0) return 0;
        return Math.min(idx, sugestoesCodigoArtigo.length - 1);
      });
    } else {
      setSelectedCodigoIndex(-1);
    }
  }, [wizardStep, sugestoesCodigoArtigo, mostrarListaCodigoArtigo]);

  const descricaoCodigoSelecionado = useMemo(() => {
    const codigo = extrairCodigoArtigo(codigoArtigo);
    if (!codigo) return '';
    const key = codigo.toUpperCase();

    const local = (linhasOrigem || []).find(
      (r) => String(r?.codigo || '').trim().toUpperCase() === key
    );
    if (String(local?.descricao || '').trim()) return String(local.descricao).trim();

    const ticket = (tickets || []).find(
      (t) => String(t?.item_codigo || '').trim().toUpperCase() === key
    );
    if (String(ticket?.item_descricao || '').trim()) return String(ticket.item_descricao).trim();

    const remoto = (sugestoesRemotasCodigo || []).find(
      (it) => String(it?.codigo || '').trim().toUpperCase() === key
    );
    if (String(remoto?.descricao || '').trim()) return String(remoto.descricao).trim();

    return '';
  }, [codigoArtigo, linhasOrigem, tickets, sugestoesRemotasCodigo]);

  useEffect(() => {
    const q = extrairCodigoArtigo(codigoArtigo);
    if (!q || wizardStep !== 2) {
      setSugestoesRemotasCodigo([]);
      setSugestoesCodigoLoading(false);
      return;
    }
    let cancelado = false;
    const timer = window.setTimeout(async () => {
      if (!cancelado) setSugestoesCodigoLoading(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/itens', {
          params: {
            search: q,
            limit: MAX_SUGESTOES_CODIGO_ARTIGO,
            page: 1,
            incluirInativos: true,
          },
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelado) return;
        setSugestoesRemotasCodigo(Array.isArray(data?.itens) ? data.itens : []);
      } catch (_) {
        if (!cancelado) setSugestoesRemotasCodigo([]);
      } finally {
        if (!cancelado) setSugestoesCodigoLoading(false);
      }
    }, 220);
    return () => {
      cancelado = true;
      window.clearTimeout(timer);
    };
  }, [codigoArtigo, wizardStep]);

  useEffect(() => {
    if (wizardStep !== 2) return undefined;
    const onDocMouseDown = (e) => {
      if (refCodigoArtigoWrap.current && !refCodigoArtigoWrap.current.contains(e.target)) {
        setMostrarListaCodigoArtigo(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [wizardStep]);

  useEffect(() => {
    if (!mostrarListaCodigoArtigo || selectedCodigoIndex < 0 || !refListaCodigoArtigo.current) return;
    const el = refListaCodigoArtigo.current.querySelector(`[data-sugestao-index="${selectedCodigoIndex}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [mostrarListaCodigoArtigo, selectedCodigoIndex]);

  const selecionarArtigoDaPesquisa = (row) => {
    setArtigoCorrente(row);
    setCodigoArtigo(String(row.codigo || '').trim());
    setPesquisaArtigo('');
    setQtdDigitada('');
    setWizardStep(3);
  };

  const selecionarSugestaoCodigo = (sugestao) => {
    const codigo = String(sugestao?.codigo || '').trim();
    const descricao = String(sugestao?.descricao || '').trim();
    if (!codigo) return;
    setCodigoArtigo(descricao ? `${codigo} - ${descricao}` : codigo);
    setMostrarListaCodigoArtigo(false);
    setSelectedCodigoIndex(-1);
    if (pode) {
      const row = findRowByCodigo(codigo);
      if (row) {
        setArtigoCorrente(row);
        setQtdDigitada('');
        setWizardStep(3);
      }
    }
  };

  const findRowByCodigo = (cod) => {
    const c = extrairCodigoArtigo(cod);
    if (!c) return null;
    const up = c.toUpperCase();
    return (
      linhasOrigem.find((r) => String(r.codigo || '').trim().toUpperCase() === up) ||
      linhasOrigem.find((r) => String(r.codigo || '').trim() === c) ||
      null
    );
  };

  const validarCodigoManualParaPasso3 = () => {
    if (!pode) {
      const cod = extrairCodigoArtigo(codigoArtigo);
      if (!cod) {
        setToast({
          type: 'error',
          message: 'Informe o código do artigo.'
        });
        return;
      }
      setArtigoCorrente({
        item_id: null,
        codigo: cod,
        descricao: '',
        quantidade: null
      });
      setWizardStep(3);
      return;
    }
    const row = findRowByCodigo(codigoArtigo);
    if (!row) {
      setToast({
        type: 'error',
        message: 'Código não encontrado nesta origem. Pesquise ou use o leitor.'
      });
      return;
    }
    setArtigoCorrente(row);
    setQtdDigitada('');
    setWizardStep(3);
  };

  const processarLeituraQr = useCallback(
    (texto) => {
      const purpose = qrLeitorPurposeRef.current;
      qrLeitorPurposeRef.current = null;
      setQrLeitorPurpose(null);
      const raw = String(texto || '').trim();
      if (!raw || !purpose) return;
      switch (purpose) {
        case 'origem':
          aplicarScanOrigem(raw);
          break;
        case 'destino':
          aplicarScanDestino(raw);
          break;
        case 'pesquisaArtigo':
          setPesquisaArtigo(raw);
          break;
        case 'codigoArtigo': {
          setCodigoArtigo(raw);
          if (!pode) {
            setArtigoCorrente({
              item_id: null,
              codigo: raw,
              descricao: '',
              quantidade: null
            });
            setQtdDigitada('');
            setWizardStep(3);
            setToast({ type: 'success', message: 'Código lido — indique a quantidade.' });
            break;
          }
          const up = raw.toUpperCase();
          const r =
            linhasOrigem.find((x) => String(x.codigo || '').trim().toUpperCase() === up) ||
            linhasOrigem.find((x) => String(x.codigo || '').trim() === raw) ||
            null;
          if (r) {
            setArtigoCorrente(r);
            setQtdDigitada('');
            setWizardStep(3);
            setToast({ type: 'success', message: `Artigo ${r.codigo} — indique a quantidade.` });
          } else {
            setToast({ type: 'error', message: 'Código lido não existe nesta origem.' });
          }
          break;
        }
        default:
          break;
      }
    },
    [aplicarScanOrigem, aplicarScanDestino, linhasOrigem, pode]
  );

  useEffect(() => {
    if (pode && wizardStep === 3 && !artigoCorrente) setWizardStep(2);
  }, [wizardStep, artigoCorrente, pode]);

  /** Seriais guardados em `linhaPendente` como `serials` e/ou `seriais` (PT). */
  const serialsListaLinhaPendente = (lp) => {
    const a = Array.isArray(lp?.serials) ? lp.serials : [];
    const b = Array.isArray(lp?.seriais) ? lp.seriais : [];
    return [...new Set([...a, ...b].map((s) => String(s || '').trim()).filter(Boolean))];
  };

  const toggleWizardSerialSelect = (serial, maxQtd) => {
    const sn = String(serial || '').trim();
    if (!sn) return;
    const limite = Math.max(0, Math.floor(Number(maxQtd) || 0));
    setWizardSerialsSel((prev) => {
      const atual = [...new Set(prev.map((s) => String(s || '').trim()).filter(Boolean))];
      if (atual.includes(sn)) return atual.filter((s) => s !== sn);
      if (atual.length >= limite || limite <= 0) return atual;
      return [...atual, sn];
    });
  };

  const confirmarQuantidadeEIrDestino = () => {
    const q = Number(String(qtdDigitada).replace(',', '.'));
    if (!Number.isFinite(q) || q <= 0) {
      setToast({ type: 'error', message: 'Indique uma quantidade válida (> 0).' });
      return;
    }
    const row = artigoCorrente || (pode ? findRowByCodigo(codigoArtigo) : null);
    if (!pode && !row) {
      const cod = extrairCodigoArtigo(codigoArtigo);
      if (!cod) {
        setToast({ type: 'error', message: 'Informe o código do artigo.' });
        return;
      }
      if (wizardItemMetaLoading) {
        setToast({
          type: 'error',
          message: 'Aguarde a carregar os dados do artigo (catálogo) antes de continuar.',
        });
        return;
      }
      const qIntEarly = Math.floor(q);
      const meta = wizardItemMetaNoPode;
      const metaMatch =
        meta && String(meta.codigo || '').trim().toUpperCase() === cod.toUpperCase();
      if (metaMatch && isTipoControloSerial(String(meta.tipocontrolo || '').trim())) {
        if (wizardSerialsSel.length !== qIntEarly) {
          setToast({
            type: 'error',
            message: `Selecione ${qIntEarly} serial(is) para ${cod}.`,
          });
          return;
        }
        setLinhaPendente({
          item_id: meta.item_id,
          codigo: cod,
          descricao: meta.descricao || '',
          quantidade: q,
          tipocontrolo: String(meta.tipocontrolo || ''),
          serials: [...wizardSerialsSel],
        });
      } else if (metaMatch && String(meta.tipocontrolo || '').trim().toUpperCase() === 'LOTE') {
        if (wizardLotesOpcoes.length > 0 && wizardLotesSel.length === 0) {
          setToast({ type: 'error', message: 'Selecione pelo menos um lote na localização de origem.' });
          return;
        }
        if (wizardLotesOpcoes.length > 0 && wizardLotesSel.length > 0) {
          const sumLotes = somaMetragemLotesSelecionados(wizardLotesOpcoes, wizardLotesSel);
          if (q > sumLotes + 1e-9) {
            setToast({
              type: 'error',
              message: `Quantidade superior à soma disponível nos lotes selecionados (${formatMetrosLoteWizard(sumLotes)} m).`,
            });
            return;
          }
        }
        const lotesNorm = [...new Set(wizardLotesSel.map((s) => String(s || '').trim()).filter(Boolean))];
        setLinhaPendente({
          item_id: meta.item_id,
          codigo: cod,
          descricao: meta.descricao || '',
          quantidade: q,
          tipocontrolo: String(meta.tipocontrolo || ''),
          serials: undefined,
          ...(lotesNorm.length > 0 ? { lotes: lotesNorm } : {}),
        });
      } else if (metaMatch) {
        setLinhaPendente({
          item_id: meta.item_id,
          codigo: cod,
          descricao: meta.descricao || '',
          quantidade: q,
          tipocontrolo: String(meta.tipocontrolo || ''),
          serials: undefined,
        });
      } else {
        setLinhaPendente({
          item_id: null,
          codigo: cod,
          descricao: '',
          quantidade: q,
          tipocontrolo: '',
          serials: undefined,
        });
      }
      setCodigoArtigo('');
      setQtdDigitada('');
      setArtigoCorrente(null);
      setWizardStep(4);
      setToast({ type: 'success', message: 'Escolha a localização de destino.' });
      return;
    }
    if (!row) {
      setToast({
        type: 'error',
        message: 'Código não encontrado nesta localização de origem (use a pesquisa ou o código exato).'
      });
      return;
    }
    if (pode) {
      const max = Number(row.quantidade) || 0;
      if (q > max) {
        setToast({
          type: 'error',
          message: `Quantidade superior ao disponível (${max}) para ${row.codigo}.`
        });
        return;
      }
    }
    const qInt = Math.floor(q);
    const rowIsSerialPode =
      pode && row && isTipoControloSerial(String(row.tipocontrolo || '').trim());
    if (rowIsSerialPode && wizardSerialsSel.length !== qInt) {
      setToast({
        type: 'error',
        message: `Selecione ${qInt} serial(is) para ${row.codigo}.`,
      });
      return;
    }
    const codR = row ? String(row.codigo || '').trim() : '';
    const metaAlinhado =
      !pode && row && wizardItemMetaNoPode &&
      String(wizardItemMetaNoPode.codigo || '').trim().toUpperCase() === codR.toUpperCase()
        ? wizardItemMetaNoPode
        : null;
    if (!pode && row && !String(row.tipocontrolo || '').trim() && wizardItemMetaLoading) {
      setToast({
        type: 'error',
        message: 'Aguarde a carregar os dados do artigo (catálogo) antes de continuar.',
      });
      return;
    }
    if (!pode && row && !String(row.tipocontrolo || '').trim() && !metaAlinhado && !wizardItemMetaLoading) {
      setToast({
        type: 'error',
        message: 'Artigo não encontrado no catálogo com este código exato.',
      });
      return;
    }
    const noPodeSerial =
      !pode &&
      row &&
      metaAlinhado &&
      isTipoControloSerial(String(metaAlinhado.tipocontrolo || '').trim());
    if (noPodeSerial && wizardSerialsSel.length !== qInt) {
      setToast({
        type: 'error',
        message: `Selecione ${qInt} serial(is) para ${row.codigo}.`,
      });
      return;
    }
    const tipoLinhaFinal = noPodeSerial
      ? String(metaAlinhado?.tipocontrolo || '')
      : String(row?.tipocontrolo || metaAlinhado?.tipocontrolo || '').trim();
    const isLoteLinha = String(tipoLinhaFinal || '').toUpperCase() === 'LOTE';
    if (isLoteLinha && wizardLotesOpcoes.length > 0) {
      if (wizardLotesSel.length === 0) {
        setToast({ type: 'error', message: 'Selecione pelo menos um lote na localização de origem.' });
        return;
      }
      const sumLotes = somaMetragemLotesSelecionados(wizardLotesOpcoes, wizardLotesSel);
      if (q > sumLotes + 1e-9) {
        setToast({
          type: 'error',
          message: `Quantidade superior à soma disponível nos lotes selecionados (${formatMetrosLoteWizard(sumLotes)} m).`,
        });
        return;
      }
    }
    const lotesPendenteNorm = isLoteLinha
      ? [...new Set(wizardLotesSel.map((s) => String(s || '').trim()).filter(Boolean))]
      : [];
    setLinhaPendente({
      item_id: noPodeSerial ? metaAlinhado.item_id : row.item_id,
      codigo: row.codigo,
      descricao:
        noPodeSerial && metaAlinhado.descricao
          ? metaAlinhado.descricao
          : row.descricao,
      quantidade: q,
      tipocontrolo: noPodeSerial
        ? String(metaAlinhado.tipocontrolo || '')
        : String(row.tipocontrolo || '').trim(),
      serials: noPodeSerial || rowIsSerialPode ? [...wizardSerialsSel] : undefined,
      ...(isLoteLinha && lotesPendenteNorm.length > 0 ? { lotes: lotesPendenteNorm } : {}),
    });
    setCodigoArtigo('');
    setQtdDigitada('');
    setArtigoCorrente(null);
    setWizardStep(4);
    setToast({ type: 'success', message: 'Escolha a localização de destino.' });
  };

  const handleTransferir = async () => {
    if (!armazemId || !origemId || !destinoId || origemId === destinoId) {
      setToast({ type: 'error', message: 'Selecione origem e destino diferentes.' });
      return;
    }
    if (modoTransferencia === 'apeado' && !apeadoArmazemId) {
      setToast({ type: 'error', message: 'Selecione o armazém APEADO de destino.' });
      return;
    }
    if (!linhaPendente) {
      setToast({ type: 'error', message: 'Defina o artigo e a quantidade antes de confirmar.' });
      return;
    }
    const lp = linhaPendente;
    const qtdIntW = Math.floor(Number(lp.quantidade) || 0);
    const tipLp = String(lp.tipocontrolo || '').trim();
    const serialsLp = serialsListaLinhaPendente(lp);
    /** S/N: pelo tipo OU por já existirem seriais na linha (evita omitir payload se `tipocontrolo` vier vazio). */
    const isSnLp = isTipoControloSerial(tipLp) || serialsLp.length > 0;
    if (isSnLp && serialsLp.length !== qtdIntW) {
      setToast({
        type: 'error',
        message: `Selecione ${qtdIntW} serial(is) para ${lp.codigo} antes de finalizar.`,
      });
      return;
    }
    const lotesLp = Array.isArray(lp.lotes)
      ? [...new Set(lp.lotes.map((s) => String(s || '').trim()).filter(Boolean))]
      : [];
    const linhaEnvio = pode
      ? {
          item_id: lp.item_id,
          quantidade: lp.quantidade,
          ...(serialsLp.length > 0 ? { serials: serialsLp } : {}),
          ...(lotesLp.length > 0 ? { lotes: lotesLp } : {}),
        }
      : {
          item_codigo: lp.codigo,
          quantidade: lp.quantidade,
          ...(Number.isFinite(Number(lp.item_id)) && Number(lp.item_id) > 0
            ? { item_id: Number(lp.item_id) }
            : {}),
          ...(serialsLp.length > 0 ? { serials: serialsLp } : {}),
          ...(lotesLp.length > 0 ? { lotes: lotesLp } : {}),
        };
    setSubmitting(true);
    setToast(null);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `/api/armazens/${armazemId}/transferencia-localizacao`,
        {
          origem_localizacao_id: parseInt(origemId, 10),
          destino_localizacao_id: parseInt(destinoId, 10),
          modo_apeado: modoTransferencia === 'apeado',
          apeado_armazem_id: modoTransferencia === 'apeado' ? parseInt(apeadoArmazemId, 10) : undefined,
          linhas: [linhaEnvio],
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      setToast({
        type: 'success',
        message:
          modoTransferencia === 'apeado'
            ? 'Transferência para APEADOS concluída. Os tickets aparecem na fila abaixo.'
            : 'Transferência concluída. Os tickets aparecem na fila abaixo.',
      });
      setLinhaPendente(null);
      setDestinoId('');
      setCodigoArtigo('');
      setQtdDigitada('');
      setPesquisaArtigo('');
      setArtigoCorrente(null);
      setFiltroDestinoLoc('');
      setWizardStep(2);
      if (pode) {
        const { data } = await axios.get(`/api/armazens/${armazemId}/localizacoes/${origemId}/estoque`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setLinhasOrigem(Array.isArray(data) ? data : []);
      }
      loadTickets();
      window.dispatchEvent(new CustomEvent(RECEBIMENTO_REFRESH_EVENT));
    } catch (e) {
      const d = e.response?.data;
      setToast({
        type: 'error',
        message: d?.error || d?.message || 'Erro ao transferir stock.'
      });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleTicket = (id) => {
    setSelectedTicketIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selecionarTodosPendentes = () => {
    const pendentes = tickets.filter((t) => t.trfl_gerada_em == null).map((t) => t.id);
    setSelectedTicketIds(pendentes);
  };

  const totalTicketsPages = Math.max(1, Math.ceil(tickets.length / TICKETS_PAGE_SIZE));
  const ticketsPageClamped = Math.min(ticketsPage, totalTicketsPages);
  const ticketsPageStart = (ticketsPageClamped - 1) * TICKETS_PAGE_SIZE;
  const ticketsPaginaAtual = tickets.slice(ticketsPageStart, ticketsPageStart + TICKETS_PAGE_SIZE);

  const gerarTrfl = async () => {
    if (!podeExportarTrfl) {
      setToast({ type: 'error', message: `O seu perfil não pode gerar ${nomeDocumentoFila} desta fila.` });
      return;
    }
    if (!armazemId || selectedTicketIds.length === 0) {
      setToast({
        type: 'error',
        message:
          modoTransferencia === 'apeado'
            ? 'Selecione pelo menos um ticket para gerar/retransferir a TRA APEADO.'
            : 'Selecione pelo menos um ticket para gerar/retransferir a TRFL.',
      });
      return;
    }
    const selectedSet = new Set(selectedTicketIds.map((x) => Number(x)));
    const haviaPendenteSelecionado = tickets.some(
      (t) => selectedSet.has(Number(t.id)) && t.trfl_gerada_em == null
    );
    setExportingTrfl(true);
    setToast(null);
    try {
      const token = localStorage.getItem('token');
      const endpoint =
        modoTransferencia === 'apeado'
          ? `/api/armazens/${armazemId}/movimentacoes-internas/export-tra-apeado`
          : `/api/armazens/${armazemId}/movimentacoes-internas/export-trfl`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids: selectedTicketIds })
      });
      if (!res.ok) {
        let msg = modoTransferencia === 'apeado' ? 'Erro ao gerar TRA APEADO.' : 'Erro ao gerar TRFL.';
        try {
          const j = await res.json();
          msg = j.error || j.message || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const disp = res.headers.get('content-disposition') || '';
      let fn =
        modoTransferencia === 'apeado'
          ? `TRA_apeado_mov_interna_arm${armazemId}.xlsx`
          : `TRFL_mov_interna_arm${armazemId}.xlsx`;
      const m = /filename\*?=(?:UTF-8'')?["']?([^";\n]+)/i.exec(disp);
      if (m) fn = decodeURIComponent(m[1].replace(/["']/g, '').trim());
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fn;
      a.click();
      window.URL.revokeObjectURL(url);
      setToast({
        type: 'success',
        message: modoTransferencia === 'apeado' ? 'Ficheiro TRA APEADO transferido.' : 'Ficheiro TRFL transferido.',
      });
      if (haviaPendenteSelecionado) {
        window.dispatchEvent(new CustomEvent(RECEBIMENTO_REFRESH_EVENT));
      }
      setSelectedTicketIds([]);
      setTicketsPage(1);
      loadTickets();
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Erro ao exportar.' });
    } finally {
      setExportingTrfl(false);
    }
  };

  const excluirTicketsSelecionados = async () => {
    if (!armazemId || selectedTicketIds.length === 0) {
      setToast({ type: 'error', message: 'Selecione pelo menos um ticket para excluir.' });
      return;
    }
    const ok = window.confirm(
      `Confirma excluir ${selectedTicketIds.length} ticket(s) selecionado(s)?\n\n` +
      `Apenas tickets sem ${nomeDocumentoFila} gerada podem ser removidos.`
    );
    if (!ok) return;

    setDeletingTickets(true);
    setToast(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/armazens/${armazemId}/movimentacoes-internas`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: selectedTicketIds }),
      });
      if (!res.ok) {
        let msg = 'Erro ao excluir tickets.';
        try {
          const data = await res.json();
          msg = data?.error || data?.message || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const data = await res.json().catch(() => ({}));
      const deleted = Number(data?.deleted || 0);
      const skipped = Number(data?.skipped || 0);
      if (skipped > 0) {
        setToast({
          type: 'warning',
          message: `${deleted} ticket(s) excluído(s). ${skipped} não foram removidos (${nomeDocumentoFila} já gerada).`,
        });
      } else {
        setToast({ type: 'success', message: `${deleted} ticket(s) excluído(s) com sucesso.` });
      }
      setSelectedTicketIds([]);
      loadTickets();
      window.dispatchEvent(new CustomEvent(RECEBIMENTO_REFRESH_EVENT));
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao excluir tickets.' });
    } finally {
      setDeletingTickets(false);
    }
  };

  const gerarTicketsLoteRecebimento = async () => {
    if (!loteRecebimento.length) return;
    if (!armazemId || !origemId) {
      setToast({ type: 'error', message: 'Defina armazém e localização de origem para continuar.' });
      return;
    }
    if (modoTransferencia === 'apeado' && !apeadoArmazemId) {
      setToast({ type: 'error', message: 'Selecione o armazém APEADO de destino.' });
      return;
    }

    const linhasAtivas = (loteRecebimento || []).filter((it) => {
      const codigo = String(it?.codigo || '').trim();
      const qtd = Number(it?.quantidade || 0) || 0;
      return Boolean(codigo) && qtd > 0;
    });
    if (!linhasAtivas.length) {
      setToast({ type: 'error', message: 'Não existem linhas válidas para gerar tickets.' });
      return;
    }

    const semDestino = linhasAtivas.find((it) => !it.destinoId || String(it.destinoId) === String(origemId));
    if (semDestino) {
      setToast({
        type: 'error',
        message: `Defina um destino válido para ${semDestino.codigo}.`,
      });
      return;
    }

    const resumoGrupo = new Map();
    for (const it of linhasAtivas) {
      const particao = normalizarParticaoPrefill(it?.particao, modoTransferencia);
      const key = String(it?.grupo_key || `${Number(it?.item_id || 0) || 0}::${String(it?.codigo || '').trim().toUpperCase()}::${particao}`);
      const prev = resumoGrupo.get(key) || {
        codigo: String(it?.codigo || '').trim(),
        particao,
        total: Number(it?.quantidade_total_item || 0) || 0,
        soma: 0,
      };
      prev.soma += Number(it?.quantidade || 0) || 0;
      if ((Number(it?.quantidade_total_item || 0) || 0) > prev.total) prev.total = Number(it?.quantidade_total_item || 0) || 0;
      resumoGrupo.set(key, prev);
    }
    const grupoInvalido = [...resumoGrupo.values()].find((g) => g.total > 0 && g.soma !== g.total);
    if (grupoInvalido) {
      setToast({
        type: 'error',
        message: `Alocação incompleta para ${grupoInvalido.codigo} (${grupoInvalido.particao}): ${grupoInvalido.soma}/${grupoInvalido.total}.`,
      });
      return;
    }

    setSubmittingLote(true);
    try {
      const token = localStorage.getItem('token');
      let criados = 0;
      const serialSeenByGrupo = new Map();
      const loteSeenByGrupo = new Map();
      for (const it of linhasAtivas) {
        const quantidade = Number(it.quantidade || 0) || 0;
        if (quantidade <= 0) continue;
        const codigo = String(it.codigo || '').trim();
        if (!codigo) continue;
        const particao = normalizarParticaoPrefill(it?.particao, modoTransferencia);
        const keyGrupo = String(it?.grupo_key || `${Number(it?.item_id || 0) || 0}::${codigo.toUpperCase()}::${particao}`);

        const rowStock = resolveRowStockPrefill(linhasOrigem, it);
        if (pode && !rowStock) {
          throw new Error(`Artigo ${codigo} não encontrado no stock da origem.`);
        }
        if (pode) {
          const disponivel = Number(rowStock?.quantidade || 0) || 0;
          if (quantidade > disponivel) {
            throw new Error(`Quantidade de ${codigo} superior ao disponível (${disponivel}).`);
          }
        }

        const tipocontroloItem = String(rowStock?.tipocontrolo || it?.tipocontrolo || '').trim();
        const serialsSelecionadosLinha = Array.isArray(it?.serials)
          ? [...new Set(it.serials.map((s) => String(s || '').trim()).filter(Boolean))]
          : [];
        const seriaisSugeridosLinha = Array.isArray(it?.seriais_sugeridos)
          ? [...new Set(it.seriais_sugeridos.map((s) => String(s || '').trim()).filter(Boolean))]
          : [];
        const lotesSelecionadosLinha = Array.isArray(it?.lotes)
          ? [...new Set(it.lotes.map((s) => String(s || '').trim()).filter(Boolean))]
          : [];
        const isSerialItem = isTipoControloSerial(tipocontroloItem)
          || serialsSelecionadosLinha.length > 0
          || seriaisSugeridosLinha.length > 0;
        const isLoteItem = String(tipocontroloItem || '').trim().toUpperCase() === 'LOTE';

        const itemIdPref = Number(it?.item_id || 0);
        const linhaPayload = pode
          ? {
              item_id: rowStock.item_id,
              quantidade,
              serials: isSerialItem
                ? serialsSelecionadosLinha
                : undefined,
              lotes: isLoteItem ? lotesSelecionadosLinha : undefined,
            }
          : {
              item_codigo: codigo,
              quantidade,
              ...(Number.isFinite(itemIdPref) && itemIdPref > 0 ? { item_id: itemIdPref } : {}),
              ...(isSerialItem ? { serials: serialsSelecionadosLinha } : {}),
              ...(isLoteItem ? { lotes: lotesSelecionadosLinha } : {}),
            };
        if (isSerialItem) {
          const qtdInt = Math.floor(quantidade);
          const serialsSel = serialsSelecionadosLinha;
          if (serialsSel.length !== qtdInt) {
            throw new Error(`Selecione ${qtdInt} serial(s) para ${codigo}.`);
          }
          const seen = serialSeenByGrupo.get(keyGrupo) || new Set();
          for (const sn of serialsSel) {
            const snKey = String(sn || '').trim().toUpperCase();
            if (!snKey) continue;
            if (seen.has(snKey)) {
              throw new Error(`Serial ${sn} duplicado em múltiplas alocações de ${codigo} (${particao}).`);
            }
            seen.add(snKey);
          }
          serialSeenByGrupo.set(keyGrupo, seen);
        }
        if (String(rowStock?.tipocontrolo || it?.tipocontrolo || '').trim().toUpperCase() === 'LOTE') {
          const lotesSel = Array.isArray(it?.lotes)
            ? [...new Set(it.lotes.map((s) => String(s || '').trim()).filter(Boolean))]
            : [];
          const seenL = loteSeenByGrupo.get(keyGrupo) || new Set();
          for (const lote of lotesSel) {
            const k = String(lote || '').trim().toUpperCase();
            if (!k) continue;
            if (seenL.has(k)) {
              throw new Error(`Lote ${lote} duplicado em múltiplas alocações de ${codigo} (${particao}).`);
            }
            seenL.add(k);
          }
          loteSeenByGrupo.set(keyGrupo, seenL);
        }

        await axios.post(
          `/api/armazens/${armazemId}/transferencia-localizacao`,
          {
            origem_localizacao_id: parseInt(origemId, 10),
            destino_localizacao_id: parseInt(it.destinoId, 10),
            modo_apeado: modoTransferencia === 'apeado' || particao === 'apeado',
            apeado_armazem_id: (modoTransferencia === 'apeado' || particao === 'apeado')
              ? parseInt(apeadoArmazemId, 10)
              : undefined,
            linhas: [linhaPayload],
          },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        criados += 1;
      }

      setToast({
        type: 'success',
        message:
          modoTransferencia === 'apeado'
            ? `${criados} ticket(s) criado(s) com sucesso para APEADOS.`
            : `${criados} ticket(s) criado(s) com sucesso para armazenagem.`,
      });
      limparPrefillRecebimento();
      loadTickets();
      window.dispatchEvent(new CustomEvent(RECEBIMENTO_REFRESH_EVENT));
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Erro ao gerar tickets em lote.';
      setToast({ type: 'error', message: msg });
    } finally {
      setSubmittingLote(false);
    }
  };

  const removerLinhaLoteRecebimento = (idx) => {
    setLoteRecebimento((prev) => prev.filter((_, i) => i !== idx));
  };

  const adicionarLinhaLoteRecebimento = () => {
    const particao = modoTransferencia === 'apeado' ? 'apeado' : 'normal';
    setLoteRecebimento((prev) => ([
      ...prev,
      {
        manual: true,
        item_id: null,
        codigo: '',
        descricao: '',
        tipocontrolo: '',
        seriais_sugeridos: [],
        lotes_sugeridos: [],
        quantidade: 1,
        quantidade_total_item: 0,
        particao,
        grupo_key: `manual::${Date.now()}::${particao}`,
        allocation_id: `manual-${Date.now()}`,
        destinoId: '',
        serials: [],
        lotes: [],
      },
    ]));
  };

  const atualizarArtigoLinhaLote = (idx, optionValue) => {
    const key = String(optionValue || '').trim();
    if (!key) return;
    let selecionado = null;
    if (key.startsWith('ID:')) {
      const itemId = Number(key.slice(3) || 0);
      const rowStock = (linhasOrigem || []).find((r) => Number(r?.item_id || 0) === itemId);
      if (rowStock) {
        selecionado = {
          item_id: Number(rowStock?.item_id || 0) || null,
          codigo: String(rowStock?.codigo || '').trim(),
          descricao: String(rowStock?.descricao || '').trim(),
          tipocontrolo: String(rowStock?.tipocontrolo || '').trim(),
        };
      }
    }
    if (!selecionado) {
      const fallback = opcoesArtigoLoteManual.find((o) => String(o?.value || '') === key);
      if (fallback) {
        selecionado = {
          item_id: Number(fallback?.item_id || 0) || null,
          codigo: String(fallback?.codigo || '').trim(),
          descricao: String(fallback?.descricao || '').trim(),
          tipocontrolo: String(fallback?.tipocontrolo || '').trim(),
        };
      }
    }
    if (!selecionado || !selecionado.codigo) return;
    setLoteRecebimento((prev) =>
      prev.map((row, i) => (
        i === idx
          ? (() => {
            const particao = normalizarParticaoPrefill(row?.particao, modoTransferencia);
            const grupoKey = `${Number(selecionado?.item_id || 0) || 0}::${String(selecionado?.codigo || '').trim().toUpperCase()}::${particao}`;
            const seriaisGrupo = prev
              .filter((x, j) => j !== idx && makeGrupoKey({ ...x, grupo_key: grupoKey }, modoTransferencia) === grupoKey)
              .flatMap((x) => Array.isArray(x?.seriais_sugeridos) ? x.seriais_sugeridos : [])
              .map((s) => String(s || '').trim())
              .filter(Boolean);
            return {
              ...row,
              manual: true,
              item_id: selecionado.item_id,
              codigo: selecionado.codigo,
              descricao: selecionado.descricao,
              tipocontrolo: selecionado.tipocontrolo,
              seriais_sugeridos: [...new Set(seriaisGrupo)],
              lotes_sugeridos: [],
              serials: [],
              lotes: [],
              particao,
              grupo_key: grupoKey,
              quantidade_total_item: Number(row?.quantidade_total_item || 0) || 0,
            };
          })()
          : row
      ))
    );
  };

  const atualizarQuantidadeLinhaLote = (idx, valor) => {
    const qtd = Math.max(0, Math.floor(Number(valor) || 0));
    setLoteRecebimento((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const serials = Array.isArray(row?.serials) ? row.serials.slice(0, qtd) : [];
        return { ...row, quantidade: qtd, serials };
      })
    );
  };

  const toggleSerialLinhaLote = (idx, serial, maxQtd) => {
    const sn = String(serial || '').trim();
    if (!sn) return;
    const limite = Math.max(0, Math.floor(Number(maxQtd) || 0));
    setLoteRecebimento((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const atual = Array.isArray(row?.serials) ? [...new Set(row.serials.map((s) => String(s || '').trim()).filter(Boolean))] : [];
        const existe = atual.includes(sn);
        if (existe) {
          return { ...row, serials: atual.filter((s) => s !== sn) };
        }
        if (atual.length >= limite) return row;
        return { ...row, serials: [...atual, sn] };
      })
    );
  };

  const disponivelArtigoCorrente = useMemo(() => {
    if (!artigoCorrente) return 0;
    return Number(artigoCorrente.quantidade) || 0;
  }, [artigoCorrente]);

  const voltarUmPasso = () => {
    if (wizardStep === 5) setWizardStep(4);
    else if (wizardStep === 4) {
      const lp = linhaPendente;
      if (lp) {
        const row = linhasOrigem.find((r) => r.item_id === lp.item_id);
        if (row) setArtigoCorrente(row);
        setQtdDigitada(String(lp.quantidade));
      }
      setWizardStep(3);
    } else if (wizardStep === 3) {
      setArtigoCorrente(null);
      setQtdDigitada('');
      setWizardLotesSel([]);
      setLinhaPendente(null);
      setWizardStep(2);
    } else if (wizardStep === 2) setWizardStep(1);
  };

  if (!podeCriarTickets) {
    return null;
  }

  if (loadingArmazens) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto" />
          <p className="mt-4 text-gray-600">A carregar…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ui-page sm:p-6 lg:p-8">
      <div className="ui-shell max-w-5xl">
        <div className="mb-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 flex items-center gap-2">
              <FaExchangeAlt className="text-[#0915FF]" />
              {modoTransferencia === 'apeado' ? 'Transferência para APEADOS' : 'Transferência de localização'}
            </h1>
            <p className="text-xs text-gray-500 mt-1">
              Um artigo por movimentação: origem → artigo → quantidade → destino → confirmar.
            </p>
          </div>
          <p className="text-sm shrink-0">
            <Link to="/transferencias" className="text-[#0915FF] hover:underline">
              Transferências
            </Link>
            <span className="text-gray-400 mx-1">·</span>
            <Link to="/consulta-estoque-localizacoes" className="text-[#0915FF] hover:underline">
              Stock
            </Link>
          </p>
        </div>

        {centrais.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-600">
            <FaWarehouse className="mx-auto text-4xl text-gray-300 mb-3" />
            <p>Não há armazéns centrais disponíveis para o seu utilizador.</p>
          </div>
        ) : (
          <div className="space-y-6 max-w-3xl mx-auto">
            <div className="ui-card p-4">
              <label className="block text-xs text-gray-600 mb-1">Tipo de transferência</label>
              <select
                value={modoTransferencia}
                onChange={(e) => setModoTransferencia(String(e.target.value || 'localizacao'))}
                className="ui-select"
              >
                <option value="localizacao">Transferência de localização</option>
                <option value="apeado">Transferência para APEADOS</option>
              </select>
            </div>
            {loteRecebimento.length > 0 && (
              <div className="ui-card overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 bg-indigo-50/60">
                  <h2 className="text-sm font-semibold text-indigo-900">Armazenagem rápida (Recebimento)</h2>
                  <p className="text-xs text-indigo-800/80 mt-1">
                    Origem e itens pré-preenchidos. Defina o destino de cada item e gere os tickets.
                  </p>
                </div>
                <div className="p-4 sm:p-5 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Armazém central</label>
                      <select
                        value={armazemId}
                        onChange={(e) => setArmazemId(e.target.value)}
                        className="ui-select"
                        disabled={armazemUnico}
                      >
                        <option value="">Selecione…</option>
                        {centrais.map((a) => (
                          <option key={a.id} value={String(a.id)}>
                            {a.codigo} — {a.descricao}
                          </option>
                        ))}
                      </select>
                    </div>
                    {modoTransferencia === 'apeado' && (
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Armazém APEADO</label>
                        <select
                          value={apeadoArmazemId}
                          onChange={(e) => setApeadoArmazemId(e.target.value)}
                          className="ui-select"
                        >
                          <option value="">Selecione…</option>
                          {apeadosVinculados.map((a) => (
                            <option key={a.id} value={String(a.id)}>
                              {a.codigo} — {a.descricao}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Origem (recebimento)</label>
                      <input
                        value={labelLoc(origemId) || loteOrigemLabel || ''}
                        readOnly
                        className="ui-input bg-gray-50 text-sm font-mono"
                      />
                    </div>
                  </div>

                  <div className="ui-table-wrap overflow-x-auto">
                    <table className="ui-table w-full text-xs table-auto">
                      <thead>
                        <tr>
                          <th className="px-2 py-2 text-left">Artigo</th>
                          <th className="px-2 py-2 text-right">Qtd</th>
                          <th className="px-2 py-2 text-left">Destino</th>
                          <th className="px-2 py-2 text-left">Seriais</th>
                          <th className="px-2 py-2 text-right">Ação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loteRecebimento.map((it, idx) => (
                          <tr key={`${it.codigo}-${idx}`}>
                            <td className="px-2 py-2 align-top">
                              {(() => {
                                const particao = normalizarParticaoPrefill(it?.particao, modoTransferencia);
                                const keyGrupo = String(it?.grupo_key || `${Number(it?.item_id || 0) || 0}::${String(it?.codigo || '').trim().toUpperCase()}::${particao}`);
                                const resumo = resumoGrupoAlloc.get(keyGrupo) || { alocado: Number(it?.quantidade || 0) || 0, total: Number(it?.quantidade_total_item || 0) || 0 };
                                const particaoLabel = particao === 'apeado' ? 'APEADO' : 'NORMAL';
                                return (
                                  <div className="mb-1 flex items-center gap-2 text-[10px]">
                                    <span className={`px-1.5 py-0.5 rounded border ${particao === 'apeado' ? 'border-purple-300 text-purple-800 bg-purple-50' : 'border-indigo-300 text-indigo-800 bg-indigo-50'}`}>
                                      {particaoLabel}
                                    </span>
                                    {resumo.total > 0 && (
                                      <span className="text-gray-500">
                                        Alocado {resumo.alocado}/{resumo.total}
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                              {Boolean(it?.manual) ? (
                                <select
                                  value={
                                    Number(it?.item_id || 0) > 0
                                      ? `ID:${Number(it.item_id)}`
                                      : ''
                                  }
                                  onChange={(e) => atualizarArtigoLinhaLote(idx, e.target.value)}
                                  className="ui-select"
                                >
                                  <option value="">Selecione artigo…</option>
                                  {opcoesArtigoLoteManual.map((r) => (
                                    <option key={String(r.value)} value={String(r.value)}>
                                      {String(r.codigo || '').trim()} — {String(r.descricao || '').trim()}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <div className="min-w-0">
                                  <span className="font-mono font-medium block break-all">{it.codigo}</span>
                                  {it.descricao ? (
                                    <span className="block text-[11px] text-gray-500 whitespace-normal break-words leading-snug">
                                      {it.descricao}
                                    </span>
                                  ) : null}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums align-top">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={it.quantidade}
                                onChange={(e) => atualizarQuantidadeLinhaLote(idx, e.target.value)}
                                className="w-24 px-2 py-1 border border-gray-300 rounded text-right"
                              />
                            </td>
                            <td className="px-2 py-2 align-top">
                              <select
                                value={it.destinoId}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setLoteRecebimento((prev) =>
                                    prev.map((row, i) => (i === idx ? { ...row, destinoId: next } : row))
                                  );
                                }}
                                className="ui-select min-w-[130px]"
                              >
                                <option value="">Selecione destino…</option>
                                {locsDestinoCandidatas.map((l) => (
                                  <option key={l.id} value={String(l.id)}>
                                    {l.localizacao}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-2 align-top min-w-[170px]">
                              {(() => {
                                const rowStock = resolveRowStockPrefill(linhasOrigem, it);
                                const tipocontroloItem = String(rowStock?.tipocontrolo || it?.tipocontrolo || '').trim();
                                if (!isTipoControloSerial(tipocontroloItem)) {
                                  return <span className="text-[11px] text-gray-400">—</span>;
                                }
                                const itemId = String(Number(rowStock?.item_id || it?.item_id || 0));
                                const optionsStock = Array.isArray(serialOptionsByItemId[itemId]) ? serialOptionsByItemId[itemId] : [];
                                const optionsFallback = (it?.seriais_sugeridos || []).map((sn, pos) => ({
                                  id: `fallback-${itemId}-${pos}`,
                                  serialnumber: String(sn || '').trim(),
                                }));
                                const grupoKey = makeGrupoKey(it, modoTransferencia);
                                const seriaisGrupo = (loteRecebimento || [])
                                  .filter((x) => makeGrupoKey(x, modoTransferencia) === grupoKey)
                                  .flatMap((x) => Array.isArray(x?.seriais_sugeridos) ? x.seriais_sugeridos : [])
                                  .map((s) => String(s || '').trim())
                                  .filter(Boolean);
                                const optionsGrupo = [...new Set(seriaisGrupo)].map((sn, pos) => ({
                                  id: `group-${itemId}-${pos}`,
                                  serialnumber: sn,
                                }));
                                const optionsBase = optionsStock.length > 0 ? optionsStock : (optionsGrupo.length > 0 ? optionsGrupo : optionsFallback);
                                const qtdInt = Math.floor(Number(it?.quantidade || 0) || 0);
                                const selected = Array.isArray(it?.serials) ? it.serials : [];
                                const selectedEmOutrasLinhas = new Set(
                                  (loteRecebimento || [])
                                    .filter((x, i) => i !== idx && makeGrupoKey(x, modoTransferencia) === grupoKey)
                                    .flatMap((x) => Array.isArray(x?.serials) ? x.serials : [])
                                    .map((s) => String(s || '').trim().toUpperCase())
                                    .filter(Boolean)
                                );
                                const options = optionsBase.filter((o) => {
                                  const sn = String(o?.serialnumber || '').trim();
                                  if (!sn) return false;
                                  if (selected.includes(sn)) return true;
                                  return !selectedEmOutrasLinhas.has(sn.toUpperCase());
                                });
                                return (
                                  <div className="space-y-1 min-w-0">
                                    <button
                                      type="button"
                                      className="px-2 py-1 text-[11px] border border-gray-300 rounded hover:bg-gray-50"
                                      onClick={() => setSerialPickerIdx(idx)}
                                      disabled={qtdInt <= 0}
                                    >
                                      Selecionar seriais
                                    </button>
                                    <div className="text-[11px] text-gray-500 whitespace-normal break-words">
                                      {selected.length}/{qtdInt} selecionados · {options.length} disponíveis
                                    </div>
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-2 py-2 text-right whitespace-nowrap align-top w-[1%]">
                              <button
                                type="button"
                                className="px-2 py-1 text-xs border border-red-300 text-red-700 rounded hover:bg-red-50"
                                onClick={() => removerLinhaLoteRecebimento(idx)}
                                disabled={submittingLote}
                                title="Excluir esta linha do pré-preenchimento automático"
                              >
                                Excluir
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 justify-end">
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary"
                      onClick={adicionarLinhaLoteRecebimento}
                      disabled={submittingLote}
                    >
                      Adicionar item
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary"
                      onClick={limparPrefillRecebimento}
                      disabled={submittingLote}
                    >
                      Cancelar pré-preenchimento
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary disabled:opacity-50"
                      onClick={gerarTicketsLoteRecebimento}
                      disabled={
                        submittingLote ||
                        !armazemId ||
                        !origemId ||
                        locsDestinoCandidatas.length === 0 ||
                        (modoTransferencia === 'apeado' && !apeadoArmazemId)
                      }
                    >
                      {submittingLote
                        ? 'A criar tickets…'
                        : modoTransferencia === 'apeado'
                          ? 'Gerar tickets para APEADOS'
                          : 'Gerar tickets de armazenagem'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {serialPickerIdx != null && loteRecebimento[serialPickerIdx] && (() => {
              const it = loteRecebimento[serialPickerIdx];
              const rowStock = resolveRowStockPrefill(linhasOrigem, it);
              const itemId = String(Number(rowStock?.item_id || it?.item_id || 0));
              const optionsStock = Array.isArray(serialOptionsByItemId[itemId]) ? serialOptionsByItemId[itemId] : [];
              const optionsFallback = (it?.seriais_sugeridos || []).map((sn, pos) => ({
                id: `fallback-${itemId}-${pos}`,
                serialnumber: String(sn || '').trim(),
              }));
              const grupoKey = makeGrupoKey(it, modoTransferencia);
              const seriaisGrupo = (loteRecebimento || [])
                .filter((x) => makeGrupoKey(x, modoTransferencia) === grupoKey)
                .flatMap((x) => Array.isArray(x?.seriais_sugeridos) ? x.seriais_sugeridos : [])
                .map((s) => String(s || '').trim())
                .filter(Boolean);
              const optionsGrupo = [...new Set(seriaisGrupo)].map((sn, pos) => ({
                id: `group-${itemId}-${pos}`,
                serialnumber: sn,
              }));
              const optionsBase = optionsStock.length > 0 ? optionsStock : (optionsGrupo.length > 0 ? optionsGrupo : optionsFallback);
              const qtdInt = Math.floor(Number(it?.quantidade || 0) || 0);
              const selected = Array.isArray(it?.serials) ? it.serials : [];
              const selectedEmOutrasLinhas = new Set(
                (loteRecebimento || [])
                  .filter((x, i) => i !== serialPickerIdx && makeGrupoKey(x, modoTransferencia) === grupoKey)
                  .flatMap((x) => Array.isArray(x?.serials) ? x.serials : [])
                  .map((s) => String(s || '').trim().toUpperCase())
                  .filter(Boolean)
              );
              const options = optionsBase.filter((o) => {
                const sn = String(o?.serialnumber || '').trim();
                if (!sn) return false;
                if (selected.includes(sn)) return true;
                return !selectedEmOutrasLinhas.has(sn.toUpperCase());
              });
              return (
                <div className="fixed inset-0 z-[1200] bg-black/25 flex items-center justify-center p-4">
                  <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-2xl">
                    <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-gray-800">Selecionar seriais</p>
                        <p className="text-[11px] text-gray-500 font-mono">{String(it?.codigo || '')}</p>
                      </div>
                      <button
                        type="button"
                        className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                        onClick={() => setSerialPickerIdx(null)}
                      >
                        Fechar
                      </button>
                    </div>
                    <div className="px-4 py-3">
                      <p className="text-xs text-gray-600 mb-2">{selected.length}/{qtdInt} selecionados</p>
                      <div className="max-h-72 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
                        {options.map((o) => {
                          const sn = String(o.serialnumber || '').trim();
                          const checked = selected.includes(sn);
                          const disableUnchecked = !checked && selected.length >= qtdInt;
                          return (
                            <label key={String(o.id)} className="flex items-center gap-2 text-xs text-gray-700">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={disableUnchecked}
                                onChange={() => toggleSerialLinhaLote(serialPickerIdx, sn, qtdInt)}
                              />
                              <span className="font-mono">{sn}</span>
                            </label>
                          );
                        })}
                        {options.length === 0 && (
                          <p className="text-xs text-gray-400">Sem seriais disponíveis para este item.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="ui-card overflow-visible">
              <div className="px-3 sm:px-4 py-3 border-b border-gray-100 bg-gray-50/90">
                {loteRecebimento.length > 0 && (
                  <div className="mb-2 rounded border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-[11px] text-indigo-800">
                    Pre-preenchimento ativo. Pode adicionar artigos manualmente abaixo.
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
                  {WIZARD_STEPS.map((st, idx) => {
                    const ativo = wizardStep === st.n;
                    const feito = wizardStep > st.n;
                    return (
                      <React.Fragment key={st.n}>
                        {idx > 0 && <span className="text-gray-300 text-xs shrink-0">→</span>}
                        <div
                          className={`flex flex-col items-center min-w-[52px] shrink-0 ${
                            ativo ? 'text-[#0915FF]' : feito ? 'text-emerald-600' : 'text-gray-400'
                          }`}
                        >
                          <span
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                              ativo
                                ? 'border-[#0915FF] bg-[#0915FF] text-white'
                                : feito
                                  ? 'border-emerald-500 bg-emerald-500 text-white'
                                  : 'border-gray-300 bg-white'
                            }`}
                          >
                            {feito ? '✓' : st.n}
                          </span>
                          <span className="text-[10px] font-medium mt-0.5 text-center leading-tight">{st.label}</span>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              <div className="p-4 sm:p-5">
                {wizardStep === 1 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-gray-800">Onde está o stock a retirar?</p>
                    {!armazemUnico && (
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Armazém central</label>
                        <select
                          value={armazemId}
                          onChange={(e) => setArmazemId(e.target.value)}
                          className="ui-select"
                        >
                          <option value="">Selecione…</option>
                          {centrais.map((a) => (
                            <option key={a.id} value={String(a.id)}>
                              {a.codigo} — {a.descricao}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {modoTransferencia === 'apeado' && (
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Armazém APEADO</label>
                        <select
                          value={apeadoArmazemId}
                          onChange={(e) => setApeadoArmazemId(e.target.value)}
                          className="ui-select"
                        >
                          <option value="">Selecione…</option>
                          {apeadosVinculados.map((a) => (
                            <option key={a.id} value={String(a.id)}>
                              {a.codigo} — {a.descricao}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {armazemUnico && (
                      <p className="text-sm text-gray-700">
                        <FaWarehouse className="inline mr-1 text-[#0915FF]" />
                        <span className="font-semibold">{armazemExibicao?.codigo}</span>
                        {armazemExibicao?.descricao ? ` — ${armazemExibicao.descricao}` : ''}
                      </p>
                    )}
                    <div>
                      <label className="block text-xs text-gray-600 mb-1" htmlFor="transf-loc-origem-input">
                        <FaMapMarkerAlt className="inline mr-1 text-amber-600" />
                        Localização de origem
                      </label>
                      <LocalizacaoCombobox
                        instanceId="transf-loc-origem"
                        inputId="transf-loc-origem-input"
                        selectedId={origemId}
                        options={locsComIdFiltradasOrigem}
                        inputValue={filtroOrigemLoc}
                        onInputChange={handleOrigemComboboxInput}
                        onSelect={(l) => {
                          setOrigemId(String(l.id));
                          setFiltroOrigemLoc(l.localizacao || '');
                        }}
                        onBlurCommitExact={commitOrigemSeCorrespondenciaExata}
                        disabled={!armazemId || locsComId.length === 0}
                        lerDisabled={!armazemId || locsComId.length === 0}
                        onLerClick={() => abrirLeitorQr('origem')}
                        placeholder="Pesquisar ou escolher localização de origem…"
                        lerTitle="Ler QR ou código de barras da localização"
                        lerAriaLabel="Ler QR ou código de barras da localização de origem"
                        emptyListMessage={
                          armazemId && locsComId.length === 0
                            ? 'Não há localizações com identificador neste armazém.'
                            : null
                        }
                        filterNoMatchMessage="Nenhuma localização corresponde ao texto."
                      />
                    </div>
                    {pode && origemId && !loadingEstoque && linhasOrigem.length === 0 && (
                      <p className="text-xs text-amber-800">Sem stock nesta localização.</p>
                    )}
                    {pode && origemId && !loadingEstoque && linhasOrigem.length > 0 && (
                      <p className="text-xs text-gray-500">
                        {linhasOrigem.length} artigo(s) nesta origem — avance para escolher o artigo.
                      </p>
                    )}
                    {!pode && origemId && (
                      <p className="text-xs text-gray-500">
                        Modo sem controlo de stock ativo: indique artigo e quantidade manualmente para criar ticket.
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={
                        !armazemId ||
                        !origemId ||
                        (modoTransferencia === 'apeado' && !apeadoArmazemId) ||
                        (pode && (loadingEstoque || linhasOrigem.length === 0))
                      }
                      onClick={() => setWizardStep(2)}
                      className="ui-btn ui-btn-primary w-full disabled:opacity-50"
                    >
                      Continuar
                    </button>
                  </div>
                )}

                {wizardStep === 2 && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800">Qual artigo?</p>
                      <button type="button" onClick={voltarUmPasso} className="text-xs text-gray-600 hover:underline">
                        ← Voltar
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 font-mono bg-gray-50 rounded px-2 py-1">{labelLoc(origemId)}</p>
                    {pode && (
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">
                          <FaSearch className="inline mr-1" />
                          Pesquisar (código ou descrição)
                        </label>
                        <PesquisaComLeitorQr
                          inputType="search"
                          value={pesquisaArtigo}
                          onChange={(e) => setPesquisaArtigo(e.target.value)}
                          disabled={loadingEstoque || linhasOrigem.length === 0}
                          lerDisabled={loadingEstoque || linhasOrigem.length === 0}
                          placeholder="Comece a escrever…"
                          onLerClick={() => abrirLeitorQr('pesquisaArtigo')}
                          lerTitle="Ler QR ou código de barras do artigo"
                          lerAriaLabel="Ler QR ou código de barras do artigo"
                        />
                        {normBusca(pesquisaArtigo).length > 0 && (
                          <div className="mt-2 rounded-lg border border-gray-200 max-h-[min(220px,38vh)] overflow-y-auto">
                            {artigosFiltradosPesquisa.length === 0 ? (
                              <p className="px-3 py-4 text-xs text-gray-500 text-center">Sem resultados.</p>
                            ) : (
                              <ul className="divide-y divide-gray-100">
                                {artigosFiltradosPesquisa.map((row) => {
                                  const max = Number(row.quantidade) || 0;
                                  return (
                                    <li key={row.item_id}>
                                      <button
                                        type="button"
                                        onClick={() => selecionarArtigoDaPesquisa(row)}
                                        className="w-full text-left px-3 py-2 text-sm hover:bg-[#0915FF]/5"
                                      >
                                        <span className="font-mono font-medium">{row.codigo}</span>
                                        <span className="text-gray-700 block text-xs line-clamp-2">{row.descricao}</span>
                                        <span className="text-[11px] text-gray-500">Disponível: {max}</span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            {pesquisaResultadosTruncados && (
                              <p className="px-2 py-1.5 text-[10px] text-amber-800 bg-amber-50">Refine a pesquisa (máx. {MAX_SUGESTOES} linhas).</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2 items-stretch" ref={refCodigoArtigoWrap}>
                        <div className="flex-1 min-w-0 relative">
                          <PesquisaComLeitorQr
                            showSearchIcon={false}
                            fontMono
                            value={codigoArtigo}
                            onChange={(e) => {
                              const next = e.target.value;
                              setCodigoArtigo(next);
                              setArtigoCorrente(null);
                              setSelectedCodigoIndex(0);
                              setMostrarListaCodigoArtigo(normBusca(extrairCodigoArtigo(next)).length > 0);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'ArrowDown') {
                                if (mostrarListaCodigoArtigo && sugestoesCodigoArtigo.length > 0) {
                                  e.preventDefault();
                                  setSelectedCodigoIndex((idx) =>
                                    idx < sugestoesCodigoArtigo.length - 1 ? idx + 1 : idx
                                  );
                                }
                              } else if (e.key === 'ArrowUp') {
                                if (mostrarListaCodigoArtigo && sugestoesCodigoArtigo.length > 0) {
                                  e.preventDefault();
                                  setSelectedCodigoIndex((idx) => (idx > 0 ? idx - 1 : 0));
                                }
                              } else if (e.key === 'Enter') {
                                e.preventDefault();
                                if (mostrarListaCodigoArtigo && sugestoesCodigoArtigo.length > 0) {
                                  const idx = selectedCodigoIndex >= 0 ? selectedCodigoIndex : 0;
                                  selecionarSugestaoCodigo(sugestoesCodigoArtigo[idx]);
                                } else {
                                  validarCodigoManualParaPasso3();
                                }
                              } else if (e.key === 'Escape') {
                                setMostrarListaCodigoArtigo(false);
                              }
                            }}
                            placeholder="Ou código manual"
                            onLerClick={() => abrirLeitorQr('codigoArtigo')}
                            disabled={loadingEstoque}
                            lerDisabled={loadingEstoque}
                            lerTitle="Ler QR ou código de barras do artigo"
                            lerAriaLabel="Ler QR ou código de barras do código do artigo"
                            id="transf-codigo-artigo-input"
                            onFocus={() => {
                              if (normBusca(extrairCodigoArtigo(codigoArtigo)).length > 0) {
                                setMostrarListaCodigoArtigo(true);
                              }
                            }}
                          />
                          {mostrarListaCodigoArtigo && (
                            <div
                              ref={refListaCodigoArtigo}
                              className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto"
                            >
                              {sugestoesCodigoLoading ? (
                                <div className="px-3 py-2 text-sm text-gray-500">A pesquisar…</div>
                              ) : sugestoesCodigoArtigo.length === 0 ? (
                                <div className="px-3 py-2 text-sm text-gray-500">Nenhum item encontrado</div>
                              ) : (
                                <ul className="divide-y divide-gray-100">
                                  {sugestoesCodigoArtigo.map((s, idx) => (
                                    <li key={s.codigo}>
                                      <button
                                        type="button"
                                        data-sugestao-index={idx}
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          selecionarSugestaoCodigo(s);
                                        }}
                                        className={`w-full text-left px-3 py-2 text-sm ${
                                          idx === selectedCodigoIndex
                                            ? 'bg-[#0915FF]/15 text-[#0915FF]'
                                            : 'hover:bg-gray-100'
                                        }`}
                                      >
                                        <span className="font-mono font-medium">{s.codigo}</span>
                                        {s.descricao ? (
                                          <span className="block text-xs text-gray-500 truncate">{s.descricao}</span>
                                        ) : null}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={validarCodigoManualParaPasso3}
                          className="ui-btn ui-btn-secondary px-3 py-2 shrink-0 self-stretch"
                        >
                          OK
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {wizardStep === 3 && (artigoCorrente || !pode) && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800">Quantidade a transferir</p>
                      <button type="button" onClick={voltarUmPasso} className="text-xs text-gray-600 hover:underline">
                        ← Voltar
                      </button>
                    </div>
                    {(artigoCorrente || codigoArtigo) && (
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                        <p className="font-mono font-semibold text-gray-900">{artigoCorrente?.codigo || codigoArtigo}</p>
                        {artigoCorrente?.descricao ? (
                          <p className="text-gray-700 text-xs mt-1">{artigoCorrente.descricao}</p>
                        ) : null}
                        {pode && (
                          <p className="text-sm mt-2">
                            Disponível nesta origem:{' '}
                            <strong className="tabular-nums text-[#0915FF]">{disponivelArtigoCorrente}</strong>
                          </p>
                        )}
                      </div>
                    )}
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Quantidade (metragem a mover)</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={qtdDigitada}
                        onChange={(e) => setQtdDigitada(e.target.value)}
                        className="ui-input text-right tabular-nums text-lg"
                        placeholder="0"
                        autoFocus
                      />
                    </div>
                    {((pode &&
                      artigoCorrente &&
                      String(artigoCorrente.tipocontrolo || '').trim().toUpperCase() === 'LOTE') ||
                      (!pode &&
                        wizardItemMetaNoPode &&
                        String(wizardItemMetaNoPode.tipocontrolo || '').trim().toUpperCase() === 'LOTE') ||
                      (!pode &&
                        artigoCorrente &&
                        String(artigoCorrente.tipocontrolo || '').trim().toUpperCase() === 'LOTE')) && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                          <p className="text-xs font-medium text-amber-950">Lotes na localização de origem</p>
                          {wizardLotesLoading ? (
                            <p className="text-xs text-gray-600">A carregar lotes…</p>
                          ) : wizardLotesErro ? (
                            <p className="text-xs text-amber-900">{wizardLotesErro}</p>
                          ) : wizardLotesOpcoes.length === 0 ? (
                            <p className="text-xs text-gray-700">
                              Não foi encontrado stock por lote nesta origem. Indique a metragem manualmente; o servidor
                              tentará alocar pelos lotes disponíveis.
                            </p>
                          ) : (
                            <>
                              <p className="text-[11px] text-gray-700">
                                Selecione um ou mais lotes: a quantidade acima atualiza com a{' '}
                                <strong>soma</strong> das metragens disponíveis; ao desmarcar, subtrai. Pode ajustar o
                                valor manualmente antes de continuar.
                              </p>
                              {wizardLotesSel.length > 0 ? (
                                <p className="text-[11px] text-amber-900 tabular-nums">
                                  Soma nos lotes marcados:{' '}
                                  <strong>
                                    {formatMetrosLoteWizard(
                                      somaMetragemLotesSelecionados(wizardLotesOpcoes, wizardLotesSel)
                                    )}{' '}
                                    m
                                  </strong>
                                  {pode && artigoCorrente
                                    ? ` · teto origem: ${formatMetrosLoteWizard(Number(artigoCorrente.quantidade) || 0)} m`
                                    : null}
                                </p>
                              ) : null}
                              <div className="max-h-48 overflow-y-auto border border-amber-100 rounded-md bg-white p-2 space-y-1">
                                {wizardLotesOpcoes.map((l) => {
                                  const loteCod = String(l.lote || '').trim();
                                  const disp = Number(l.quantidade_disponivel) || 0;
                                  const sel = wizardLotesSel.some(
                                    (s) => String(s || '').trim().toUpperCase() === loteCod.toUpperCase()
                                  );
                                  return (
                                    <label
                                      key={`${l.id}-${loteCod}`}
                                      className={`flex items-start gap-2 text-xs cursor-pointer rounded px-2 py-1.5 ${
                                        sel ? 'bg-[#0915FF]/10 ring-1 ring-[#0915FF]/30' : 'hover:bg-gray-50'
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        className="mt-0.5"
                                        checked={sel}
                                        onChange={() => toggleWizardLoteSel(loteCod)}
                                      />
                                      <span className="font-mono font-medium text-gray-900">{loteCod}</span>
                                      <span className="text-gray-600 tabular-nums">
                                        (+{formatMetrosLoteWizard(disp)} m)
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    {((pode &&
                      artigoCorrente &&
                      isTipoControloSerial(String(artigoCorrente.tipocontrolo || '').trim())) ||
                      (!pode &&
                        wizardItemMetaNoPode &&
                        isTipoControloSerial(
                          String(wizardItemMetaNoPode.tipocontrolo || '').trim()
                        ))) && (
                        <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
                          <p className="text-xs font-medium text-gray-800">Seriais a mover</p>
                          {wizardSerialsLoading ? (
                            <p className="text-xs text-gray-500">A carregar seriais…</p>
                          ) : wizardSerialsErro ? (
                            <p className="text-xs text-amber-800">{wizardSerialsErro}</p>
                          ) : wizardSerialsOpcoes.length === 0 ? (
                            <p className="text-xs text-amber-800">
                              Sem seriais disponíveis nesta localização para este artigo.
                            </p>
                          ) : (
                            <>
                              {(() => {
                                const qLim = Math.max(0, Math.floor(Number(qtdDigitada) || 0));
                                return (
                                  <p className="text-[11px] text-gray-600">
                                    {qLim <= 0
                                      ? 'Indique a quantidade acima para poder escolher os seriais.'
                                      : `${wizardSerialsSel.length}/${qLim} selecionado(s)`}
                                  </p>
                                );
                              })()}
                              <div className="max-h-44 overflow-y-auto border border-gray-100 rounded p-2 space-y-1">
                                {wizardSerialsOpcoes.map((o) => {
                                  const sn = o.serialnumber;
                                  const qLim = Math.max(0, Math.floor(Number(qtdDigitada) || 0));
                                  const checked = wizardSerialsSel.includes(sn);
                                  const disableUnchecked =
                                    !checked && wizardSerialsSel.length >= qLim && qLim > 0;
                                  return (
                                    <label
                                      key={String(o.id ?? sn)}
                                      className="flex items-center gap-2 text-xs text-gray-800"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={disableUnchecked || qLim <= 0}
                                        onChange={() => toggleWizardSerialSelect(sn, qLim)}
                                      />
                                      <span className="font-mono break-all">{sn}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    <button
                      type="button"
                      onClick={confirmarQuantidadeEIrDestino}
                      className="ui-btn ui-btn-primary w-full"
                    >
                      Continuar para destino →
                    </button>
                  </div>
                )}

                {wizardStep === 4 && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800">Destino do stock</p>
                      <button type="button" onClick={voltarUmPasso} className="text-xs text-gray-600 hover:underline">
                        ← Voltar
                      </button>
                    </div>
                    {!linhaPendente ? (
                      <p className="text-sm text-amber-800">Volte atrás e confirme o artigo e a quantidade.</p>
                    ) : (
                      <>
                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs mb-3">
                          <span className="font-mono font-semibold">{linhaPendente.codigo}</span>
                          <span className="text-gray-600 block line-clamp-2 mt-0.5">{linhaPendente.descricao}</span>
                          <span className="text-gray-800 mt-1 block">
                            Quantidade: <strong className="tabular-nums">{linhaPendente.quantidade}</strong>
                          </span>
                          {Array.isArray(linhaPendente.lotes) && linhaPendente.lotes.length > 0 ? (
                            <span className="text-gray-800 mt-1 block">
                              Lote:{' '}
                              <strong className="font-mono">{linhaPendente.lotes.join(', ')}</strong>
                            </span>
                          ) : null}
                        </div>
                        <label className="block text-xs text-gray-600 mb-1" htmlFor="transf-loc-destino-input">
                          <FaMapMarkerAlt className="inline mr-1 text-emerald-600" />
                          {modoTransferencia === 'apeado' ? 'Localização de destino (APEADO)' : 'Localização de destino'}
                        </label>
                        <LocalizacaoCombobox
                          instanceId="transf-loc-destino"
                          inputId="transf-loc-destino-input"
                          selectedId={destinoId}
                          options={locsComIdFiltradasDestino}
                          inputValue={filtroDestinoLoc}
                          onInputChange={handleDestinoComboboxInput}
                          onSelect={(l) => {
                            setDestinoId(String(l.id));
                            setFiltroDestinoLoc(l.localizacao || '');
                          }}
                          onBlurCommitExact={commitDestinoSeCorrespondenciaExata}
                          disabled={locsDestinoCandidatas.length === 0 || (modoTransferencia === 'apeado' && !apeadoArmazemId)}
                          lerDisabled={locsDestinoCandidatas.length === 0 || (modoTransferencia === 'apeado' && !apeadoArmazemId)}
                          onLerClick={() => abrirLeitorQr('destino')}
                          placeholder="Pesquisar ou escolher localização de destino…"
                          lerTitle="Ler QR ou código de barras da localização"
                          lerAriaLabel="Ler QR ou código de barras da localização de destino"
                          emptyListMessage={
                            locsComId.length > 0 && locsDestinoCandidatas.length === 0
                              ? 'Não há outra localização para destino (só existe a origem).'
                              : null
                          }
                          filterNoMatchMessage="Nenhuma localização corresponde ao texto."
                        />
                        <button
                          type="button"
                          disabled={!destinoId || destinoId === origemId || (modoTransferencia === 'apeado' && !apeadoArmazemId)}
                          onClick={() => setWizardStep(5)}
                          className="ui-btn ui-btn-primary w-full disabled:opacity-50"
                        >
                          Rever e criar tickets →
                        </button>
                      </>
                    )}
                  </div>
                )}

                {wizardStep === 5 && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800">Confirmar</p>
                      <button type="button" onClick={voltarUmPasso} className="text-xs text-gray-600 hover:underline">
                        ← Voltar
                      </button>
                    </div>
                    <div className="text-xs text-gray-600 space-y-1 rounded-lg border border-gray-200 p-3 bg-gray-50">
                      <p>
                        <span className="text-gray-500">Origem:</span>{' '}
                        <span className="font-mono">{labelLoc(origemId)}</span>
                      </p>
                      <p>
                        <span className="text-gray-500">Destino:</span>{' '}
                        <span className="font-mono">{labelDestino(destinoId) || '—'}</span>
                      </p>
                    </div>
                    {linhaPendente && (
                      <div className="text-sm border border-gray-200 rounded-lg px-3 py-3 flex justify-between gap-2 bg-white">
                        <span>
                          <span className="font-mono font-medium">{linhaPendente.codigo}</span>
                          <span className="text-gray-600 text-xs block line-clamp-2 mt-0.5">{linhaPendente.descricao}</span>
                          {Array.isArray(linhaPendente.lotes) && linhaPendente.lotes.length > 0 ? (
                            <span className="text-gray-700 text-xs block mt-1 font-mono">
                              Lote: {linhaPendente.lotes.join(', ')}
                            </span>
                          ) : null}
                        </span>
                        <span className="tabular-nums font-medium shrink-0 self-center">× {linhaPendente.quantidade}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={handleTransferir}
                      disabled={
                        submitting ||
                        !destinoId ||
                        destinoId === origemId ||
                        !linhaPendente
                      }
                      className="ui-btn w-full py-3 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {submitting ? 'A criar tickets…' : 'Finalizar — criar movimentação'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="ui-card overflow-hidden ring-1 ring-gray-900/5">
              <div className="px-4 py-3 bg-slate-800 text-white flex flex-wrap items-center gap-3 justify-between">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <FaList className="text-emerald-400" />
                  {modoTransferencia === 'apeado'
                    ? 'Fila de tickets (transferência para APEADOS)'
                    : 'Fila de tickets (movimentação interna)'}
                </h2>
                <p className="text-xs text-slate-300">
                  Registos após confirmar transferências · {nomeDocumentoFila} só para perfis autorizados
                </p>
              </div>
              <div className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-3 text-xs mb-4">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer text-gray-700">
                    <input
                      type="checkbox"
                      checked={ticketsSoPendentesTrfl}
                      onChange={(e) => {
                        setTicketsSoPendentesTrfl(e.target.checked);
                        setSelectedTicketIds([]);
                      }}
                    />
                    Só pendentes de {nomeDocumentoFila}
                  </label>
                  <button
                    type="button"
                    onClick={loadTickets}
                    disabled={!armazemId || loadingTickets}
                    className="ui-btn ui-btn-secondary px-3 py-1.5 disabled:opacity-50 font-medium"
                  >
                    Atualizar
                  </button>
                  {podeExportarTrfl && tickets.length > 0 && (
                    <>
                      <span className="hidden sm:inline text-gray-300">|</span>
                      <button
                        type="button"
                        onClick={selecionarTodosPendentes}
                        className="ui-btn ui-btn-secondary px-3 py-1.5"
                      >
                        Selecionar pendentes
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedTicketIds([])}
                        className="ui-btn ui-btn-secondary px-3 py-1.5"
                      >
                        Limpar seleção
                      </button>
                      <button
                        type="button"
                        onClick={excluirTicketsSelecionados}
                        disabled={deletingTickets || selectedTicketIds.length === 0}
                        className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingTickets ? 'A excluir…' : 'Excluir selecionados'}
                      </button>
                      <button
                        type="button"
                        onClick={gerarTrfl}
                        disabled={exportingTrfl || deletingTickets || selectedTicketIds.length === 0}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {exportingTrfl ? 'A gerar…' : `Gerar / Re-download ${nomeDocumentoFila} (Excel)`}
                      </button>
                      <span className="text-gray-500 self-center tabular-nums">{selectedTicketIds.length} selec.</span>
                    </>
                  )}
                </div>
                {tickets.length > 0 && (
                  <div className="mb-3 flex items-center justify-between gap-2 text-xs">
                    <span className="text-gray-500">
                      Página {ticketsPageClamped} de {totalTicketsPages} · {tickets.length} registos
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setTicketsPage((p) => Math.max(1, p - 1))}
                        disabled={ticketsPageClamped <= 1}
                        className="px-2.5 py-1 border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50"
                      >
                        Anterior
                      </button>
                      <button
                        type="button"
                        onClick={() => setTicketsPage((p) => Math.min(totalTicketsPages, p + 1))}
                        disabled={ticketsPageClamped >= totalTicketsPages}
                        className="px-2.5 py-1 border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50"
                      >
                        Próxima
                      </button>
                    </div>
                  </div>
                )}
                {!podeExportarTrfl && (
                  <p className="text-xs text-gray-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                    A geração do ficheiro <strong>{nomeDocumentoFila}</strong> está reservada a <strong>administrador</strong>,{' '}
                    <strong>backoffice de armazém</strong> e <strong>supervisor de armazém</strong>. Pode consultar a
                    fila abaixo.
                  </p>
                )}
                {!armazemId ? (
                  <p className="text-sm text-gray-500">Selecione o armazém no assistente acima para carregar a fila.</p>
                ) : loadingTickets ? (
                  <p className="text-sm text-gray-500">A carregar tickets…</p>
                ) : tickets.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    {ticketsSoPendentesTrfl
                      ? `Nenhum ticket pendente de ${nomeDocumentoFila}.`
                      : 'Nenhum registo recente.'}
                  </p>
                ) : (
                  <div className="ui-table-wrap overflow-x-hidden">
                    <table className="ui-table w-full table-fixed text-xs">
                      <thead className="bg-gray-100 text-left text-xs text-gray-600 uppercase tracking-wide">
                        <tr>
                          {podeExportarTrfl && <th className="px-2 py-2 w-[5%]" aria-label="Selecionar" />}
                          <th className="px-2 py-2 w-[20%]">Data</th>
                          <th className="px-2 py-2 w-[14%]">Origem</th>
                          <th className="px-2 py-2 w-[14%]">Destino</th>
                          <th className="px-2 py-2 w-[31%]">Artigo</th>
                          <th className="px-2 py-2 w-[8%] text-right">Qtd</th>
                          <th className="px-2 py-2 w-[8%]">{nomeDocumentoFila}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {ticketsPaginaAtual.map((t) => {
                          const pendente = t.trfl_gerada_em == null;
                          const checked = selectedTicketIds.includes(t.id);
                          return (
                            <tr key={t.id} className={pendente ? 'hover:bg-gray-50/80' : 'opacity-70 bg-gray-50/50'}>
                              {podeExportarTrfl && (
                                <td className="px-2 py-2 align-top">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleTicket(t.id)}
                                    title={pendente ? '' : `${nomeDocumentoFila} já gerada: pode selecionar para re-download`}
                                  />
                                </td>
                              )}
                              <td className="px-2 py-2 text-[11px] text-gray-700 align-top">
                                {t.created_at
                                  ? new Date(t.created_at).toLocaleString('pt-PT')
                                  : '—'}
                              </td>
                              <td className="px-2 py-2 font-mono text-[11px] truncate align-top" title={t.origem_localizacao_label || '—'}>
                                {t.origem_localizacao_label || '—'}
                              </td>
                              <td className="px-2 py-2 font-mono text-[11px] truncate align-top" title={t.destino_localizacao_label || '—'}>
                                {t.destino_localizacao_label || '—'}
                              </td>
                              <td className="px-2 py-2 align-top">
                                <span className="font-mono font-medium text-[11px]">{t.item_codigo}</span>
                                {t.item_descricao ? (
                                  <span className="block text-[11px] text-gray-500 truncate" title={t.item_descricao}>
                                    {t.item_descricao}
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums font-medium text-[11px] align-top">{t.quantidade}</td>
                              <td className="px-2 py-2 text-[11px] align-top">
                                {pendente ? (
                                  <span className="text-amber-700 font-medium">Pendente</span>
                                ) : (
                                  <span className="text-emerald-700 font-medium">Gerada</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <QrScannerModal
          open={qrLeitorOpen}
          onClose={() => {
            qrLeitorPurposeRef.current = null;
            setQrLeitorPurpose(null);
            setQrLeitorOpen(false);
          }}
          onScan={processarLeituraQr}
          title={
            qrLeitorPurpose === 'origem'
              ? 'Ler localização de origem (QR ou código de barras)'
              : qrLeitorPurpose === 'destino'
                ? 'Ler localização de destino (QR ou código de barras)'
                : qrLeitorPurpose === 'pesquisaArtigo'
                  ? 'Ler artigo — pesquisa (QR ou código de barras)'
                  : 'Ler código do artigo (QR ou código de barras)'
          }
          readerId="qr-reader-transf-localizacao"
          closeOnScan
          formatsToSupport={FORMATOS_QR_BARCODE}
        />

        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      </div>
    </div>
  );
};

export default TransferenciaLocalizacao;
