import React, { useEffect, useMemo, useState } from 'react';
import Toast from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';

const parseNumberPt = (v) => {
  const raw = String(v ?? '').trim();
  if (!raw) return 0;
  return Number(raw.replace(/\./g, '').replace(',', '.')) || 0;
};

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const pickCol = (headers, variants) => {
  const hs = headers.map((h) => ({ raw: h, n: norm(h) }));
  const found = hs.find((h) => variants.some((v) => h.n === norm(v)));
  if (found) return found.raw;
  return hs.find((h) => variants.some((v) => h.n.includes(norm(v))))?.raw || null;
};

const ContagemSemanal = () => {
  const { user } = useAuth();
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [armazens, setArmazens] = useState([]);
  const [utilizadores, setUtilizadores] = useState([]);
  const [tarefas, setTarefas] = useState([]);
  const [tarefaAtual, setTarefaAtual] = useState(null);
  const [armazemId, setArmazemId] = useState('');
  const [atribuidoParaUserId, setAtribuidoParaUserId] = useState('');
  const [rows, setRows] = useState([]);
  const [busyLineId, setBusyLineId] = useState(null);

  const token = localStorage.getItem('token');
  const canGerirTarefa = ['admin', 'backoffice_armazem', 'supervisor_armazem'].includes(String(user?.role || '').toLowerCase());

  const carregarTarefas = async () => {
    const res = await fetch('/api/inventario/contagem-semanal/tarefas', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || data.details || 'Erro ao carregar tarefas');
    setTarefas(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const [armazensRes, usersRes] = await Promise.all([
          fetch('/api/inventario/armazens', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/inventario/contagem-semanal/utilizadores', { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const armazensData = await armazensRes.json().catch(() => []);
        if (!armazensRes.ok) throw new Error(armazensData.error || armazensData.details || 'Erro ao carregar armazéns');
        setArmazens(Array.isArray(armazensData) ? armazensData : []);
        const usersData = await usersRes.json().catch(() => []);
        if (usersRes.ok) setUtilizadores(Array.isArray(usersData) ? usersData : []);
        await carregarTarefas();
      } catch (e) {
        setToast({ type: 'error', message: e.message || 'Erro ao carregar dados' });
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [token]);

  const importar = async (file) => {
    if (!file) return;
    if (!armazemId) return setToast({ type: 'error', message: 'Selecione o armazém antes de importar.' });
    try {
      setLoading(true);
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames?.[0]];
      if (!sheet) throw new Error('Ficheiro sem folhas.');
      const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (!Array.isArray(data) || !data.length) throw new Error('Ficheiro vazio.');
      const headers = Object.keys(data[0] || {});
      const colArtigo = pickCol(headers, ['Artigo', 'Codigo', 'REF', 'Código']);
      const colDesc = pickCol(headers, ['Descrição', 'Descricao']);
      const colQtd = pickCol(headers, ['QTD']);
      const colQtdApe = pickCol(headers, ['QTD APE', 'QTD_APE']);
      if (!colArtigo) throw new Error('Não encontrei a coluna Artigo.');
      const parsed = data
        .map((r) => ({
          artigo: String(r[colArtigo] || '').trim(),
          descricao: colDesc ? String(r[colDesc] || '').trim() : '',
          qtd: colQtd ? parseNumberPt(r[colQtd]) : 0,
          qtd_ape: colQtdApe ? parseNumberPt(r[colQtdApe]) : 0,
        }))
        .filter((r) => r.artigo);
      const res = await fetch('/api/inventario/contagem-semanal/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ armazem_id: Number(armazemId), rows: parsed }),
      });
      const preview = await res.json().catch(() => []);
      if (!res.ok) throw new Error(preview.error || preview.details || 'Erro ao gerar preview');
      setRows(Array.isArray(preview) ? preview : []);
      setTarefaAtual(null);
      setToast({ type: 'success', message: `Importado: ${parsed.length} linha(s).` });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao importar tabela' });
    } finally {
      setLoading(false);
    }
  };

  const onEdit = (idx, key, val) => {
    const n = parseNumberPt(val);
    setRows((prev) => prev.map((r, i) => {
      if (i !== idx) return r;
      const next = { ...r, [key]: n };
      next.total = Number(next.qtd || 0) + Number(next.qtd_ape || 0);
      next.diferenca = Number(next.total || 0) - Number(next.quantidade_sistema || 0);
      return next;
    }));
  };

  const criarTarefa = async () => {
    if (!canGerirTarefa) return setToast({ type: 'error', message: 'Sem permissão para criar tarefa.' });
    if (!armazemId || !atribuidoParaUserId) return setToast({ type: 'error', message: 'Selecione armazém e utilizador responsável.' });
    if (!rows.length) return setToast({ type: 'error', message: 'Importe a tabela antes de criar tarefa.' });
    try {
      setLoading(true);
      const res = await fetch('/api/inventario/contagem-semanal/tarefas', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ armazem_id: Number(armazemId), atribuido_para_user_id: Number(atribuidoParaUserId), rows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao criar tarefa');
      await carregarTarefas();
      setToast({ type: 'success', message: `Tarefa #${data.id} criada.` });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao criar tarefa' });
    } finally {
      setLoading(false);
    }
  };

  const abrirTarefa = async (id) => {
    try {
      setLoading(true);
      const res = await fetch(`/api/inventario/contagem-semanal/tarefas/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao abrir tarefa');
      setTarefaAtual(data);
      setArmazemId(String(data.armazem_id || ''));
      setRows(Array.isArray(data.linhas) ? data.linhas : []);
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao abrir tarefa' });
    } finally {
      setLoading(false);
    }
  };

  const salvarLinha = async (idx) => {
    if (!tarefaAtual?.id) return;
    const row = rows[idx];
    try {
      setBusyLineId(row.id);
      const res = await fetch(`/api/inventario/contagem-semanal/tarefas/${tarefaAtual.id}/linhas/${row.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ qtd: Number(row.qtd || 0), qtd_ape: Number(row.qtd_ape || 0) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao guardar linha');
      setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, total: Number(data.total || r.total), diferenca: Number(data.diferenca || r.diferenca) } : r)));
      await carregarTarefas();
      setToast({ type: 'success', message: `Linha ${row.artigo} guardada.` });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao guardar linha' });
    } finally {
      setBusyLineId(null);
    }
  };

  const armazemSelecionado = useMemo(
    () => armazens.find((a) => String(a.id) === String(armazemId)) || null,
    [armazens, armazemId]
  );

  const exportar = async () => {
    if (!rows.length) return setToast({ type: 'error', message: 'Não há linhas para exportar.' });
    try {
      const XLSX = await import('xlsx');
      const data = rows.map((r) => ({
        Artigo: r.artigo,
        'Descrição': r.descricao || '',
        QTD: Number(r.qtd || 0),
        'QTD APE': Number(r.qtd_ape || 0),
        TOTAL: Number(r.total || 0),
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Contagem');
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const codigo = String(armazemSelecionado?.codigo || 'ARMAZEM').replace(/\s+/g, '_');
      XLSX.writeFile(wb, `contagem_semanal_${codigo}_${ts}.xlsx`);
      setToast({ type: 'success', message: 'Ficheiro exportado com sucesso.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao exportar ficheiro.' });
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Contagem semanal</h1>
          <p className="text-gray-600 mt-1">Crie tarefa de contagem, atribua a outro utilizador e guarde as linhas individualmente.</p>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Armazém</label>
              <select value={armazemId} onChange={(e) => setArmazemId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                <option value="">Selecione</option>
                {armazens.map((a) => <option key={a.id} value={a.id}>{a.codigo ? `${a.codigo} - ${a.descricao}` : a.descricao}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Atribuir para</label>
              <select value={atribuidoParaUserId} onChange={(e) => setAtribuidoParaUserId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" disabled={!canGerirTarefa}>
                <option value="">Selecione</option>
                {utilizadores.map((u) => <option key={u.id} value={u.id}>{u.nome ? `${u.nome} (${u.username})` : u.username}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Importar tabela</label>
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => importar(e.target.files?.[0])} disabled={!armazemId || loading} className="w-full text-sm disabled:opacity-50" />
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            {canGerirTarefa && <button type="button" onClick={criarTarefa} disabled={!rows.length || !armazemId || !atribuidoParaUserId || loading} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white disabled:opacity-50">Criar tarefa de contagem</button>}
            <button type="button" onClick={exportar} disabled={!rows.length} className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#0915FF] text-white disabled:opacity-50">Exportar contagem</button>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4 overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 border-b text-left">ID</th>
                <th className="px-3 py-2 border-b text-left">Armazém</th>
                <th className="px-3 py-2 border-b text-left">Responsável</th>
                <th className="px-3 py-2 border-b text-right">Linhas</th>
                <th className="px-3 py-2 border-b text-left">Status</th>
                <th className="px-3 py-2 border-b text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {tarefas.map((t) => (
                <tr key={t.id} className="border-b">
                  <td className="px-3 py-2">#{t.id}</td>
                  <td className="px-3 py-2">{t.armazem_codigo ? `${t.armazem_codigo} - ${t.armazem_descricao}` : t.armazem_descricao}</td>
                  <td className="px-3 py-2">{t.atribuido_para_nome || t.atribuido_para_username || '—'}</td>
                  <td className="px-3 py-2 text-right">{Number(t.linhas_total || 0)}</td>
                  <td className="px-3 py-2">{t.status || 'ABERTA'}</td>
                  <td className="px-3 py-2 text-right"><button type="button" onClick={() => abrirTarefa(t.id)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">Abrir</button></td>
                </tr>
              ))}
              {tarefas.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">Nenhuma tarefa criada.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 border-b text-left">Artigo</th>
                <th className="px-3 py-2 border-b text-left">Descrição</th>
                <th className="px-3 py-2 border-b text-right">Stock armazém</th>
                <th className="px-3 py-2 border-b text-right">QTD</th>
                <th className="px-3 py-2 border-b text-right">QTD APE</th>
                <th className="px-3 py-2 border-b text-right">TOTAL</th>
                <th className="px-3 py-2 border-b text-right">Diferença</th>
                <th className="px-3 py-2 border-b text-right">Guardar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={`${r.artigo}-${idx}`} className="border-b">
                  <td className="px-3 py-2 font-mono">{r.artigo}</td>
                  <td className="px-3 py-2">{r.descricao || '—'}</td>
                  <td className="px-3 py-2 text-right">{Number(r.quantidade_sistema || 0)}</td>
                  <td className="px-3 py-2 text-right"><input value={String(r.qtd ?? 0)} onChange={(e) => onEdit(idx, 'qtd', e.target.value)} className="w-24 px-2 py-1 border border-gray-300 rounded text-right" /></td>
                  <td className="px-3 py-2 text-right"><input value={String(r.qtd_ape ?? 0)} onChange={(e) => onEdit(idx, 'qtd_ape', e.target.value)} className="w-24 px-2 py-1 border border-gray-300 rounded text-right" /></td>
                  <td className="px-3 py-2 text-right font-semibold">{Number(r.total || 0)}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${Number(r.diferenca || 0) === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{Number(r.diferenca || 0)}</td>
                  <td className="px-3 py-2 text-right"><button type="button" onClick={() => salvarLinha(idx)} disabled={!tarefaAtual?.id || busyLineId === r.id} className="px-2 py-1 rounded bg-[#0915FF] text-white disabled:opacity-50">Guardar</button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">Importe uma tabela para iniciar a contagem.</td></tr>}
            </tbody>
          </table>
        </div>

        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      </div>
    </div>
  );
};

export default ContagemSemanal;
