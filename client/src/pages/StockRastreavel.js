import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../contexts/AuthContext';

const formatQuantidadeConsulta = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (Math.abs(num - Math.trunc(num)) < 1e-9) return String(Math.trunc(num));
  return String(num);
};

const formatLocalizacaoView = (value) => {
  const text = String(value || '').trim();
  return text ? text.toUpperCase() : '—';
};

const formatUpperView = (value) => {
  const text = String(value || '').trim();
  return text ? text.toUpperCase() : '—';
};

const StockRastreavel = ({ mode = 'all' }) => {
  const { user } = useAuth();
  const [arquivo, setArquivo] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loadingImport, setLoadingImport] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [importMode, setImportMode] = useState('');
  const [caixaCodigo, setCaixaCodigo] = useState('');
  const [caixaData, setCaixaData] = useState(null);
  const [serialCodigo, setSerialCodigo] = useState('');
  const [serialData, setSerialData] = useState(null);
  const [itemId, setItemId] = useState('');
  const [armazemId, setArmazemId] = useState('');
  const [localizacao, setLocalizacao] = useState('');
  const [dispData, setDispData] = useState(null);
  const [erro, setErro] = useState('');
  const [importRows, setImportRows] = useState([]);
  const [somenteInvalidas, setSomenteInvalidas] = useState(false);
  const [fArmazemId, setFArmazemId] = useState('');
  const [fItemId, setFItemId] = useState('');
  const [fLocalizacao, setFLocalizacao] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [seriaisData, setSeriaisData] = useState(null);
  const [meusArmazens, setMeusArmazens] = useState([]);
  const [armazemSelecionadoId, setArmazemSelecionadoId] = useState('');
  const [importArmazemId, setImportArmazemId] = useState('');
  const [savingManual, setSavingManual] = useState(false);
  const [manualItemResultados, setManualItemResultados] = useState([]);
  const [manualItemLoading, setManualItemLoading] = useState(false);
  const [manualItemSelecionado, setManualItemSelecionado] = useState(null);
  const [manualItemDropdownOpen, setManualItemDropdownOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    modo: 'serial',
    armazem_id: '',
    artigo_codigo: '',
    localizacao: '',
    serialnumber: '',
    lote: '',
    quantidade: '1',
    caixa_codigo: '',
  });
  const [manualAdded, setManualAdded] = useState([]);
  const [deletingKey, setDeletingKey] = useState('');
  const isImportMode = mode === 'import';
  const isConsultaMode = mode === 'consulta';
  const isManualMode = mode === 'manual';
  const showImport = mode === 'all' || isImportMode;
  const showConsulta = mode === 'all' || isConsultaMode;
  const showManual = mode === 'all' || isManualMode;
  const isAdminUser = user?.role === 'admin';

  useEffect(() => {
    const loadMeusArmazens = async () => {
      if (!showConsulta && !showImport && !showManual) return;
      try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/requisicoes/stock/meus-armazens', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Erro ao carregar armazéns do utilizador');
        const rows = Array.isArray(data.rows) ? data.rows : [];
        setMeusArmazens(rows);
        if (rows.length === 1) {
          const id = String(rows[0].id);
          setImportArmazemId(id);
          setArmazemSelecionadoId(id);
          setFArmazemId(id);
          setArmazemId(id);
          setManualForm((prev) => ({ ...prev, armazem_id: id }));
        }
      } catch (e) {
        setErro(e.message || 'Erro ao carregar armazéns do utilizador');
      }
    };
    loadMeusArmazens();
  }, [showConsulta, showImport, showManual]);

  useEffect(() => {
    if (!armazemSelecionadoId) return;
    setFArmazemId(armazemSelecionadoId);
    setArmazemId(armazemSelecionadoId);
  }, [armazemSelecionadoId]);

  const handleManualChange = (field, value) => {
    if (field === 'artigo_codigo') {
      setManualItemSelecionado(null);
      setManualItemDropdownOpen(true);
    }
    if (field === 'serialnumber' || field === 'lote') {
      setManualForm((prev) => ({ ...prev, [field]: String(value || '').toUpperCase() }));
      return;
    }
    setManualForm((prev) => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    if (!showManual) return;
    const termo = String(manualForm.artigo_codigo || '').trim();
    if (termo.length < 2) {
      setManualItemResultados([]);
      setManualItemLoading(false);
      return;
    }
    let ativo = true;
    const timer = setTimeout(async () => {
      try {
        setManualItemLoading(true);
        const token = localStorage.getItem('token');
        const p = new URLSearchParams();
        p.set('search', termo);
        p.set('limit', '8');
        const response = await fetch(`/api/itens?${p.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Erro ao pesquisar itens');
        if (!ativo) return;
        const rows = Array.isArray(data.itens) ? data.itens : [];
        const filtrados = rows.filter((it) => {
          const tc = String(it?.tipocontrolo || '').trim().toUpperCase();
          return tc === 'S/N' || tc === 'LOTE';
        });
        setManualItemResultados(filtrados);
      } catch (_) {
        if (!ativo) return;
        setManualItemResultados([]);
      } finally {
        if (ativo) setManualItemLoading(false);
      }
    }, 250);
    return () => {
      ativo = false;
      clearTimeout(timer);
    };
  }, [manualForm.artigo_codigo, showManual]);

  const tipoControloManual = String(
    manualItemSelecionado?.tipocontrolo ||
    manualItemResultados.find((it) => String(it.codigo || '').trim() === String(manualForm.artigo_codigo || '').trim())?.tipocontrolo ||
    ''
  ).toUpperCase();
  const manualAceitaSerial = tipoControloManual === 'S/N';
  const manualAceitaLote = tipoControloManual === 'LOTE';

  const cadastrarSerialManual = async () => {
    const isModoSerial = manualForm.modo === 'serial';
    if (!manualForm.armazem_id || !manualForm.artigo_codigo || !manualForm.localizacao) {
      setErro('Preencha armazém, artigo e localização.');
      return;
    }
    if (isModoSerial && !manualForm.serialnumber) {
      setErro('Preencha o serial number.');
      return;
    }
    if (!isModoSerial && !manualForm.lote) {
      setErro('Preencha o lote.');
      return;
    }
    if (!isModoSerial && (!Number.isFinite(Number(manualForm.quantidade)) || Number(manualForm.quantidade) <= 0)) {
      setErro('Informe uma quantidade válida para o lote.');
      return;
    }
    if (tipoControloManual && isModoSerial && !manualAceitaSerial) {
      setErro(`O item ${manualForm.artigo_codigo} não aceita cadastro por serial (controlo: ${tipoControloManual}).`);
      return;
    }
    if (tipoControloManual && !isModoSerial && !manualAceitaLote) {
      setErro(`O item ${manualForm.artigo_codigo} não aceita cadastro por lote (controlo: ${tipoControloManual}).`);
      return;
    }
    setErro('');
    setSavingManual(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/stock/serial/manual', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modo: manualForm.modo,
          armazem_id: manualForm.armazem_id,
          artigo_codigo: manualForm.artigo_codigo.trim(),
          localizacao: manualForm.localizacao.trim(),
          serialnumber: manualForm.serialnumber.trim(),
          lote: manualForm.lote.trim(),
          quantidade: Number(manualForm.quantidade || 0),
          caixa_codigo: isModoSerial ? (manualForm.caixa_codigo.trim() || null) : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao cadastrar serial');
      if (data?.row) {
        setManualAdded((prev) => [data.row, ...prev].slice(0, 12));
      }
      setManualForm((prev) => ({
        ...prev,
        serialnumber: '',
        lote: '',
        quantidade: prev.modo === 'lote' ? prev.quantidade : '1',
      }));
    } catch (e) {
      setErro(e.message || 'Erro ao cadastrar serial');
    } finally {
      setSavingManual(false);
    }
  };

  const callImport = async (mode) => {
    if (!importArmazemId) {
      setErro('Selecione o armazém que irá receber os seriais/lotes.');
      return;
    }
    if (!arquivo) return;
    setErro('');
    setImportStatus('');
    setImportMode(mode);
    setLoadingImport(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      fd.append('arquivo', arquivo);
      fd.append('armazem_id', importArmazemId);
      const response = await fetch(`/api/requisicoes/stock/import/${mode}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro na importação');
      setPreview(data);
      if (Array.isArray(data.rows)) setImportRows(data.rows);
      if (mode === 'preview') {
        setImportStatus(`Preview concluído: ${data.validas ?? 0} linha(s) válidas e ${data.invalidas ?? 0} inválida(s).`);
      } else {
        setImportStatus(`Importação concluída: ${data.importadas ?? 0} linha(s) importadas e ${data.ignoradas ?? 0} ignoradas.`);
      }
    } catch (e) {
      setErro(e.message || 'Erro na importação');
    } finally {
      setLoadingImport(false);
    }
  };

  const baixarTemplate = async () => {
    setErro('');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/stock/import/template', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao baixar template');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'template_import_stock_rastreavel.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setErro(e.message || 'Erro ao baixar template');
    }
  };

  const retryInvalidas = async () => {
    if (!preview?.erros?.length || !importRows.length) return;
    if (!importArmazemId) {
      setErro('Selecione o armazém que irá receber os seriais/lotes.');
      return;
    }
    setErro('');
    setImportStatus('');
    setImportMode('retry');
    setLoadingImport(true);
    try {
      const invalidLineSet = new Set(preview.erros.map((e) => Number(e.linha)));
      const rowsRetry = importRows.filter((r) => invalidLineSet.has(Number(r.linha)));
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/stock/import/commit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows: rowsRetry, armazem_id: importArmazemId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao reprocessar inválidas');
      setPreview((prev) => ({
        ...(prev || {}),
        retry_result: data,
      }));
      setImportStatus(`Reprocessamento concluído: ${data.importadas || 0} linha(s) importadas e ${data.ignoradas || 0} ignoradas.`);
    } catch (e) {
      setErro(e.message || 'Erro ao reprocessar inválidas');
    } finally {
      setLoadingImport(false);
    }
  };

  const exportarInvalidasExcel = () => {
    if (!preview?.erros?.length || !importRows.length) return;
    const erroByLinha = new Map((preview.erros || []).map((e) => [Number(e.linha), String(e.erro || '')]));
    const invalidRows = importRows
      .filter((r) => erroByLinha.has(Number(r.linha)))
      .map((r) => ({
        linha: r.linha,
        erro: erroByLinha.get(Number(r.linha)) || '',
        artigo_codigo: r.artigoCodigo || '',
        serialnumber: r.serialnumber || '',
        lote: r.lote || '',
        quantidade: r.quantidade || '',
        localizacao: r.localizacao || '',
        caixa_codigo: r.caixaCodigo || '',
      }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(invalidRows);
    XLSX.utils.book_append_sheet(wb, ws, 'invalidas');
    XLSX.writeFile(wb, `stock_rastreavel_invalidas_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const consultarCaixa = async () => {
    setErro('');
    setCaixaData(null);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/stock/caixas/${encodeURIComponent(caixaCodigo)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao consultar caixa');
      setCaixaData(data);
    } catch (e) {
      setErro(e.message || 'Erro ao consultar caixa');
    }
  };

  const consultarSerial = async () => {
    if (!(armazemSelecionadoId || fArmazemId)) {
      setErro('Selecione um armazém para consultar serial.');
      return;
    }
    setErro('');
    setSerialData(null);
    try {
      const token = localStorage.getItem('token');
      const p = new URLSearchParams();
      p.set('armazem_id', armazemSelecionadoId || fArmazemId);
      const response = await fetch(`/api/requisicoes/stock/seriais/${encodeURIComponent(serialCodigo)}?${p.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao consultar serial');
      setSerialData(data);
    } catch (e) {
      setErro(e.message || 'Erro ao consultar serial');
    }
  };

  const consultarDisponibilidade = async () => {
    if (!(armazemSelecionadoId || armazemId)) {
      setErro('Selecione um armazém para consultar disponibilidade.');
      return;
    }
    setErro('');
    setDispData(null);
    try {
      const token = localStorage.getItem('token');
      const p = new URLSearchParams();
      p.set('item_id', itemId);
      p.set('armazem_id', armazemSelecionadoId || armazemId);
      if (localizacao) p.set('localizacao', localizacao);
      const response = await fetch(`/api/requisicoes/stock/disponibilidade?${p.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao consultar disponibilidade');
      setDispData(data);
    } catch (e) {
      setErro(e.message || 'Erro ao consultar disponibilidade');
    }
  };

  const consultarSeriaisPorArmazem = async () => {
    if (!(armazemSelecionadoId || fArmazemId)) {
      setErro('Selecione um armazém para consultar seriais.');
      return;
    }
    setErro('');
    setSeriaisData(null);
    try {
      const token = localStorage.getItem('token');
      const p = new URLSearchParams();
      p.set('armazem_id', armazemSelecionadoId || fArmazemId);
      const filtroArtigo = String(fItemId || '').trim();
      if (filtroArtigo) {
        p.set('item_codigo', filtroArtigo);
        if (/^\d+$/.test(filtroArtigo)) p.set('item_id', filtroArtigo);
      }
      if (fLocalizacao) p.set('localizacao', fLocalizacao);
      if (fStatus) p.set('status', fStatus);
      p.set('limit', '500');
      const response = await fetch(`/api/requisicoes/stock/seriais-por-armazem?${p.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao consultar seriais por armazém');
      setSeriaisData(data);
    } catch (e) {
      setErro(e.message || 'Erro ao consultar seriais por armazém');
    }
  };

  const apagarRegistroConsulta = async (row) => {
    if (!isAdminUser || !row) return;
    const tipo = String(row.tipo || (row.serialnumber ? 'serial' : 'lote')).toLowerCase();
    const identificador = tipo === 'serial' ? row.serialnumber : row.lote;
    const ok = window.confirm(`Deseja apagar ${tipo} "${identificador}" do banco? Esta ação não pode ser desfeita.`);
    if (!ok) return;
    setErro('');
    const key = `${tipo}-${row.id}`;
    setDeletingKey(key);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/requisicoes/stock/seriais-por-armazem', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tipo,
          item_id: row.item_id,
          armazem_id: armazemSelecionadoId || fArmazemId,
          localizacao: row.localizacao,
          serialnumber: row.serialnumber || null,
          lote: row.lote || null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao apagar registo');
      await consultarSeriaisPorArmazem();
    } catch (e) {
      setErro(e.message || 'Erro ao apagar registo');
    } finally {
      setDeletingKey('');
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-gray-800">Stock rastreável (S/N, lote, caixas)</h1>

        {showImport && (
        <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
          <h2 className="font-semibold text-gray-800">Importação inicial</h2>
          <div className="text-xs text-gray-500">
            Selecione o armazém de destino e importe ficheiro com colunas: artigo_codigo, serialnumber ou lote, quantidade (obrigatória para lote), caixa_codigo (opcional) e localizacao.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={importArmazemId}
              onChange={(e) => setImportArmazemId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded"
            >
              <option value="">Selecionar armazém de importação</option>
              {(meusArmazens || []).map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.codigo ? `${a.codigo} - ` : ''}{a.descricao || `Armazém ${a.id}`}
                </option>
              ))}
            </select>
            <div className="text-xs text-gray-500 self-center">
              O armazém selecionado será aplicado a todas as linhas do ficheiro.
            </div>
          </div>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setArquivo(e.target.files?.[0] || null)} />
          {arquivo && (
            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-2">
              Ficheiro selecionado: <strong>{arquivo.name}</strong>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={baixarTemplate}
              className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50"
            >
              Baixar template
            </button>
            <button
              type="button"
              onClick={() => callImport('preview')}
              disabled={loadingImport || !arquivo}
              className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            >
              {loadingImport && importMode === 'preview' ? 'A processar preview...' : 'Preview'}
            </button>
            <button
              type="button"
              onClick={() => callImport('commit')}
              disabled={loadingImport || !arquivo}
              className="px-3 py-2 bg-[#0915FF] text-white rounded hover:bg-[#070FCC] disabled:opacity-50"
            >
              {loadingImport && importMode === 'commit' ? 'A importar...' : 'Importar'}
            </button>
            <button
              type="button"
              onClick={retryInvalidas}
              disabled={loadingImport || !preview?.erros?.length}
              className="px-3 py-2 border border-amber-300 text-amber-800 rounded hover:bg-amber-50 disabled:opacity-50"
            >
              {loadingImport && importMode === 'retry' ? 'A reprocessar...' : 'Reprocessar inválidas'}
            </button>
            <button
              type="button"
              onClick={exportarInvalidasExcel}
              disabled={!preview?.erros?.length}
              className="px-3 py-2 border border-slate-300 text-slate-700 rounded hover:bg-slate-50 disabled:opacity-50"
            >
              Exportar inválidas (Excel)
            </button>
          </div>
          {loadingImport && (
            <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded p-3">
              A processar a importação. Aguarde...
            </div>
          )}
          {importStatus && !loadingImport && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3">
              {importStatus}
            </div>
          )}
          {preview && (
            <div className="space-y-2">
              <div className="text-sm text-gray-700">
                Total: <strong>{preview.total_linhas ?? preview.total ?? 0}</strong> ·
                Válidas: <strong>{preview.validas ?? preview.importadas ?? 0}</strong> ·
                Inválidas: <strong>{preview.invalidas ?? preview.ignoradas ?? 0}</strong>
              </div>
              {!!preview.retry_result && (
                <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-2">
                  Retry: importadas {preview.retry_result.importadas || 0}, ignoradas {preview.retry_result.ignoradas || 0}.
                </div>
              )}
              {(preview.erros || []).length > 0 && (
                <div className="border border-slate-200 rounded overflow-hidden">
                  <div className="p-2 bg-slate-50 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700">Erros por linha</span>
                    <label className="text-xs text-slate-600 inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={somenteInvalidas}
                        onChange={(e) => setSomenteInvalidas(e.target.checked)}
                      />
                      Mostrar só inválidas
                    </label>
                  </div>
                  <div className="max-h-64 overflow-auto">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-100">
                        <tr>
                          <th className="text-left px-2 py-1 border-b">Linha</th>
                          <th className="text-left px-2 py-1 border-b">Erro</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(preview.erros || []).map((e, idx) => (
                          <tr key={`${e.linha}-${idx}`} className="border-b last:border-b-0">
                            <td className="px-2 py-1">{e.linha}</td>
                            <td className="px-2 py-1">{e.erro}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {!somenteInvalidas && (
                <pre className="text-xs bg-slate-50 border border-slate-200 p-3 rounded overflow-auto max-h-40">
                  {JSON.stringify(preview, null, 2)}
                </pre>
              )}
            </div>
          )}
        </section>
        )}

        {showManual && (
        <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
          <div>
            <h2 className="font-semibold text-gray-800">Cadastro manual de serial</h2>
            <div className="text-xs text-gray-500 mt-1">
              Fluxo pensado para cadastro rápido: mantenha armazém, artigo, localização e caixa, e vá trocando apenas o serial number.
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
            <select
              value={manualForm.modo}
              onChange={(e) => setManualForm((prev) => ({
                ...prev,
                modo: e.target.value,
                serialnumber: '',
                lote: '',
                quantidade: e.target.value === 'lote' ? prev.quantidade || '1' : '1',
                caixa_codigo: e.target.value === 'serial' ? prev.caixa_codigo : '',
              }))}
              className="px-3 py-2 border border-gray-300 rounded"
            >
              <option value="serial">Adicionar serial</option>
              <option value="lote">Adicionar lote</option>
            </select>
            <select
              value={manualForm.armazem_id}
              onChange={(e) => handleManualChange('armazem_id', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded"
            >
              <option value="">Selecionar armazém</option>
              {(meusArmazens || []).map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.codigo ? `${a.codigo} - ` : ''}{a.descricao || `Armazém ${a.id}`}
                </option>
              ))}
            </select>
            <div className="relative">
              <input
                value={manualForm.artigo_codigo}
                onChange={(e) => handleManualChange('artigo_codigo', e.target.value)}
                onFocus={() => setManualItemDropdownOpen(true)}
                onBlur={() => setTimeout(() => setManualItemDropdownOpen(false), 120)}
                placeholder="Código do artigo"
                className="w-full px-3 py-2 border border-gray-300 rounded"
              />
              {manualItemDropdownOpen && manualItemResultados.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-40 overflow-auto border border-gray-200 rounded bg-white shadow-sm">
                  {manualItemResultados.map((it) => (
                    <button
                      type="button"
                      key={it.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setManualForm((prev) => ({ ...prev, artigo_codigo: String(it.codigo || '') }));
                        setManualItemSelecionado(it);
                        setManualItemDropdownOpen(false);
                      }}
                      className="w-full text-left px-2 py-1.5 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                    >
                      <div className="text-xs font-medium text-gray-800">{it.codigo}</div>
                      <div className="text-[11px] text-gray-600">{it.descricao || 'Sem descrição'}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              value={manualForm.localizacao}
              onChange={(e) => handleManualChange('localizacao', e.target.value)}
              placeholder="Localização"
              className="px-3 py-2 border border-gray-300 rounded"
            />
            {manualForm.modo === 'serial' ? (
              <>
                <input
                  value={manualForm.caixa_codigo}
                  onChange={(e) => handleManualChange('caixa_codigo', e.target.value)}
                  placeholder="Caixa (opcional)"
                  className="px-3 py-2 border border-gray-300 rounded"
                />
                <input
                  value={manualForm.serialnumber}
                  onChange={(e) => handleManualChange('serialnumber', e.target.value)}
                  placeholder="Serial number"
                  className="px-3 py-2 border-2 border-[#0915FF] rounded"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !savingManual) {
                      e.preventDefault();
                      cadastrarSerialManual();
                    }
                  }}
                />
              </>
            ) : (
              <>
                <input
                  value={manualForm.quantidade}
                  onChange={(e) => handleManualChange('quantidade', e.target.value)}
                  placeholder="Quantidade"
                  type="number"
                  min="0.001"
                  step="0.001"
                  className="px-3 py-2 border border-gray-300 rounded"
                />
                <input
                  value={manualForm.lote}
                  onChange={(e) => handleManualChange('lote', e.target.value)}
                  placeholder="Lote"
                  className="px-3 py-2 border-2 border-[#0915FF] rounded"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !savingManual) {
                      e.preventDefault();
                      cadastrarSerialManual();
                    }
                  }}
                />
              </>
            )}
          </div>
          <div className="text-[11px] text-gray-600 -mt-1">
            {manualItemLoading
              ? 'Pesquisando item...'
              : (manualItemSelecionado
                ? `${manualItemSelecionado.codigo || ''} - ${manualItemSelecionado.descricao || ''}`
                : 'Digite 2+ caracteres para pesquisar e selecionar o material.')}
            {tipoControloManual && (
              <>
                {' · '}
                Tipo de controlo: <strong>{tipoControloManual}</strong>{' '}
                {manualAceitaSerial && <span className="text-blue-700">· Aceita serial</span>}
                {manualAceitaLote && <span className="text-emerald-700">· Aceita lote</span>}
                {!manualAceitaSerial && !manualAceitaLote && <span className="text-amber-700">· Não aceita serial/lote</span>}
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              onClick={cadastrarSerialManual}
              disabled={savingManual}
              className="px-4 py-2 bg-[#0915FF] text-white rounded hover:bg-[#070FCC] disabled:opacity-50"
            >
              {savingManual ? 'A gravar...' : 'Adicionar serial'}
            </button>
            <button
              type="button"
              onClick={() => setManualForm((prev) => ({ ...prev, serialnumber: '' }))}
              disabled={savingManual}
              className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            >
              {manualForm.modo === 'serial' ? 'Limpar serial' : 'Limpar lote'}
            </button>
            <button
              type="button"
              onClick={() => setManualForm({
                modo: manualForm.modo,
                armazem_id: manualForm.armazem_id,
                artigo_codigo: '',
                localizacao: '',
                serialnumber: '',
                lote: '',
                quantidade: '1',
                caixa_codigo: '',
              })}
              disabled={savingManual}
              className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            >
              Novo contexto
            </button>
            <div className="text-xs text-gray-500">
              {manualForm.modo === 'serial'
                ? 'Dica: depois do primeiro registo, escreva apenas o próximo serial e prima `Enter`.'
                : 'Dica: para o mesmo artigo e localização, mude só o lote e a quantidade.'}
            </div>
          </div>
          {manualAdded.length > 0 && (
            <div className="border border-slate-200 rounded overflow-hidden">
              <div className="p-2 bg-slate-50 text-xs font-semibold text-slate-700">
                Últimos seriais adicionados
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="text-left px-2 py-1 border-b">Artigo</th>
                      <th className="text-left px-2 py-1 border-b">Tipo</th>
                      <th className="text-left px-2 py-1 border-b">Serial / Lote</th>
                      <th className="text-left px-2 py-1 border-b">Quantidade</th>
                      <th className="text-left px-2 py-1 border-b">Localização</th>
                      <th className="text-left px-2 py-1 border-b">Caixa</th>
                      <th className="text-left px-2 py-1 border-b">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manualAdded.map((r, idx) => (
                      <tr key={`${r.item_codigo}-${r.serialnumber}-${idx}`} className="border-b last:border-b-0">
                        <td className="px-2 py-1">
                          <div className="font-medium text-slate-800">{r.item_codigo}</div>
                          <div className="text-slate-500">{r.item_descricao || '—'}</div>
                        </td>
                        <td className="px-2 py-1 uppercase">{r.tipo || (r.serialnumber ? 'serial' : 'lote')}</td>
                        <td className="px-2 py-1">{formatUpperView(r.serialnumber || r.lote)}</td>
                        <td className="px-2 py-1">{formatQuantidadeConsulta(r.quantidade)}</td>
                        <td className="px-2 py-1">{formatLocalizacaoView(r.localizacao)}</td>
                        <td className="px-2 py-1">{r.caixa_codigo || '—'}</td>
                        <td className="px-2 py-1">{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
        )}

        {showConsulta && (
        <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
          <h2 className="font-semibold text-gray-800">Consulta de seriais e lotes por armazém</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={armazemSelecionadoId}
              onChange={(e) => setArmazemSelecionadoId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded"
              disabled={meusArmazens.length <= 1}
            >
              {meusArmazens.length > 1 && <option value="">Selecionar armazém</option>}
              {(meusArmazens || []).map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.codigo ? `${a.codigo} - ` : ''}{a.descricao || `Armazém ${a.id}`}
                </option>
              ))}
            </select>
            <div className="text-xs text-gray-500 self-center">
              {meusArmazens.length <= 1
                ? 'Armazém do utilizador aplicado automaticamente.'
                : 'Este utilizador possui mais de um armazém. Selecione para consultar.'}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            <input value={fItemId} onChange={(e) => setFItemId(e.target.value)} placeholder="código do artigo ou item_id (opcional)" className="px-3 py-2 border border-gray-300 rounded" />
            <input value={fLocalizacao} onChange={(e) => setFLocalizacao(e.target.value)} placeholder="localização (opcional)" className="px-3 py-2 border border-gray-300 rounded" />
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="px-3 py-2 border border-gray-300 rounded">
              <option value="">status (todos)</option>
              <option value="disponivel">disponivel</option>
              <option value="reservado">reservado</option>
              <option value="consumido">consumido</option>
            </select>
            <button type="button" onClick={consultarSeriaisPorArmazem} className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50">
              Consultar
            </button>
          </div>
          {seriaisData && (
            <div className="border border-slate-200 rounded overflow-hidden">
              <div className="p-2 bg-slate-50 text-xs text-slate-700">
                Total de seriais: <strong>{seriaisData.total || 0}</strong>
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="text-left px-2 py-1 border-b">Tipo</th>
                      <th className="text-left px-2 py-1 border-b">Artigo</th>
                      <th className="text-left px-2 py-1 border-b">Descrição</th>
                      <th className="text-left px-2 py-1 border-b">Serial</th>
                      <th className="text-left px-2 py-1 border-b">Lote</th>
                      <th className="text-left px-2 py-1 border-b">Quantidade</th>
                      <th className="text-left px-2 py-1 border-b">Localização</th>
                      <th className="text-left px-2 py-1 border-b">Nº Caixa</th>
                      <th className="text-left px-2 py-1 border-b">Status</th>
                      <th className="text-left px-2 py-1 border-b">Req</th>
                      {isAdminUser && <th className="text-left px-2 py-1 border-b">Ações</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(seriaisData.rows || []).map((r) => {
                      const statusNorm = String(r.status || '').trim().toLowerCase();
                      const statusBgClass =
                        statusNorm === 'consumido'
                          ? 'bg-red-50'
                          : statusNorm === 'reservado'
                            ? 'bg-yellow-50'
                            : '';
                      return (
                      <tr key={r.id} className={`border-b last:border-b-0 ${statusBgClass}`}>
                        <td className="px-2 py-1 uppercase">{r.tipo || (r.serialnumber ? 'serial' : 'lote')}</td>
                        <td className="px-2 py-1">{r.item_codigo}</td>
                        <td className="px-2 py-1">{r.item_descricao || '—'}</td>
                        <td className="px-2 py-1">{formatUpperView(r.serialnumber)}</td>
                        <td className="px-2 py-1">{formatUpperView(r.lote)}</td>
                        <td className="px-2 py-1">{formatQuantidadeConsulta(r.quantidade)}</td>
                        <td className="px-2 py-1">{formatLocalizacaoView(r.localizacao)}</td>
                        <td className="px-2 py-1">{r.codigo_caixa || '—'}</td>
                        <td className="px-2 py-1">{r.status}</td>
                        <td className="px-2 py-1">{r.requisicao_id || '—'}</td>
                        {isAdminUser && (
                          <td className="px-2 py-1">
                            <button
                              type="button"
                              onClick={() => apagarRegistroConsulta(r)}
                              disabled={deletingKey === `${String(r.tipo || (r.serialnumber ? 'serial' : 'lote')).toLowerCase()}-${r.id}`}
                              className="px-2 py-1 text-[11px] border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                            >
                              Apagar
                            </button>
                          </td>
                        )}
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
        )}

        {showConsulta && (
        <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
          <h2 className="font-semibold text-gray-800">Consulta por serial individual</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={serialCodigo}
              onChange={(e) => setSerialCodigo(e.target.value)}
              placeholder="Serial number"
              className="px-3 py-2 border border-gray-300 rounded w-full sm:w-80"
            />
            <button type="button" onClick={consultarSerial} className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50">
              Consultar
            </button>
          </div>
          {serialData && (
            <div className="border border-slate-200 rounded overflow-hidden">
              <div className="p-2 bg-slate-50 text-xs text-slate-700">
                {serialData.item_codigo} · {formatUpperView(serialData.serialnumber)}
              </div>
              <div className="p-3 text-xs grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div><strong>Armazém:</strong> {serialData.armazem_codigo ? `${serialData.armazem_codigo} - ` : ''}{serialData.armazem_descricao}</div>
                <div><strong>Localização:</strong> {formatLocalizacaoView(serialData.localizacao)}</div>
                <div><strong>Status:</strong> {serialData.status}</div>
                <div><strong>Caixa:</strong> {serialData.codigo_caixa || '—'}</div>
                <div><strong>Req:</strong> {serialData.requisicao_id || '—'}</div>
                <div><strong>Lote:</strong> {formatUpperView(serialData.lote)}</div>
              </div>
            </div>
          )}
        </section>
        )}

        {showConsulta && (
        <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
          <h2 className="font-semibold text-gray-800">Consulta por caixa</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={caixaCodigo}
              onChange={(e) => setCaixaCodigo(e.target.value)}
              placeholder="Código da caixa"
              className="px-3 py-2 border border-gray-300 rounded w-full sm:w-80"
            />
            <button type="button" onClick={consultarCaixa} className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50">
              Consultar
            </button>
          </div>
          {caixaData && (
            <div className="border border-slate-200 rounded overflow-hidden">
              <div className="p-2 bg-slate-50 text-xs text-slate-700">
                Caixa: <strong>{caixaData.caixa?.codigo_caixa}</strong> · Artigo: <strong>{caixaData.caixa?.item_codigo}</strong> · Localização: <strong>{formatLocalizacaoView(caixaData.caixa?.localizacao)}</strong>
              </div>
              <div className="max-h-64 overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="text-left px-2 py-1 border-b">Serial</th>
                      <th className="text-left px-2 py-1 border-b">Lote</th>
                      <th className="text-left px-2 py-1 border-b">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(caixaData.seriais || []).map((s) => (
                      <tr key={s.id} className="border-b last:border-b-0">
                        <td className="px-2 py-1">{formatUpperView(s.serialnumber)}</td>
                        <td className="px-2 py-1">{formatUpperView(s.lote)}</td>
                        <td className="px-2 py-1">{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
        )}

        {showConsulta && (
        <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
          <h2 className="font-semibold text-gray-800">Consulta de disponibilidade</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="item_id" className="px-3 py-2 border border-gray-300 rounded" />
            <input value={localizacao} onChange={(e) => setLocalizacao(e.target.value)} placeholder="localização (opcional)" className="px-3 py-2 border border-gray-300 rounded" />
            <button type="button" onClick={consultarDisponibilidade} className="px-3 py-2 border border-gray-300 rounded hover:bg-gray-50">Consultar</button>
          </div>
          {dispData && (
            <pre className="text-xs bg-slate-50 border border-slate-200 p-3 rounded overflow-auto max-h-64">
              {JSON.stringify(dispData, null, 2)}
            </pre>
          )}
        </section>
        )}

        {erro && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{erro}</div>}
      </div>
    </div>
  );
};

export default StockRastreavel;
