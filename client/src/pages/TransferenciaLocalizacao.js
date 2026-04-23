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

const extrairCodigoArtigo = (valor) => {
  const s = String(valor || '').trim();
  if (!s) return '';
  return s.split(' - ')[0].trim();
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
  const [armazemId, setArmazemId] = useState('');
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
  const [loteOrigemLabel, setLoteOrigemLabel] = useState('');
  const [submittingLote, setSubmittingLote] = useState(false);
  const prefillConsumidoRef = useRef(false);
  /** 1=origem, 2=artigo, 3=quantidade, 4=destino, 5=confirmar */
  const [wizardStep, setWizardStep] = useState(1);
  /** Linha de stock escolhida no passo 2 → passo 3 */
  const [artigoCorrente, setArtigoCorrente] = useState(null);
  const refCodigoArtigoWrap = useRef(null);
  const refCodigoArtigoInput = useRef(null);
  const refListaCodigoArtigo = useRef(null);

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
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return;
    prefillConsumidoRef.current = true;

    const armazemPrefill = String(payload.armazemId || '').trim();
    if (armazemPrefill) setArmazemId(armazemPrefill);

    const origemLabel = String(payload.origemLocalizacao || '').trim();
    setLoteOrigemLabel(origemLabel);
    if (origemLabel) setFiltroOrigemLoc(origemLabel);

    const byCodigo = new Map();
    payload.items.forEach((it) => {
      const codigo = String(it?.codigo || '').trim();
      const qtd = Number(it?.quantidade || 0) || 0;
      if (!codigo || qtd <= 0) return;
      const key = codigo.toUpperCase();
      const prev = byCodigo.get(key) || {
        codigo,
        descricao: String(it?.descricao || '').trim(),
        quantidade: 0,
        destinoId: '',
      };
      prev.quantidade += qtd;
      if (!prev.descricao) prev.descricao = String(it?.descricao || '').trim();
      byCodigo.set(key, prev);
    });
    setLoteRecebimento([...byCodigo.values()]);
  }, [location.state]);

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

  const armazemExibicao = armazemSel || (armazemUnico ? centrais[0] : null);

  const locsComId = useMemo(() => {
    const locs = armazemSel?.localizacoes || [];
    return locs.filter((l) => l && l.id != null);
  }, [armazemSel]);

  const locsComIdFiltradasOrigem = useMemo(() => {
    const q = normBusca(filtroOrigemLoc);
    if (!q) return locsComId;
    return locsComId.filter((l) => normBusca(l.localizacao || '').includes(q));
  }, [locsComId, filtroOrigemLoc]);

  const locsDestinoCandidatas = useMemo(
    () => locsComId.filter((l) => String(l.id) !== String(origemId)),
    [locsComId, origemId]
  );

  const locsComIdFiltradasDestino = useMemo(() => {
    const q = normBusca(filtroDestinoLoc);
    if (!q) return locsDestinoCandidatas;
    return locsDestinoCandidatas.filter((l) => normBusca(l.localizacao || '').includes(q));
  }, [locsDestinoCandidatas, filtroDestinoLoc]);

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
  }, [armazemId]);

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
      setTickets(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setTickets([]);
    } finally {
      setLoadingTickets(false);
    }
  }, [armazemId, ticketsSoPendentesTrfl]);

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
      setLinhaPendente({
        item_id: null,
        codigo: cod,
        descricao: '',
        quantidade: q
      });
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
    setLinhaPendente({
      item_id: row.item_id,
      codigo: row.codigo,
      descricao: row.descricao,
      quantidade: q
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
    if (!linhaPendente) {
      setToast({ type: 'error', message: 'Defina o artigo e a quantidade antes de confirmar.' });
      return;
    }
    setSubmitting(true);
    setToast(null);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `/api/armazens/${armazemId}/transferencia-localizacao`,
        {
          origem_localizacao_id: parseInt(origemId, 10),
          destino_localizacao_id: parseInt(destinoId, 10),
          linhas: [
            pode
              ? { item_id: linhaPendente.item_id, quantidade: linhaPendente.quantidade }
              : { item_codigo: linhaPendente.codigo, quantidade: linhaPendente.quantidade }
          ]
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      setToast({ type: 'success', message: 'Transferência concluída. Os tickets aparecem na fila abaixo.' });
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
      setToast({ type: 'error', message: 'O seu perfil não pode gerar TRFL desta fila.' });
      return;
    }
    if (!armazemId || selectedTicketIds.length === 0) {
      setToast({ type: 'error', message: 'Selecione pelo menos um ticket para gerar/retransferir a TRFL.' });
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
      const res = await fetch(`/api/armazens/${armazemId}/movimentacoes-internas/export-trfl`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids: selectedTicketIds })
      });
      if (!res.ok) {
        let msg = 'Erro ao gerar TRFL.';
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
      let fn = `TRFL_mov_interna_arm${armazemId}.xlsx`;
      const m = /filename\*?=(?:UTF-8'')?["']?([^";\n]+)/i.exec(disp);
      if (m) fn = decodeURIComponent(m[1].replace(/["']/g, '').trim());
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fn;
      a.click();
      window.URL.revokeObjectURL(url);
      setToast({ type: 'success', message: 'Ficheiro TRFL transferido.' });
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
      'Apenas tickets sem TRFL gerada podem ser removidos.'
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
          message: `${deleted} ticket(s) excluído(s). ${skipped} não foram removidos (TRFL já gerada).`,
        });
      } else {
        setToast({ type: 'success', message: `${deleted} ticket(s) excluído(s) com sucesso.` });
      }
      setSelectedTicketIds([]);
      loadTickets();
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

    const semDestino = loteRecebimento.find((it) => !it.destinoId || String(it.destinoId) === String(origemId));
    if (semDestino) {
      setToast({
        type: 'error',
        message: `Defina um destino válido para ${semDestino.codigo}.`,
      });
      return;
    }

    setSubmittingLote(true);
    try {
      const token = localStorage.getItem('token');
      let criados = 0;
      for (const it of loteRecebimento) {
        const quantidade = Number(it.quantidade || 0) || 0;
        if (quantidade <= 0) continue;
        const codigo = String(it.codigo || '').trim();
        if (!codigo) continue;

        const rowStock = (linhasOrigem || []).find(
          (r) => String(r?.codigo || '').trim().toUpperCase() === codigo.toUpperCase()
        );
        if (pode && !rowStock) {
          throw new Error(`Artigo ${codigo} não encontrado no stock da origem.`);
        }
        if (pode) {
          const disponivel = Number(rowStock?.quantidade || 0) || 0;
          if (quantidade > disponivel) {
            throw new Error(`Quantidade de ${codigo} superior ao disponível (${disponivel}).`);
          }
        }

        const linhaPayload = pode
          ? { item_id: rowStock.item_id, quantidade }
          : { item_codigo: codigo, quantidade };

        await axios.post(
          `/api/armazens/${armazemId}/transferencia-localizacao`,
          {
            origem_localizacao_id: parseInt(origemId, 10),
            destino_localizacao_id: parseInt(it.destinoId, 10),
            linhas: [linhaPayload],
          },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        criados += 1;
      }

      setToast({
        type: 'success',
        message: `${criados} ticket(s) criado(s) com sucesso para armazenagem.`,
      });
      limparPrefillRecebimento();
      loadTickets();
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Erro ao gerar tickets em lote.';
      setToast({ type: 'error', message: msg });
    } finally {
      setSubmittingLote(false);
    }
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
              Transferência de localização
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
                    <table className="ui-table w-full text-xs">
                      <thead>
                        <tr>
                          <th className="px-2 py-2 text-left">Artigo</th>
                          <th className="px-2 py-2 text-right">Qtd</th>
                          <th className="px-2 py-2 text-left">Destino</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loteRecebimento.map((it, idx) => (
                          <tr key={`${it.codigo}-${idx}`}>
                            <td className="px-2 py-2">
                              <span className="font-mono font-medium">{it.codigo}</span>
                              {it.descricao ? (
                                <span className="block text-[11px] text-gray-500 truncate">{it.descricao}</span>
                              ) : null}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{it.quantidade}</td>
                            <td className="px-2 py-2">
                              <select
                                value={it.destinoId}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setLoteRecebimento((prev) =>
                                    prev.map((row, i) => (i === idx ? { ...row, destinoId: next } : row))
                                  );
                                }}
                                className="ui-select"
                              >
                                <option value="">Selecione destino…</option>
                                {locsDestinoCandidatas.map((l) => (
                                  <option key={l.id} value={String(l.id)}>
                                    {l.localizacao}
                                  </option>
                                ))}
                              </select>
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
                      onClick={limparPrefillRecebimento}
                      disabled={submittingLote}
                    >
                      Cancelar pré-preenchimento
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary disabled:opacity-50"
                      onClick={gerarTicketsLoteRecebimento}
                      disabled={submittingLote || !armazemId || !origemId || locsDestinoCandidatas.length === 0}
                    >
                      {submittingLote ? 'A criar tickets…' : 'Gerar tickets de armazenagem'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className={`ui-card overflow-visible ${loteRecebimento.length > 0 ? 'hidden' : ''}`}>
              <div className="px-3 sm:px-4 py-3 border-b border-gray-100 bg-gray-50/90">
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
                      <label className="block text-xs text-gray-600 mb-1">Quantidade</label>
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
                        </div>
                        <label className="block text-xs text-gray-600 mb-1" htmlFor="transf-loc-destino-input">
                          <FaMapMarkerAlt className="inline mr-1 text-emerald-600" />
                          Localização de destino
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
                          disabled={locsDestinoCandidatas.length === 0}
                          lerDisabled={locsDestinoCandidatas.length === 0}
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
                          disabled={!destinoId || destinoId === origemId}
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
                        <span className="font-mono">{labelLoc(destinoId) || '—'}</span>
                      </p>
                    </div>
                    {linhaPendente && (
                      <div className="text-sm border border-gray-200 rounded-lg px-3 py-3 flex justify-between gap-2 bg-white">
                        <span>
                          <span className="font-mono font-medium">{linhaPendente.codigo}</span>
                          <span className="text-gray-600 text-xs block line-clamp-2 mt-0.5">{linhaPendente.descricao}</span>
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
                  Fila de tickets (movimentação interna)
                </h2>
                <p className="text-xs text-slate-300">
                  Registos após confirmar transferências · TRFL só para perfis autorizados
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
                    Só pendentes de TRFL
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
                        {exportingTrfl ? 'A gerar…' : 'Gerar / Re-download TRFL (Excel)'}
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
                    A geração do ficheiro <strong>TRFL</strong> está reservada a <strong>administrador</strong>,{' '}
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
                      ? 'Nenhum ticket pendente de TRFL.'
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
                          <th className="px-2 py-2 w-[8%]">TRFL</th>
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
                                    title={pendente ? '' : 'TRFL já gerada: pode selecionar para re-download'}
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
