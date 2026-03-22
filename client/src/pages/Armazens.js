import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaPlus, FaEdit, FaTrash, FaWarehouse, FaSearch, FaFileUpload, FaChevronLeft, FaChevronRight } from 'react-icons/fa';
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
    tipo: 'viatura', // 'central' | 'viatura'
    localizacoes: []  // central: [{ localizacao, tipo_localizacao }]; viatura: preenchido com 2 (normal, FERR)
  });
  const [submitting, setSubmitting] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [tipoFiltro, setTipoFiltro] = useState('todos'); // todos | central | viatura
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
  const canManageArmazens = user && user.role === 'admin';

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
    const payload = {
      codigo: formData.codigo.trim(),
      descricao: formData.descricao.trim(),
      tipo: formData.tipo,
      localizacoes: formData.tipo === 'viatura'
        ? [
            { localizacao: formData.codigo.trim().toUpperCase(), tipo_localizacao: 'normal' },
            { localizacao: formData.codigo.trim().toUpperCase() + '.FERR', tipo_localizacao: 'FERR' }
          ]
        : locsCentrais
    };
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

      setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [] });
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
    setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [] });
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
      const tipoFromApi = (data.tipo === 'central' || data.tipo === 'viatura') ? data.tipo : null;
      const hasRecebimentoOuExpedicao = locs.some(l => l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao');
      const tipo = tipoFromApi ?? (locs.length > 2 || hasRecebimentoOuExpedicao ? 'central' : 'viatura');
      setFormData({
        codigo: data.codigo || '',
        descricao: data.descricao || '',
        tipo,
        localizacoes: tipo === 'central' ? (locs.length > 0 ? locs : [{ localizacao: '', tipo_localizacao: 'normal' }]) : locs
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
    setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [] });
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
      const msg = error.response?.data?.error || 'Erro ao excluir armazém';
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
            <p className="text-gray-600">Cadastre e gerencie os armazéns de destino das requisições</p>
          </div>
          {canManageArmazens && (
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

        {canManageArmazens && (
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

        {canManageArmazens && mostrarForm && (
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
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="viatura"
                      checked={formData.tipo === 'viatura'}
                      onChange={() => setFormData(prev => ({ ...prev, tipo: 'viatura', localizacoes: [] }))}
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
                        localizacoes: prev.localizacoes.length ? prev.localizacoes : [{ localizacao: '', tipo_localizacao: 'normal' }]
                      }))}
                      className="text-[#0915FF]"
                    />
                    <span>Central</span>
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Viatura: 2 localizações (uma .FERR). Central: várias localizações, com Recebimento e Expedição.
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
                  placeholder={formData.tipo === 'viatura' ? 'Ex: V848' : 'Ex: E'}
                />
                <p className="mt-1 text-xs text-gray-500">Código do armazém (ex: V848 para viatura, E para central)</p>
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
                      <button
                        type="button"
                        onClick={handleDownloadCentralTemplate}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[#0915FF] text-[#0915FF] bg-white hover:bg-[#0915FF]/5 text-sm"
                      >
                        Baixar template
                      </button>
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
                              <div className="relative flex-1 min-w-0">
                                <FaSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none" />
                                <input
                                  type="text"
                                  value={centralLocSearch}
                                  onChange={(e) => setCentralLocSearch(e.target.value)}
                                  placeholder="Pesquisar localização..."
                                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                                  autoComplete="off"
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
        </div>

        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-xl">
                <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar por código, descrição, tipo ou localização..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
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
              {canManageArmazens && (
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
                  return (
                    <li key={armazem.id} className="px-3 py-2 sm:py-2.5 hover:bg-gray-50">
                      <div className="flex items-start gap-2 min-w-0">
                        <FaWarehouse className="text-[#0915FF] shrink-0 mt-0.5 text-sm opacity-90" />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                            <span className="font-medium text-gray-900 truncate" title={titulo}>
                              {titulo}
                            </span>
                            {(armazem.tipo === 'central' || armazem.tipo === 'viatura') && (
                              <span className={`shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wide rounded ${armazem.tipo === 'central' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>
                                {armazem.tipo === 'central' ? 'Central' : 'Viatura'}
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
                        </div>
                        {canManageArmazens && (
                          <div className="flex shrink-0 gap-0.5" onClick={(e) => e.stopPropagation()}>
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
                          </div>
                        )}
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
