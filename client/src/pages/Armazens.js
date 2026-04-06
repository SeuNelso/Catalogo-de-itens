import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { ROLES } from '../utils/roles';
import { podeUsarControloStock } from '../utils/controloStock';
import Toast from '../components/Toast';
import QrScannerModal from '../components/QrScannerModal';
import PesquisaComLeitorQr from '../components/PesquisaComLeitorQr';
import { FORMATOS_QR_BARCODE } from '../utils/qrBarcodeFormats';
import { FaPlus, FaEdit, FaTrash, FaWarehouse, FaFileUpload, FaChevronLeft, FaChevronRight, FaTimes, FaLayerGroup } from 'react-icons/fa';
import axios from 'axios';

const normalizeSearch = (v) => String(v || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const normHeaderKey = (h) => String(h || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

function rowViaturaFromObject(row) {
  if (!row || typeof row !== 'object') return { codigo: '', descricao: '' };
  const codigo =
    row.codigo ?? row.CODIGO ?? row.Código ?? row.code ?? row.armazem ?? row.Armazém ?? '';
  const descricao =
    row.descricao ?? row.DESCRICAO ?? row.Descrição ?? row.description ?? row.nome ?? '';
  return {
    codigo: String(codigo ?? '').trim(),
    descricao: String(descricao ?? '').trim()
  };
}

function parseViaturaDelimitedText(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0];
  const semi = head.split(';').length;
  const comma = head.split(',').length;
  const delim = semi > comma ? ';' : ',';
  const headers = head.split(delim).map((h) => normHeaderKey(h));
  const idxCod = headers.findIndex((h) => ['codigo', 'code', 'armazem'].includes(h));
  const idxDesc = headers.findIndex((h) => ['descricao', 'description', 'nome'].includes(h));
  if (idxCod < 0 || idxDesc < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(delim);
    out.push({
      codigo: String(parts[idxCod] ?? '').trim(),
      descricao: String(parts[idxDesc] ?? '').trim()
    });
  }
  return out;
}

/** Itens por página na lista principal (reduz nós no DOM e facilita navegação). */
const LIST_PAGE_SIZE = 15;

const MAX_LOC_PREVIEW_LEN = 42;

const Armazens = () => {
  const [armazens, setArmazens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const [formData, setFormData] = useState({
    codigo: '',
    descricao: '',
    tipo: 'viatura', // 'central' | 'viatura' | 'apeado' | 'epi'
    localizacoes: [],  // central: [{ localizacao, tipo_localizacao }]; viatura: preenchido com 2 (normal, FERR)
    armazem_central_vinculado_id: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [tipoFiltro, setTipoFiltro] = useState('todos'); // todos | central | viatura | apeado | epi
  const [centralBulkText, setCentralBulkText] = useState('');
  const [importingLocFile, setImportingLocFile] = useState(false);
  const [importingViaturaFile, setImportingViaturaFile] = useState(false);
  const [editingLocIdx, setEditingLocIdx] = useState(null);
  const [editingLocValue, setEditingLocValue] = useState('');
  const [editingLocTipo, setEditingLocTipo] = useState('normal');
  const [centralLocSearch, setCentralLocSearch] = useState('');
  const [centralLocTipoFiltro, setCentralLocTipoFiltro] = useState('todos');
  const [listPage, setListPage] = useState(1);
  const { user } = useAuth();
  const confirm = useConfirm();
  /** Criar/editar/importar/eliminar: só administrador; restantes perfis com rota a /armazéns: só consulta */
  const isAdminArmazens = user?.role === ROLES.ADMIN;
  const showFormularioArmazem = isAdminArmazens && mostrarForm;
  /** Estoque por localização (modal): acesso por flag de controlo de stock no utilizador. */
  const podeGerirEstoqueLocal = podeUsarControloStock(user);

  const [estoqueOpen, setEstoqueOpen] = useState(false);
  const [estoqueArmazem, setEstoqueArmazem] = useState(null);
  const [estoqueLocId, setEstoqueLocId] = useState('');
  const [estoqueLinhas, setEstoqueLinhas] = useState([]);
  const [estoqueLoading, setEstoqueLoading] = useState(false);
  const [estoqueSaving, setEstoqueSaving] = useState(false);
  const [estoqueBuscaItem, setEstoqueBuscaItem] = useState('');
  const [estoqueItensRes, setEstoqueItensRes] = useState([]);
  const [estoqueBuscaLoading, setEstoqueBuscaLoading] = useState(false);
  const [estoqueQtdAdd, setEstoqueQtdAdd] = useState('1');
  const [estoqueReloadKey, setEstoqueReloadKey] = useState(0);
  const [estoqueNacionalModo, setEstoqueNacionalModo] = useState('definir');
  const [estoqueNacionalLoading, setEstoqueNacionalLoading] = useState(false);

  const [armQrOpen, setArmQrOpen] = useState(false);
  const [armQrPurpose, setArmQrPurpose] = useState(null);
  const armQrPurposeRef = useRef(null);

  const parseCentralBulkText = (text) => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = [];
    for (const line of lines) {
      // Formatos aceitos:
      // - LOCALIZACAO
      // - tipo;LOCALIZACAO
      // - tipo,LOCALIZACAO
      // tipo = recebimento | expedicao | normal
      let tipo = 'normal';
      let localizacao = line;

      const parts = line.includes(';')
        ? line.split(';')
        : (line.includes(',') ? line.split(',') : [line]);

      if (parts.length >= 2) {
        const tipoRaw = (parts[0] || '').trim().toLowerCase();
        localizacao = parts.slice(1).join(';').trim();
        if (tipoRaw.startsWith('rec')) tipo = 'recebimento';
        else if (tipoRaw.startsWith('exp')) tipo = 'expedicao';
        else tipo = 'normal';
      }

      if (!localizacao) continue;
      parsed.push({ localizacao, tipo_localizacao: tipo });
    }

    // Remove duplicadas por combinação tipo+localização
    const unique = [];
    const seen = new Set();
    for (const l of parsed) {
      const key = `${String(l.tipo_localizacao)}|${String(l.localizacao).toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(l);
    }
    return unique;
  };

  const buildCentralBulkText = (locs = []) => {
    return (locs || [])
      .filter(l => (l?.localizacao || '').trim())
      .map((l) => `${l.tipo_localizacao || 'normal'};${(l.localizacao || '').trim()}`)
      .join('\n');
  };

  const formatLocLine = (l) => `${l.tipo_localizacao || 'normal'};${(l.localizacao || '').trim()}`;

  const mapTipoToInternal = (tipoRaw) => {
    const t = String(tipoRaw || '').trim().toUpperCase();
    if (t === 'REC' || t === 'RECEBIMENTO') return 'recebimento';
    if (t === 'EXP' || t === 'EXPEDICAO' || t === 'EXPEDIÇÃO') return 'expedicao';
    if (t === 'N' || t === 'NORMAL' || t === '') return 'normal';
    return null;
  };

  const handleImportCentralFile = async (file) => {
    if (!file) return;
    try {
      setImportingLocFile(true);
      const name = String(file.name || '').toLowerCase();
      let records = [];

      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        const text = await file.text();
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        records = lines.map((line) => {
          const parts = line.includes(';') ? line.split(';') : line.split(',');
          return {
            localizacao: String(parts[0] || '').trim(),
            tipo: String(parts[1] || '').trim()
          };
        });
      } else {
        const XLSX = await import('xlsx');
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        records = rows.map((r) => {
          const localizacao = r.localizacao ?? r.LOCALIZACAO ?? r.LOCALIZAÇÃO ?? r.Localizacao ?? r.Localização ?? r.LOCATION ?? r.Location ?? '';
          const tipo = r.tipo ?? r.TIPO ?? r.Tipo ?? r.type ?? r.TYPE ?? '';
          return { localizacao: String(localizacao || '').trim(), tipo: String(tipo || '').trim() };
        });

        // fallback sem cabeçalho: assume col A=localizacao, col B=tipo
        if (!records.length) {
          const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          records = rawRows
            .slice(1)
            .map((r) => ({
              localizacao: String(r?.[0] || '').trim(),
              tipo: String(r?.[1] || '').trim()
            }));
        }
      }

      const locs = [];
      const invalid = [];
      for (const rec of records) {
        if (!rec.localizacao) continue;
        const mappedTipo = mapTipoToInternal(rec.tipo);
        if (!mappedTipo) {
          invalid.push(rec.tipo);
          continue;
        }
        locs.push({ localizacao: rec.localizacao, tipo_localizacao: mappedTipo });
      }

      const unique = [];
      const seen = new Set();
      for (const l of locs) {
        const key = `${l.tipo_localizacao}|${l.localizacao.toUpperCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(l);
      }

      setCentralBulkText(buildCentralBulkText(unique));
      setEditingLocIdx(null);
      setEditingLocValue('');
      setEditingLocTipo('normal');

      const hasRec = unique.some(l => l.tipo_localizacao === 'recebimento');
      const hasExp = unique.some(l => l.tipo_localizacao === 'expedicao');
      const extra = invalid.length ? ` Tipos inválidos ignorados: ${Array.from(new Set(invalid)).slice(0, 5).join(', ')}.` : '';
      const reqMsg = (!hasRec || !hasExp)
        ? ' Atenção: ainda precisa ter pelo menos 1 REC e 1 EXP.'
        : '';
      setToast({
        type: unique.length ? 'success' : 'error',
        message: unique.length
          ? `${unique.length} localização(ões) importadas com sucesso.${reqMsg}${extra}`
          : 'Nenhuma localização válida encontrada no ficheiro.'
      });
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: 'Erro ao importar ficheiro de localizações.' });
    } finally {
      setImportingLocFile(false);
    }
  };

  const handleDownloadCentralTemplate = async () => {
    try {
      const XLSX = await import('xlsx');
      const templateData = [
        { localizacao: 'E.REC', tipo: 'REC' },
        { localizacao: 'E.EXP01', tipo: 'EXP' },
        { localizacao: 'E.A01', tipo: 'N' }
      ];
      const ws = XLSX.utils.json_to_sheet(templateData, {
        header: ['localizacao', 'tipo']
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Template');
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'template_localizacoes_central.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: 'Erro ao gerar template em Excel.' });
    }
  };

  const handleDownloadViaturaTemplate = async () => {
    try {
      const XLSX = await import('xlsx');
      const templateData = [
        { codigo: 'V848', descricao: 'Exemplo viatura 1' },
        { codigo: 'V849', descricao: 'Exemplo viatura 2' }
      ];
      const ws = XLSX.utils.json_to_sheet(templateData, { header: ['codigo', 'descricao'] });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Viaturas');
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'template_importar_viaturas.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      setToast({ type: 'error', message: 'Erro ao gerar template de viaturas.' });
    }
  };

  const handleImportViaturaFile = async (file) => {
    if (!file) return;
    try {
      setImportingViaturaFile(true);
      const name = String(file.name || '').toLowerCase();
      let rows = [];
      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        const text = await file.text();
        rows = parseViaturaDelimitedText(text);
        if (!rows.length) {
          setToast({
            type: 'error',
            message: 'CSV inválido: use cabeçalhos codigo e descricao (ou armazem / nome).'
          });
          return;
        }
      } else {
        const XLSX = await import('xlsx');
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
        rows = json.map(rowViaturaFromObject).filter((r) => r.codigo || r.descricao);
        if (!rows.length) {
          setToast({ type: 'error', message: 'Nenhuma linha com codigo e descricao.' });
          return;
        }
      }

      const token = localStorage.getItem('token');
      const { data } = await axios.post('/api/armazens/import-viatura', { rows }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      const created = data?.created || [];
      const skipped = data?.skipped || [];
      const errors = data?.errors || [];
      const msgParts = [`${created.length} armazém(ns) criado(s)`];
      if (skipped.length) msgParts.push(`${skipped.length} ignorado(s)`);
      if (errors.length) msgParts.push(`${errors.length} linha(s) com erro`);
      let detail = '';
      if (skipped[0]) detail += ` Ignorado: ${skipped[0].codigo} (${skipped[0].reason}).`;
      if (errors[0]) detail += ` Erro linha ${errors[0].line}: ${errors[0].reason}.`;
      setToast({
        type: created.length > 0 ? 'success' : 'error',
        message: msgParts.join(', ') + '.' + detail
      });
      if (created.length) fetchArmazens();
    } catch (error) {
      const msg = error.response?.data?.error || error.response?.data?.details || 'Erro ao importar viaturas.';
      setToast({ type: 'error', message: typeof msg === 'string' ? msg : 'Erro ao importar viaturas.' });
    } finally {
      setImportingViaturaFile(false);
    }
  };

  useEffect(() => {
    fetchArmazens();
  }, []);

  const locacoesComId = (armazem) =>
    (armazem?.localizacoes || []).filter((l) => l && l.id != null);

  const openEstoqueModal = (armazem) => {
    if (!podeGerirEstoqueLocal) {
      setToast({
        type: 'error',
        message: 'Apenas administradores com permissão de controlo de stock podem gerir estoque por localização.',
      });
      return;
    }
    if (String(armazem?.tipo || '').trim().toLowerCase() !== 'central') {
      setToast({ type: 'error', message: 'Estoque por localização está disponível apenas em armazéns centrais.' });
      return;
    }
    const locs = locacoesComId(armazem);
    if (locs.length === 0) {
      setToast({
        type: 'error',
        message:
          'Não há localizações com identificador neste armazém. Edite o armazém e guarde para gerar localizações na base de dados.'
      });
      return;
    }
    setEstoqueArmazem(armazem);
    setEstoqueLocId(String(locs[0].id));
    setEstoqueBuscaItem('');
    setEstoqueItensRes([]);
    setEstoqueQtdAdd('1');
    setEstoqueOpen(true);
  };

  const closeEstoqueModal = () => {
    setEstoqueOpen(false);
    setEstoqueArmazem(null);
    setEstoqueLocId('');
    setEstoqueLinhas([]);
    setEstoqueBuscaItem('');
    setEstoqueItensRes([]);
  };

  useEffect(() => {
    if (!estoqueOpen || !estoqueArmazem?.id || !estoqueLocId) return;
    let cancelled = false;
    (async () => {
      setEstoqueLoading(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get(
          `/api/armazens/${estoqueArmazem.id}/localizacoes/${estoqueLocId}/estoque`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!cancelled) setEstoqueLinhas(Array.isArray(data) ? data.map((r) => ({ ...r })) : []);
      } catch (e) {
        const d = e.response?.data;
        const hint = d?.hint ? ` ${d.hint}` : '';
        if (!cancelled) {
          setToast({ type: 'error', message: (d?.error || 'Erro ao carregar estoque.') + hint });
          setEstoqueLinhas([]);
        }
      } finally {
        if (!cancelled) setEstoqueLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [estoqueOpen, estoqueArmazem?.id, estoqueLocId, estoqueReloadKey]);

  const locEstoqueSelecionada = useMemo(() => {
    if (!estoqueArmazem || !estoqueLocId) return null;
    const locs = (estoqueArmazem.localizacoes || []).filter((l) => l && l.id != null);
    return locs.find((l) => String(l.id) === String(estoqueLocId)) || null;
  }, [estoqueArmazem, estoqueLocId]);

  const estoqueLocEhRecebimento =
    String(locEstoqueSelecionada?.tipo_localizacao || '').toLowerCase() === 'recebimento';

  const estoqueCentralTemRecebimento = useMemo(() => {
    if (!estoqueArmazem?.localizacoes) return false;
    return (estoqueArmazem.localizacoes || []).some(
      (l) => l && l.id != null && String(l.tipo_localizacao || '').toLowerCase() === 'recebimento'
    );
  }, [estoqueArmazem]);

  const idLocalRecebimentoCentral = useMemo(() => {
    if (!estoqueArmazem?.localizacoes) return null;
    const loc = (estoqueArmazem.localizacoes || []).find(
      (l) => l && l.id != null && String(l.tipo_localizacao || '').toLowerCase() === 'recebimento'
    );
    return loc ? String(loc.id) : null;
  }, [estoqueArmazem]);

  const postAplicarStockNacionalRecebimento = async (modo) => {
    const token = localStorage.getItem('token');
    const { data } = await axios.post(
      `/api/armazens/${estoqueArmazem.id}/aplicar-stock-nacional-recebimento`,
      { modo },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return data;
  };

  /** Um clique: todos os artigos com match de stock nacional → quantidades no recebimento (substitui por artigo). */
  const lancarTodoStockNacionalNoRecebimento = async () => {
    if (!podeGerirEstoqueLocal || !estoqueArmazem?.id || !estoqueCentralTemRecebimento) return;
    const desc = String(estoqueArmazem.descricao || '').trim() || '(sem descrição)';
    const accepted = await confirm({
      title: 'Lançar todo o stock nacional no recebimento',
      message:
        `Serão atualizados automaticamente todos os artigos que tenham stock nacional cuja coluna de armazém corresponde à descrição deste central («${desc}»). ` +
        'Em cada um, a quantidade na localização de recebimento passa a ser igual à do stock nacional (substitui o valor anterior). ' +
        'Artigos sem correspondência no Excel não são alterados. Continuar?',
      confirmLabel: 'Lançar tudo',
      cancelLabel: 'Cancelar',
      variant: 'warning'
    });
    if (!accepted) return;
    setEstoqueNacionalLoading(true);
    try {
      const data = await postAplicarStockNacionalRecebimento('definir');
      const n = data?.itens_atualizados ?? 0;
      setToast({
        type: n > 0 ? 'success' : 'warning',
        message:
          n > 0
            ? `${n} artigo(s) lançados no recebimento com as quantidades do stock nacional.`
            : data?.message || 'Nenhuma correspondência encontrada.'
      });
      if (idLocalRecebimentoCentral) setEstoqueLocId(idLocalRecebimentoCentral);
      setEstoqueReloadKey((k) => k + 1);
    } catch (e) {
      const d = e.response?.data;
      setToast({ type: 'error', message: d?.error || d?.message || 'Erro ao lançar stock nacional.' });
    } finally {
      setEstoqueNacionalLoading(false);
    }
  };

  const aplicarStockNacionalRecebimento = async () => {
    if (!podeGerirEstoqueLocal || !estoqueArmazem?.id) return;
    const modoLabel =
      estoqueNacionalModo === 'somar'
        ? 'somar o stock nacional à quantidade já registada no recebimento'
        : 'definir no recebimento a quantidade igual à do stock nacional (substitui o valor anterior por artigo)';
    const accepted = await confirm({
      title: 'Stock nacional → recebimento',
      message: `Os textos das colunas de armazém na importação de stock nacional serão comparados com a descrição deste armazém («${String(
        estoqueArmazem.descricao || ''
      ).trim() || '(vazio)'}»). Será atualizada apenas a localização de recebimento deste central. Modo: ${modoLabel}. Continuar?`,
      confirmLabel: 'Aplicar',
      cancelLabel: 'Cancelar',
      variant: 'warning'
    });
    if (!accepted) return;
    setEstoqueNacionalLoading(true);
    try {
      const data = await postAplicarStockNacionalRecebimento(estoqueNacionalModo);
      const n = data?.itens_atualizados ?? 0;
      setToast({
        type: n > 0 ? 'success' : 'warning',
        message:
          n > 0
            ? `${n} artigo(s) atualizados no recebimento conforme stock nacional.`
            : data?.message || 'Nenhuma correspondência encontrada.'
      });
      setEstoqueReloadKey((k) => k + 1);
    } catch (e) {
      const d = e.response?.data;
      setToast({ type: 'error', message: d?.error || d?.message || 'Erro ao aplicar stock nacional.' });
    } finally {
      setEstoqueNacionalLoading(false);
    }
  };

  const saveEstoqueLinhas = async () => {
    if (!podeGerirEstoqueLocal || !estoqueArmazem?.id || !estoqueLocId) return;
    setEstoqueSaving(true);
    try {
      const token = localStorage.getItem('token');
      await axios.put(
        `/api/armazens/${estoqueArmazem.id}/localizacoes/${estoqueLocId}/estoque`,
        {
          linhas: estoqueLinhas.map((l) => ({
            item_id: l.item_id,
            quantidade: Number(l.quantidade) || 0
          }))
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      setToast({ type: 'success', message: 'Estoque da localização guardado.' });
    } catch (e) {
      const d = e.response?.data;
      setToast({ type: 'error', message: d?.error || 'Erro ao guardar estoque.' });
    } finally {
      setEstoqueSaving(false);
    }
  };

  const updateEstoqueQuantidade = (itemId, valor) => {
    const q = Number(valor);
    setEstoqueLinhas((prev) =>
      prev.map((l) => (l.item_id === itemId ? { ...l, quantidade: Number.isFinite(q) && q >= 0 ? q : 0 } : l))
    );
  };

  const removeEstoqueLinha = (itemId) => {
    setEstoqueLinhas((prev) => prev.filter((l) => l.item_id !== itemId));
  };

  const buscarItensParaEstoque = useCallback(async (overrideQ) => {
    const raw = overrideQ !== undefined && overrideQ !== null ? String(overrideQ) : estoqueBuscaItem;
    const q = raw.trim();
    if (!q) {
      setToast({ type: 'error', message: 'Escreva código ou descrição para pesquisar.' });
      return;
    }
    setEstoqueBuscaLoading(true);
    try {
      const token = localStorage.getItem('token');
      const { data } = await axios.get('/api/itens', {
        params: { search: q, limit: 40, page: 1, incluirInativos: true },
        headers: { Authorization: `Bearer ${token}` }
      });
      setEstoqueItensRes(data.itens || []);
      if (!(data.itens || []).length) {
        setToast({ type: 'error', message: 'Nenhum artigo encontrado.' });
      }
    } catch (e) {
      setToast({ type: 'error', message: 'Erro ao pesquisar artigos.' });
      setEstoqueItensRes([]);
    } finally {
      setEstoqueBuscaLoading(false);
    }
  }, [estoqueBuscaItem]);

  const openArmQr = (purpose) => {
    armQrPurposeRef.current = purpose;
    setArmQrPurpose(purpose);
    setArmQrOpen(true);
  };

  const processarArmQrScan = useCallback(
    async (texto) => {
      const purpose = armQrPurposeRef.current;
      armQrPurposeRef.current = null;
      setArmQrPurpose(null);
      const v = String(texto || '').trim();
      if (!v || !purpose) return;
      if (purpose === 'centralLoc') {
        setCentralLocSearch(v);
        return;
      }
      if (purpose === 'listaArmazens') {
        setSearchTerm(v);
        return;
      }
      if (purpose === 'estoqueItem') {
        setEstoqueBuscaItem(v);
        await buscarItensParaEstoque(v);
      }
    },
    [buscarItensParaEstoque]
  );

  const adicionarItemAoEstoqueLocal = (item) => {
    if (!item?.id) return;
    const addQ = Number(estoqueQtdAdd);
    const q = Number.isFinite(addQ) && addQ > 0 ? addQ : 1;
    setEstoqueLinhas((prev) => {
      const idx = prev.findIndex((l) => l.item_id === item.id);
      if (idx >= 0) {
        const next = [...prev];
        const atual = Number(next[idx].quantidade) || 0;
        next[idx] = { ...next[idx], quantidade: atual + q };
        return next;
      }
      return [
        ...prev,
        {
          item_id: item.id,
          codigo: item.codigo,
          descricao: item.descricao || item.nome || '',
          quantidade: q
        }
      ];
    });
    setToast({ type: 'success', message: `Artigo ${item.codigo} adicionado.` });
  };

  const fetchArmazens = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/armazens', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      setArmazens(response.data || []);
    } catch (error) {
      console.error('Erro ao buscar armazéns:', error);
      setToast({ type: 'error', message: 'Erro ao carregar armazéns' });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.codigo.trim()) {
      setToast({ type: 'error', message: 'O código é obrigatório (ex: V848 ou E)' });
      return;
    }
    if (!formData.descricao.trim()) {
      setToast({ type: 'error', message: 'A descrição é obrigatória (ex: BBCH06)' });
      return;
    }
    const locsCentrais = parseCentralBulkText(centralBulkText);
    const codigoU = formData.codigo.trim().toUpperCase();
    const payload = {
      codigo: formData.codigo.trim(),
      descricao: formData.descricao.trim(),
      tipo: formData.tipo,
      armazem_central_vinculado_id:
        formData.tipo === 'apeado' || formData.tipo === 'epi'
          ? (formData.armazem_central_vinculado_id ? parseInt(formData.armazem_central_vinculado_id, 10) : null)
          : null,
      localizacoes:
        formData.tipo === 'viatura'
          ? [
              { localizacao: codigoU, tipo_localizacao: 'normal' },
              { localizacao: codigoU + '.FERR', tipo_localizacao: 'FERR' }
            ]
          : formData.tipo === 'apeado' || formData.tipo === 'epi'
            ? [{ localizacao: codigoU, tipo_localizacao: 'normal' }]
            : locsCentrais
    };
    if ((formData.tipo === 'apeado' || formData.tipo === 'epi') && !payload.armazem_central_vinculado_id) {
      setToast({ type: 'error', message: 'Selecione o armazém central vinculado.' });
      return;
    }
    if (formData.tipo === 'central') {
      const hasRecebimento = payload.localizacoes.some(l => l.tipo_localizacao === 'recebimento');
      const hasExpedicao = payload.localizacoes.some(l => l.tipo_localizacao === 'expedicao');
      if (!hasRecebimento || !hasExpedicao) {
        setToast({ type: 'error', message: 'Armazém central deve ter pelo menos uma localização de Recebimento e uma ou mais de Expedição.' });
        return;
      }
    }

    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');
      const config = {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      };

      if (editandoId) {
        await axios.put(`/api/armazens/${editandoId}`, payload, config);
        setToast({ type: 'success', message: 'Armazém atualizado com sucesso!' });
      } else {
        const res = await axios.post('/api/armazens', payload, config);
        setToast({
          type: res.data?.warning ? 'error' : 'success',
          message: res.data?.warning || 'Armazém criado com sucesso!'
        });
      }

      setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [], armazem_central_vinculado_id: '' });
      setCentralBulkText('');
      setEditandoId(null);
      setMostrarForm(false);
      fetchArmazens();
    } catch (error) {
      const data = error.response?.data;
      let msg = data?.error || 'Erro ao salvar armazém';
      if (data?.details) msg += ': ' + data.details;
      setToast({ type: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (armazem) => {
    const requestedId = armazem?.id;
    if (requestedId == null) {
      setToast({ type: 'error', message: 'Armazém sem ID. Recarregue a lista.' });
      return;
    }
    setEditandoId(null);
    setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [], armazem_central_vinculado_id: '' });
    setCentralBulkText('');
    setLoadingEdit(true);
    setMostrarForm(true);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`/api/armazens/${requestedId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = response.data;
      if (data.id != null && String(data.id) !== String(requestedId)) {
        setMostrarForm(false);
        return;
      }
      const locs = (data.localizacoes || []).map(l => {
        let locStr = '';
        let tipoLoc = 'normal';
        if (typeof l === 'object' && l !== null) {
          locStr = (l.localizacao != null) ? String(l.localizacao).trim() : '';
          tipoLoc = (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal';
        } else if (typeof l === 'string') {
          const trimmed = l.trim();
          if (trimmed.startsWith('{')) {
            try {
              const parsed = JSON.parse(trimmed);
              locStr = (parsed.localizacao != null) ? String(parsed.localizacao).trim() : trimmed;
              tipoLoc = (parsed.tipo_localizacao === 'recebimento' || parsed.tipo_localizacao === 'expedicao' || parsed.tipo_localizacao === 'FERR') ? parsed.tipo_localizacao : 'normal';
            } catch (_) {
              locStr = trimmed;
            }
          } else {
            locStr = trimmed;
            tipoLoc = trimmed.toUpperCase().includes('.FERR') ? 'FERR' : 'normal';
          }
        }
        return { localizacao: locStr, tipo_localizacao: tipoLoc };
      }).filter(l => l.localizacao !== '');
      if (data.localizacao && !locs.length) locs.push({ localizacao: String(data.localizacao).trim(), tipo_localizacao: 'normal' });
      const tipoFromApi =
        data.tipo === 'central' || data.tipo === 'viatura' || data.tipo === 'apeado' || data.tipo === 'epi'
          ? data.tipo
          : null;
      const hasRecebimentoOuExpedicao = locs.some(l => l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao');
      const tipo =
        tipoFromApi ??
        (locs.length > 2 || hasRecebimentoOuExpedicao
          ? 'central'
          : locs.length === 2
            ? 'viatura'
            : locs.length === 1
              ? 'apeado'
              : 'viatura');
      const locsForForm =
        tipo === 'central'
          ? locs.length > 0
            ? locs
            : [{ localizacao: '', tipo_localizacao: 'normal' }]
          : tipo === 'apeado' || tipo === 'epi'
            ? [{ localizacao: (data.codigo || locs[0]?.localizacao || '').toString().trim(), tipo_localizacao: 'normal' }]
            : locs;
      setFormData({
        codigo: data.codigo || '',
        descricao: data.descricao || '',
        tipo,
        localizacoes: locsForForm,
        armazem_central_vinculado_id:
          data.armazem_central_vinculado_id != null ? String(data.armazem_central_vinculado_id) : ''
      });
      if (tipo === 'central') {
        setCentralBulkText(buildCentralBulkText(locs));
      } else {
        setCentralBulkText('');
      }
      setEditandoId(data.id);
      setCentralLocSearch('');
      setCentralLocTipoFiltro('todos');
    } catch (error) {
      console.error('Erro ao carregar armazém:', error);
      setToast({ type: 'error', message: 'Erro ao carregar dados do armazém' });
      setMostrarForm(false);
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleCancel = () => {
    setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [], armazem_central_vinculado_id: '' });
    setCentralBulkText('');
    setEditingLocIdx(null);
    setEditingLocValue('');
    setEditingLocTipo('normal');
    setCentralLocSearch('');
    setCentralLocTipoFiltro('todos');
    setEditandoId(null);
    setMostrarForm(false);
  };

  const parsedCentralLocs = useMemo(
    () => parseCentralBulkText(centralBulkText),
    [centralBulkText]
  );

  const filteredCentralLocRows = useMemo(() => {
    const q = normalizeSearch(centralLocSearch.trim());
    return parsedCentralLocs
      .map((loc, idx) => ({ loc, idx }))
      .filter(({ loc }) => {
        if (centralLocTipoFiltro !== 'todos') {
          const t = String(loc.tipo_localizacao || 'normal');
          if (centralLocTipoFiltro === 'ferr') {
            if (t !== 'FERR') return false;
          } else if (t !== centralLocTipoFiltro) {
            return false;
          }
        }
        if (!q) return true;
        return normalizeSearch(String(loc.localizacao || '')).includes(q);
      });
  }, [parsedCentralLocs, centralLocSearch, centralLocTipoFiltro]);

  const applyLocList = (list) => {
    setCentralBulkText((list || []).map(formatLocLine).join('\n'));
    setEditingLocIdx(null);
    setEditingLocValue('');
    setEditingLocTipo('normal');
  };

  const selectLocForEdit = (idx) => {
    const item = parsedCentralLocs[idx];
    if (!item) return;
    setEditingLocIdx(idx);
    setEditingLocValue(String(item.localizacao || ''));
    setEditingLocTipo(item.tipo_localizacao || 'normal');
  };

  const startCreateLoc = () => {
    setEditingLocIdx(-1); // modo criação
    setEditingLocValue('');
    setEditingLocTipo('normal');
  };

  const saveLocEdit = () => {
    const loc = String(editingLocValue || '').trim();
    if (!loc) {
      setToast({ type: 'error', message: 'A localização não pode ficar vazia.' });
      return;
    }
    const tipo = editingLocTipo || 'normal';
    const next = [...parsedCentralLocs];
    if (editingLocIdx === -1 || editingLocIdx === null) {
      next.push({ localizacao: loc, tipo_localizacao: tipo });
    } else {
      next[editingLocIdx] = { localizacao: loc, tipo_localizacao: tipo };
    }
    applyLocList(next);
  };

  const deleteLocEdit = async () => {
    if (editingLocIdx === null || editingLocIdx < 0) return;
    const ok = await confirm({
      title: 'Apagar localização',
      message: 'Deseja apagar a localização selecionada?',
      variant: 'danger'
    });
    if (!ok) return;
    const next = parsedCentralLocs.filter((_, idx) => idx !== editingLocIdx);
    applyLocList(next);
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Excluir armazém',
      message: 'Tem certeza que deseja excluir este armazém?',
      variant: 'danger'
    });
    if (!ok) return;

    try {
      const token = localStorage.getItem('token');
      await axios.delete(`/api/armazens/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      setToast({ type: 'success', message: 'Armazém excluído com sucesso' });
      fetchArmazens();
    } catch (error) {
      const d = error.response?.data;
      const msg =
        d?.details && d?.error
          ? `${d.error} ${d.details}`
          : d?.error || 'Erro ao excluir armazém';
      setToast({ type: 'error', message: msg });
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const armazensFiltrados = useMemo(
    () =>
      (armazens || [])
        .filter((a) => {
          if (tipoFiltro !== 'todos' && (a.tipo || '') !== tipoFiltro) return false;
          const q = normalizeSearch(searchTerm.trim());
          if (!q) return true;

          const locs = a.localizacoes || (a.localizacao ? [{ localizacao: a.localizacao, tipo_localizacao: 'normal' }] : []);
          const locTexto = locs
            .map((l) => (typeof l === 'object' && l !== null ? l.localizacao : l))
            .filter(Boolean)
            .join(' ');
          const target = normalizeSearch([a.codigo, a.descricao, a.tipo, locTexto].join(' '));
          return target.includes(q);
        })
        .sort((a, b) => {
          const ac = String(a?.codigo || '');
          const bc = String(b?.codigo || '');
          return ac.localeCompare(bc, 'pt', { numeric: true, sensitivity: 'base' });
        }),
    [armazens, searchTerm, tipoFiltro]
  );

  const totalCentrais = useMemo(
    () => (armazens || []).filter((a) => a.tipo === 'central').length,
    [armazens]
  );
  const totalViaturas = useMemo(
    () => (armazens || []).filter((a) => a.tipo === 'viatura').length,
    [armazens]
  );
  const totalApeado = useMemo(
    () => (armazens || []).filter((a) => a.tipo === 'apeado').length,
    [armazens]
  );
  const totalEpi = useMemo(
    () => (armazens || []).filter((a) => a.tipo === 'epi').length,
    [armazens]
  );
  const armazensCentrais = useMemo(
    () =>
      (armazens || [])
        .filter((a) => a.tipo === 'central' && a.ativo !== false)
        .sort((a, b) => String(a?.codigo || '').localeCompare(String(b?.codigo || ''), 'pt', { numeric: true, sensitivity: 'base' })),
    [armazens]
  );
  const centralById = useMemo(() => {
    const m = new Map();
    for (const a of armazensCentrais) m.set(String(a.id), a);
    return m;
  }, [armazensCentrais]);

  const listaTotalPages = Math.max(1, Math.ceil(armazensFiltrados.length / LIST_PAGE_SIZE));
  const listaPage = Math.min(listPage, listaTotalPages);

  const armazensPagina = useMemo(() => {
    const start = (listaPage - 1) * LIST_PAGE_SIZE;
    return armazensFiltrados.slice(start, start + LIST_PAGE_SIZE);
  }, [armazensFiltrados, listaPage]);

  useEffect(() => {
    setListPage(1);
  }, [searchTerm, tipoFiltro]);

  useEffect(() => {
    setListPage((p) => Math.min(p, Math.max(1, Math.ceil(armazensFiltrados.length / LIST_PAGE_SIZE))));
  }, [armazensFiltrados.length]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto" />
          <p className="mt-4 text-gray-600">Carregando armazéns...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Armazéns</h1>
            <p className="text-gray-600">
              {isAdminArmazens
                ? 'Cadastre e gerencie os armazéns de destino das requisições'
                : 'Consulta dos armazéns. Criar, editar ou eliminar: apenas administradores.'}
            </p>
          </div>
          {isAdminArmazens && (
            <button
              type="button"
              onClick={() => {
                handleCancel();
                setMostrarForm(!mostrarForm);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors"
            >
              <FaPlus />
              {mostrarForm ? 'Cancelar' : 'Novo Armazém'}
            </button>
          )}
        </div>

        {isAdminArmazens && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
            <h2 className="text-sm font-semibold text-gray-800 mb-1">Importar viaturas (ficheiro)</h2>
            <p className="text-xs text-gray-500 mb-3">
              Colunas obrigatórias: <strong>codigo</strong> e <strong>descricao</strong> (CSV com <code className="text-[11px] bg-gray-100 px-1 rounded">;</code> ou{' '}
              <code className="text-[11px] bg-gray-100 px-1 rounded">,</code>, ou Excel). Por cada linha são criadas as localizações{' '}
              <span className="font-mono">CODIGO</span> e <span className="font-mono">CODIGO.FERR</span>.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 cursor-pointer text-sm">
                <FaFileUpload className="text-gray-600" />
                <span>{importingViaturaFile ? 'A importar…' : 'Escolher ficheiro (CSV/XLSX)'}</span>
                <input
                  type="file"
                  accept=".csv,.txt,.xlsx,.xls"
                  className="hidden"
                  disabled={importingViaturaFile}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) await handleImportViaturaFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button
                type="button"
                onClick={handleDownloadViaturaTemplate}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[#0915FF] text-[#0915FF] bg-white hover:bg-[#0915FF]/5 text-sm"
              >
                Baixar modelo
              </button>
            </div>
          </div>
        )}

        {showFormularioArmazem && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
            {loadingEdit ? (
              <div className="flex items-center gap-2 text-gray-600 py-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#0915FF]" />
                Carregando dados do armazém...
              </div>
            ) : (
            <>
            <h2 className="text-lg font-semibold text-gray-800 mb-4">
              {editandoId ? 'Editar Armazém' : 'Criar Armazém'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tipo de armazém <span className="text-red-500">*</span>
                </label>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="viatura"
                      checked={formData.tipo === 'viatura'}
                      onChange={() => setFormData(prev => ({ ...prev, tipo: 'viatura', localizacoes: [], armazem_central_vinculado_id: '' }))}
                      className="text-[#0915FF]"
                    />
                    <span>Viatura</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="central"
                      checked={formData.tipo === 'central'}
                      onChange={() => setFormData(prev => ({
                        ...prev,
                        tipo: 'central',
                        localizacoes: prev.localizacoes.length ? prev.localizacoes : [{ localizacao: '', tipo_localizacao: 'normal' }],
                        armazem_central_vinculado_id: ''
                      }))}
                      className="text-[#0915FF]"
                    />
                    <span>Central</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="apeado"
                      checked={formData.tipo === 'apeado'}
                      onChange={() => setFormData(prev => ({ ...prev, tipo: 'apeado', localizacoes: [] }))}
                      className="text-[#0915FF]"
                    />
                    <span>APEADO</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="epi"
                      checked={formData.tipo === 'epi'}
                      onChange={() => setFormData(prev => ({ ...prev, tipo: 'epi', localizacoes: [] }))}
                      className="text-[#0915FF]"
                    />
                    <span>EPI</span>
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Viatura: 2 localizações (uma .FERR). Central: várias localizações, com Recebimento e Expedição. APEADO e EPI: uma única localização, igual ao código do armazém.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Código <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="codigo"
                  value={formData.codigo}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  placeholder={
                    formData.tipo === 'viatura'
                      ? 'Ex: V848'
                      : formData.tipo === 'central'
                        ? 'Ex: E'
                        : 'Ex: APE1'
                  }
                />
                <p className="mt-1 text-xs text-gray-500">
                  Código do armazém (ex: V848 para viatura, E para central; APEADO/EPI usam o mesmo valor como localização)
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Descrição <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="descricao"
                  value={formData.descricao}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  placeholder="Ex: BBCH06"
                />
                <p className="mt-1 text-xs text-gray-500">Exibido como &quot;código - descrição&quot;</p>
              </div>
              {formData.tipo === 'viatura' && (
                <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Localizações (viatura)
                  </label>
                  <p className="text-xs text-gray-500 mb-2">A viatura tem sempre 2 localizações: uma base e uma .FERR</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600 w-32">Localização 1:</span>
                      <span className="font-mono bg-white px-2 py-1 rounded border border-gray-200">{formData.codigo ? formData.codigo.trim().toUpperCase() : '—'}</span>
                      <span className="text-xs text-gray-500">(normal)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600 w-32">Localização 2:</span>
                      <span className="font-mono bg-white px-2 py-1 rounded border border-gray-200">{formData.codigo ? formData.codigo.trim().toUpperCase() + '.FERR' : '—'}</span>
                      <span className="text-xs text-gray-500">(.FERR)</span>
                    </div>
                  </div>
                </div>
              )}
              {(formData.tipo === 'apeado' || formData.tipo === 'epi') && (
                <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Localização ({formData.tipo === 'apeado' ? 'APEADO' : 'EPI'})
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Uma única localização, sempre igual ao código do armazém (em maiúsculas).
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600 w-32">Localização:</span>
                    <span className="font-mono bg-white px-2 py-1 rounded border border-gray-200">
                      {formData.codigo ? formData.codigo.trim().toUpperCase() : '—'}
                    </span>
                    <span className="text-xs text-gray-500">(normal)</span>
                  </div>
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Armazém central vinculado <span className="text-red-500">*</span>
                    </label>
                    <select
                      name="armazem_central_vinculado_id"
                      value={formData.armazem_central_vinculado_id || ''}
                      onChange={handleChange}
                      required
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent bg-white"
                    >
                      <option value="">Selecione o armazém central</option>
                      {armazensCentrais.map((c) => (
                        <option key={c.id} value={String(c.id)}>
                          {c.codigo ? `${c.codigo} - ${c.descricao}` : c.descricao}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {formData.tipo === 'central' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Localizações (central) <span className="text-red-500">*</span>
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Obrigatório: pelo menos uma de Recebimento e uma ou mais de Expedição.
                  </p>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {isAdminArmazens && (
                        <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 cursor-pointer text-sm">
                          <span>{importingLocFile ? 'Importando...' : 'Importar ficheiro (CSV/XLSX)'}</span>
                          <input
                            type="file"
                            accept=".csv,.txt,.xlsx,.xls"
                            className="hidden"
                            disabled={importingLocFile}
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) await handleImportCentralFile(f);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      )}
                      {isAdminArmazens && (
                      <button
                        type="button"
                        onClick={handleDownloadCentralTemplate}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[#0915FF] text-[#0915FF] bg-white hover:bg-[#0915FF]/5 text-sm"
                      >
                        Baixar template
                      </button>
                      )}
                      <span className="text-xs text-gray-500">
                        Colunas esperadas: <strong>localizacao</strong> e <strong>tipo</strong> (N, EXP, REC)
                      </span>
                    </div>
                    <div className="text-xs text-gray-600">
                      {parsedCentralLocs.length} localização(ões) válidas detectadas.
                    </div>
                    <div className="mt-2 grid grid-cols-1 lg:grid-cols-3 gap-3">
                      <div className="lg:col-span-2">
                        <div className="rounded-lg border border-gray-200 bg-white">
                          <div className="px-3 py-2 border-b border-gray-100 space-y-2">
                            <div className="text-xs font-medium text-gray-700">Lista de localizações</div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <div className="flex-1 min-w-0">
                                <PesquisaComLeitorQr
                                  value={centralLocSearch}
                                  onChange={(e) => setCentralLocSearch(e.target.value)}
                                  placeholder="Pesquisar localização..."
                                  onLerClick={() => openArmQr('centralLoc')}
                                  lerTitle="Ler texto para filtrar localização (QR ou código de barras)"
                                  lerAriaLabel="Ler QR ou código de barras para filtrar localização"
                                />
                              </div>
                              <select
                                value={centralLocTipoFiltro}
                                onChange={(e) => setCentralLocTipoFiltro(e.target.value)}
                                className="w-full sm:w-[11rem] shrink-0 px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] bg-white"
                                aria-label="Filtrar por tipo de localização"
                              >
                                <option value="todos">Todos os tipos</option>
                                <option value="normal">Normal</option>
                                <option value="expedicao">Expedição</option>
                                <option value="recebimento">Recebimento</option>
                                <option value="ferr">.FERR</option>
                              </select>
                            </div>
                          </div>
                          <div className="max-h-64 overflow-auto">
                            {parsedCentralLocs.length === 0 ? (
                              <div className="px-3 py-3 text-sm text-gray-500">Sem localizações para mostrar.</div>
                            ) : filteredCentralLocRows.length === 0 ? (
                              <div className="px-3 py-3 text-sm text-gray-500">Nenhum resultado para a pesquisa ou filtro.</div>
                            ) : (
                              <ul className="divide-y divide-gray-100">
                                {filteredCentralLocRows.map(({ loc, idx }) => {
                                  const selected = editingLocIdx === idx;
                                  return (
                                    <li
                                      key={`${idx}-${loc.tipo_localizacao}-${loc.localizacao}`}
                                      onClick={() => selectLocForEdit(idx)}
                                      className={`px-3 py-2 text-sm cursor-pointer ${selected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                                      title="Clique para editar"
                                    >
                                      <span className="font-mono">{loc.localizacao}</span>
                                      <span className="ml-2 text-xs text-gray-500 uppercase">({loc.tipo_localizacao})</span>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={startCreateLoc}
                          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                        >
                          Nova localização
                        </button>
                        <input
                          type="text"
                          value={editingLocValue}
                          onChange={(e) => setEditingLocValue(e.target.value)}
                          placeholder="LOCALIZACAO"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                          disabled={editingLocIdx === null}
                        />
                        <select
                          value={editingLocTipo}
                          onChange={(e) => setEditingLocTipo(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                          disabled={editingLocIdx === null}
                        >
                          <option value="normal">Normal</option>
                          <option value="expedicao">Expedição</option>
                          <option value="recebimento">Recebimento</option>
                        </select>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={saveLocEdit}
                            disabled={editingLocIdx === null}
                            className="flex-1 px-3 py-2 rounded-lg bg-[#0915FF] text-white hover:bg-[#070FCC] disabled:opacity-50"
                          >
                            Gravar
                          </button>
                          <button
                            type="button"
                            onClick={deleteLocEdit}
                            disabled={editingLocIdx === null || editingLocIdx === -1}
                            className="px-3 py-2 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            Apagar
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] disabled:opacity-50 flex items-center gap-2"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <FaWarehouse />
                      {editandoId ? 'Salvar' : 'Criar Armazém'}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
              </div>
            </form>
            </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <button
            type="button"
            onClick={() => setTipoFiltro('todos')}
            className={`text-left rounded-xl border p-5 shadow-sm transition-all ${
              tipoFiltro === 'todos'
                ? 'bg-[#0915FF]/10 border-[#0915FF] text-[#0915FF]'
                : 'bg-white border-gray-200 text-gray-800 hover:shadow-md'
            }`}
          >
            <div className="text-sm font-semibold opacity-90">Todos</div>
            <div className="mt-2 text-3xl font-bold">{armazens.length}</div>
          </button>
          <button
            type="button"
            onClick={() => setTipoFiltro('central')}
            className={`text-left rounded-xl border p-5 shadow-sm transition-all ${
              tipoFiltro === 'central'
                ? 'bg-blue-50 border-blue-300 text-blue-800'
                : 'bg-white border-gray-200 text-gray-800 hover:shadow-md'
            }`}
          >
            <div className="text-sm font-semibold opacity-90">Armazéns Centrais</div>
            <div className="mt-2 text-3xl font-bold">{totalCentrais}</div>
          </button>
          <button
            type="button"
            onClick={() => setTipoFiltro('viatura')}
            className={`text-left rounded-xl border p-5 shadow-sm transition-all ${
              tipoFiltro === 'viatura'
                ? 'bg-amber-50 border-amber-300 text-amber-800'
                : 'bg-white border-gray-200 text-gray-800 hover:shadow-md'
            }`}
          >
            <div className="text-sm font-semibold opacity-90">Viaturas</div>
            <div className="mt-2 text-3xl font-bold">{totalViaturas}</div>
          </button>
          <button
            type="button"
            onClick={() => setTipoFiltro('apeado')}
            className={`text-left rounded-xl border p-5 shadow-sm transition-all ${
              tipoFiltro === 'apeado'
                ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                : 'bg-white border-gray-200 text-gray-800 hover:shadow-md'
            }`}
          >
            <div className="text-sm font-semibold opacity-90">APEADO</div>
            <div className="mt-2 text-3xl font-bold">{totalApeado}</div>
          </button>
          <button
            type="button"
            onClick={() => setTipoFiltro('epi')}
            className={`text-left rounded-xl border p-5 shadow-sm transition-all ${
              tipoFiltro === 'epi'
                ? 'bg-violet-50 border-violet-300 text-violet-900'
                : 'bg-white border-gray-200 text-gray-800 hover:shadow-md'
            }`}
          >
            <div className="text-sm font-semibold opacity-90">EPI</div>
            <div className="mt-2 text-3xl font-bold">{totalEpi}</div>
          </button>
        </div>

        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
              <div className="w-full lg:max-w-xl min-w-0">
                <PesquisaComLeitorQr
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar por código, descrição, tipo ou localização..."
                  onLerClick={() => openArmQr('listaArmazens')}
                  lerTitle="Ler texto para filtrar armazéns (QR ou código de barras)"
                  lerAriaLabel="Ler QR ou código de barras para filtrar lista de armazéns"
                />
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-600">
              {armazensFiltrados.length === 0 ? (
                <>0 armazéns encontrados</>
              ) : (
                <>
                  {armazensFiltrados.length} armazém(ns) encontrado(s)
                  {armazensFiltrados.length > LIST_PAGE_SIZE && (
                    <span className="text-gray-500">
                      {' '}
                      · Mostrando {(listaPage - 1) * LIST_PAGE_SIZE + 1}–
                      {Math.min(listaPage * LIST_PAGE_SIZE, armazensFiltrados.length)} (página {listaPage} de {listaTotalPages})
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {armazensFiltrados.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <FaWarehouse className="mx-auto text-4xl text-gray-300 mb-4" />
              <p className="text-lg">Nenhum armazém encontrado</p>
              {isAdminArmazens && (
                <button
                  type="button"
                  onClick={() => setMostrarForm(true)}
                  className="mt-4 text-[#0915FF] hover:underline"
                >
                  Criar primeiro armazém
                </button>
              )}
            </div>
          ) : (
            <div className="max-h-[min(420px,52vh)] overflow-y-auto overscroll-contain">
              <ul className="divide-y divide-gray-200">
                {armazensPagina.map((armazem) => {
                  const locs = armazem.localizacoes || (armazem.localizacao ? [{ localizacao: armazem.localizacao, tipo_localizacao: 'normal' }] : []);
                  const numLocs = locs.length;
                  const rawPreview = locs
                    .map((l) => (typeof l === 'object' && l !== null && l.localizacao != null ? l.localizacao : (typeof l === 'string' ? l : '')))
                    .filter(Boolean)
                    .slice(0, 2)
                    .join(' · ');
                  let locPreview = rawPreview;
                  if (locPreview.length > MAX_LOC_PREVIEW_LEN) {
                    locPreview = `${locPreview.slice(0, MAX_LOC_PREVIEW_LEN)}…`;
                  }
                  const titulo = armazem.codigo ? `${armazem.codigo} — ${armazem.descricao}` : armazem.descricao;
                  const centralVinculado = (armazem.tipo === 'apeado' || armazem.tipo === 'epi')
                    ? centralById.get(String(armazem.armazem_central_vinculado_id || ''))
                    : null;
                  return (
                    <li key={armazem.id} className="px-3 py-2 sm:py-2.5 hover:bg-gray-50">
                      <div className="flex items-start gap-2 min-w-0">
                        <FaWarehouse className="text-[#0915FF] shrink-0 mt-0.5 text-sm opacity-90" />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                            <span className="font-medium text-gray-900 truncate" title={titulo}>
                              {titulo}
                            </span>
                            {(armazem.tipo === 'central' ||
                              armazem.tipo === 'viatura' ||
                              armazem.tipo === 'apeado' ||
                              armazem.tipo === 'epi') && (
                              <span
                                className={`shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wide rounded ${
                                  armazem.tipo === 'central'
                                    ? 'bg-blue-100 text-blue-800'
                                    : armazem.tipo === 'viatura'
                                      ? 'bg-amber-100 text-amber-800'
                                      : armazem.tipo === 'apeado'
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : 'bg-violet-100 text-violet-800'
                                }`}
                              >
                                {armazem.tipo === 'central'
                                  ? 'Central'
                                  : armazem.tipo === 'viatura'
                                    ? 'Viatura'
                                    : armazem.tipo === 'apeado'
                                      ? 'APEADO'
                                      : 'EPI'}
                              </span>
                            )}
                            {armazem.ativo === false && (
                              <span className="shrink-0 px-1.5 py-0 text-[10px] bg-gray-200 text-gray-600 rounded">Inativo</span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 mt-0.5 truncate" title={locPreview ? `${numLocs} loc. · ${rawPreview}` : `${numLocs} loc.`}>
                            <span className="tabular-nums">{numLocs}</span> loc.
                            {locPreview ? (
                              <span className="text-gray-400"> · {locPreview}{numLocs > 2 ? '…' : ''}</span>
                            ) : null}
                          </p>
                          {(armazem.tipo === 'apeado' || armazem.tipo === 'epi') && (
                            <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                              Central vinculada:{' '}
                              <span className="text-gray-700">
                                {centralVinculado
                                  ? (centralVinculado.codigo ? `${centralVinculado.codigo} — ${centralVinculado.descricao}` : centralVinculado.descricao)
                                  : '—'}
                              </span>
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-0.5" onClick={(e) => e.stopPropagation()}>
                          {podeGerirEstoqueLocal && armazem.tipo === 'central' && locacoesComId(armazem).length > 0 && (
                            <button
                              type="button"
                              onClick={() => openEstoqueModal(armazem)}
                              className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-md transition-colors"
                              title="Estoque por localização (armazém central) — administrador"
                            >
                              <FaLayerGroup className="text-sm" />
                            </button>
                          )}
                        {isAdminArmazens && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleEdit(armazem)}
                              className="p-1.5 text-[#0915FF] hover:bg-[#0915FF]/10 rounded-md transition-colors"
                              title="Editar"
                            >
                              <FaEdit className="text-sm" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(armazem.id)}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                              title="Excluir"
                            >
                              <FaTrash className="text-sm" />
                            </button>
                          </>
                        )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {armazensFiltrados.length > LIST_PAGE_SIZE && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-gray-100 bg-gray-50/80">
              <span className="text-xs text-gray-600">
                Página {listaPage} de {listaTotalPages} · {LIST_PAGE_SIZE} por página
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setListPage((p) => Math.max(1, p - 1))}
                  disabled={listaPage <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <FaChevronLeft className="text-xs" /> Anterior
                </button>
                <button
                  type="button"
                  onClick={() => setListPage((p) => Math.min(listaTotalPages, p + 1))}
                  disabled={listaPage >= listaTotalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
                >
                  Seguinte <FaChevronRight className="text-xs" />
                </button>
              </div>
            </div>
          )}
        </div>

        {estoqueOpen && estoqueArmazem && (
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="estoque-local-titulo"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeEstoqueModal();
            }}
          >
            <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col border border-gray-200">
              <div className="flex items-start justify-between gap-3 p-4 border-b border-gray-100">
                <div className="min-w-0">
                  <h2 id="estoque-local-titulo" className="text-lg font-semibold text-gray-900">
                    Estoque por localização (central)
                  </h2>
                  <p className="text-sm text-gray-600 mt-0.5 truncate" title={`${estoqueArmazem.codigo} — ${estoqueArmazem.descricao}`}>
                    {estoqueArmazem.codigo} — {estoqueArmazem.descricao}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeEstoqueModal}
                  className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"
                  aria-label="Fechar"
                >
                  <FaTimes />
                </button>
              </div>
              <div className="p-4 overflow-y-auto flex-1 space-y-4">
                {podeGerirEstoqueLocal && estoqueCentralTemRecebimento && (
                  <div className="rounded-xl border-2 border-emerald-300 bg-gradient-to-br from-emerald-50 via-white to-teal-50/40 p-4 shadow-sm">
                    <p className="text-sm font-semibold text-emerald-900">Lançamento automático no recebimento</p>
                    <p className="text-xs text-gray-700 mt-1.5 leading-relaxed">
                      Coloca de uma vez <strong>todos os artigos</strong> que tenham stock nacional associado a este armazém
                      (texto da importação ligado à <strong>descrição</strong> do central) com as respetivas{' '}
                      <strong>quantidades importadas</strong> na localização de <strong>recebimento</strong>. Os valores
                      anteriores no recebimento são <strong>substituídos</strong> por artigo; artigos sem linha nacional
                      correspondente não são alterados.
                    </p>
                    <button
                      type="button"
                      onClick={lancarTodoStockNacionalNoRecebimento}
                      disabled={estoqueNacionalLoading}
                      className="mt-3 w-full sm:w-auto px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 shadow-sm"
                    >
                      {estoqueNacionalLoading ? 'A lançar…' : 'Lançar todo o stock nacional no recebimento'}
                    </button>
                    <p className="text-[10px] text-gray-500 mt-2">
                      Depois do lançamento, a vista muda para o recebimento para conferir. Importação:{' '}
                      <Link to="/importar-stock-nacional" className="text-[#0915FF] hover:underline">
                        Stock nacional
                      </Link>
                      .
                    </p>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Localização</label>
                  <select
                    value={estoqueLocId}
                    onChange={(e) => setEstoqueLocId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#0915FF]"
                  >
                    {locacoesComId(estoqueArmazem).map((l) => (
                      <option key={l.id} value={String(l.id)}>
                        {l.localizacao}
                        {l.tipo_localizacao && l.tipo_localizacao !== 'normal'
                          ? ` (${l.tipo_localizacao})`
                          : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-gray-500">
                    Apenas armazéns <strong>centrais</strong>. Quantidades por artigo nesta localização. O stock nacional (
                    <Link to="/importar-stock-nacional" className="text-[#0915FF] hover:underline">
                      importação Excel
                    </Link>
                    ) usa o texto das colunas de armazém; a ligação ao central faz-se pela <strong>descrição</strong> do
                    armazém (igual às outras áreas da aplicação).
                  </p>
                  {podeGerirEstoqueLocal && estoqueLocEhRecebimento && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/80 p-3 space-y-2">
                      <p className="text-xs font-semibold text-amber-900">Recebimento · stock nacional</p>
                      <p className="text-[11px] text-amber-900/90">
                        Atualiza <strong>só esta localização de recebimento</strong> com as quantidades do stock nacional
                        dos artigos cuja coluna de armazém corresponde à descrição:{' '}
                        <span className="font-mono">{(estoqueArmazem.descricao || '').trim() || '—'}</span>.
                      </p>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <label className="text-[11px] text-gray-700 shrink-0">Modo:</label>
                        <select
                          value={estoqueNacionalModo}
                          onChange={(e) => setEstoqueNacionalModo(e.target.value)}
                          disabled={estoqueNacionalLoading}
                          className="flex-1 text-xs px-2 py-1.5 border border-amber-300 rounded-lg bg-white"
                        >
                          <option value="definir">Definir quantidade = stock nacional (substitui por artigo)</option>
                          <option value="somar">Somar stock nacional ao que já está no recebimento</option>
                        </select>
                        <button
                          type="button"
                          onClick={aplicarStockNacionalRecebimento}
                          disabled={estoqueNacionalLoading || estoqueLoading}
                          className="text-xs px-3 py-2 rounded-lg bg-amber-700 text-white font-medium hover:bg-amber-800 disabled:opacity-50 whitespace-nowrap"
                        >
                          {estoqueNacionalLoading ? 'A aplicar…' : 'Aplicar stock nacional'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {estoqueLoading ? (
                  <p className="text-sm text-gray-600">A carregar…</p>
                ) : (
                  <>
                    <div className="rounded-lg border border-gray-200 overflow-hidden">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs text-gray-600">
                          <tr>
                            <th className="px-3 py-2 font-medium">Código</th>
                            <th className="px-3 py-2 font-medium">Descrição</th>
                            <th className="px-3 py-2 font-medium w-28">Qtd</th>
                            {podeGerirEstoqueLocal && <th className="px-3 py-2 w-10" />}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {estoqueLinhas.length === 0 ? (
                            <tr>
                              <td colSpan={podeGerirEstoqueLocal ? 4 : 3} className="px-3 py-6 text-center text-gray-500">
                                Sem linhas. Adicione artigos abaixo.
                              </td>
                            </tr>
                          ) : (
                            estoqueLinhas.map((l) => (
                              <tr key={l.item_id}>
                                <td className="px-3 py-2 font-mono text-gray-900">{l.codigo}</td>
                                <td className="px-3 py-2 text-gray-700">{l.descricao}</td>
                                <td className="px-3 py-2">
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    value={l.quantidade}
                                    onChange={(e) => updateEstoqueQuantidade(l.item_id, e.target.value)}
                                    disabled={!podeGerirEstoqueLocal}
                                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm disabled:bg-gray-50"
                                  />
                                </td>
                                {podeGerirEstoqueLocal && (
                                  <td className="px-3 py-2">
                                    <button
                                      type="button"
                                      onClick={() => removeEstoqueLinha(l.item_id)}
                                      className="p-1 text-red-600 hover:bg-red-50 rounded"
                                      title="Remover linha"
                                    >
                                      <FaTrash className="text-xs" />
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    {podeGerirEstoqueLocal && (
                      <div className="rounded-lg border border-dashed border-gray-300 p-3 bg-gray-50/80">
                        <div className="text-xs font-semibold text-gray-700 mb-2">Adicionar artigo</div>
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
                          <div className="flex-1 min-w-0">
                            <PesquisaComLeitorQr
                              value={estoqueBuscaItem}
                              onChange={(e) => setEstoqueBuscaItem(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  buscarItensParaEstoque();
                                }
                              }}
                              placeholder="Código ou descrição…"
                              onLerClick={() => openArmQr('estoqueItem')}
                              disabled={estoqueBuscaLoading}
                              lerDisabled={estoqueBuscaLoading}
                              lerTitle="Ler QR ou código de barras do artigo"
                              lerAriaLabel="Ler QR ou código de barras para pesquisar artigo"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => buscarItensParaEstoque()}
                            disabled={estoqueBuscaLoading}
                            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 sm:self-stretch sm:h-auto"
                          >
                            {estoqueBuscaLoading ? '…' : 'Pesquisar'}
                          </button>
                          <input
                            type="number"
                            min="1"
                            step="any"
                            value={estoqueQtdAdd}
                            onChange={(e) => setEstoqueQtdAdd(e.target.value)}
                            className="w-full sm:w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                            title="Quantidade a somar"
                          />
                        </div>
                        {estoqueItensRes.length > 0 && (
                          <ul className="mt-2 max-h-36 overflow-y-auto divide-y divide-gray-200 border border-gray-200 rounded-lg bg-white">
                            {estoqueItensRes.map((it) => (
                              <li
                                key={it.id}
                                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                              >
                                <div className="min-w-0">
                                  <span className="font-mono font-medium">{it.codigo}</span>
                                  <span className="text-gray-600 ml-2 truncate block sm:inline">
                                    {it.descricao || it.nome || ''}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => adicionarItemAoEstoqueLocal(it)}
                                  className="shrink-0 px-2 py-1 text-xs bg-[#0915FF] text-white rounded hover:bg-[#070FCC]"
                                >
                                  Adicionar
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="p-4 border-t border-gray-100 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={closeEstoqueModal}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
                >
                  Fechar
                </button>
                {podeGerirEstoqueLocal && (
                  <button
                    type="button"
                    onClick={saveEstoqueLinhas}
                    disabled={estoqueSaving || estoqueLoading || !estoqueLocId}
                    className="px-4 py-2 bg-[#0915FF] text-white rounded-lg text-sm hover:bg-[#070FCC] disabled:opacity-50"
                  >
                    {estoqueSaving ? 'A guardar…' : 'Guardar estoque'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <QrScannerModal
          open={armQrOpen}
          onClose={() => {
            armQrPurposeRef.current = null;
            setArmQrPurpose(null);
            setArmQrOpen(false);
          }}
          onScan={processarArmQrScan}
          title={
            armQrPurpose === 'centralLoc'
              ? 'Ler texto para filtrar localização (QR ou código de barras)'
              : armQrPurpose === 'listaArmazens'
                ? 'Ler texto para filtrar armazéns (QR ou código de barras)'
                : 'Ler código ou descrição do artigo (QR ou código de barras)'
          }
          readerId="qr-reader-armazens-contexto"
          formatsToSupport={FORMATOS_QR_BARCODE}
        />

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

export default Armazens;
