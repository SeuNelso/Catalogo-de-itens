import React, { useCallback, useEffect, useMemo, useState } from 'react';

const PAGE_SIZE = 15;

const formatQtd = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  if (Math.abs(num - Math.trunc(num)) < 1e-9) return String(Math.trunc(num));
  return String(num);
};

const ConsultaStockNacionalArmazem = () => {
  const [armazens, setArmazens] = useState([]);
  const [armazemId, setArmazemId] = useState('');
  const [qInput, setQInput] = useState('');
  const [qAplicado, setQAplicado] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [sugOpen, setSugOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [offsetHistory, setOffsetHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const loadArmazens = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/requisicoes/stock/meus-armazens', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Erro ao carregar armazéns');
        const list = Array.isArray(data.rows) ? data.rows : [];
        setArmazens(list);
        if (list.length === 1) setArmazemId(String(list[0].id));
      } catch (e) {
        setErro(e.message || 'Erro ao carregar armazéns do utilizador');
      }
    };
    loadArmazens();
  }, []);

  const fetchArtigos = useCallback(async (targetArmazemId, targetQ, targetOffset) => {
    if (!targetArmazemId) return;
    try {
      setLoading(true);
      setErro('');
      const token = localStorage.getItem('token');
      const params = new URLSearchParams();
      params.set('armazem_id', String(targetArmazemId));
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(Number(targetOffset) || 0));
      if (String(targetQ || '').trim()) params.set('q', String(targetQ).trim());
      const response = await fetch(`/api/requisicoes/stock/itens-nacional-por-armazem?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao consultar artigos');
      const list = Array.isArray(data.rows) ? data.rows : [];
      setRows(list);
      setTotal(Number(data.total) || 0);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      const next = Number(targetOffset) + list.length < (Number(data.total) || 0)
        ? Number(targetOffset) + list.length
        : null;
      setNextOffset(next);
    } catch (e) {
      setErro(e.message || 'Erro ao consultar artigos');
      setRows([]);
      setTotal(0);
      setSuggestions([]);
      setNextOffset(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!armazemId) return;
    setOffset(0);
    setOffsetHistory([]);
    fetchArtigos(armazemId, qAplicado, 0);
  }, [armazemId, qAplicado, fetchArtigos]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = String(qInput || '').trim();
      setQAplicado(next);
      setOffset(0);
      setOffsetHistory([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [qInput]);

  const limparPesquisa = () => {
    setQInput('');
    setQAplicado('');
    setOffset(0);
    setOffsetHistory([]);
    setSugOpen(false);
  };

  const irProxima = () => {
    if (nextOffset === null || !armazemId) return;
    setOffsetHistory((prev) => [...prev, offset]);
    setOffset(nextOffset);
    fetchArtigos(armazemId, qAplicado, nextOffset);
  };

  const irAnterior = () => {
    if (!offsetHistory.length || !armazemId) return;
    const prevOffset = offsetHistory[offsetHistory.length - 1];
    setOffsetHistory((prev) => prev.slice(0, -1));
    setOffset(prevOffset);
    fetchArtigos(armazemId, qAplicado, prevOffset);
  };

  const suggestionsFiltradas = useMemo(() => {
    const t = String(qInput || '').trim().toLowerCase();
    if (t.length < 2) return [];
    return (suggestions || []).filter((s) => {
      const c = String(s.codigo || '').toLowerCase();
      const d = String(s.descricao || '').toLowerCase();
      return c.includes(t) || d.includes(t);
    });
  }, [qInput, suggestions]);

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Itens em Estoque</h1>
        <p className="text-gray-600 mt-1 mb-3">
          Lista de artigos do armazém selecionado com quantidade de stock nacional.
        </p>

        <section className="bg-white rounded-2xl shadow-lg border border-gray-200 p-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select
              value={armazemId}
              onChange={(e) => setArmazemId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">Selecionar armazém</option>
              {(armazens || []).map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.codigo ? `${a.codigo} - ` : ''}{a.descricao || `Armazém ${a.id}`}
                </option>
              ))}
            </select>

            <div className="relative">
              <input
                value={qInput}
                onChange={(e) => {
                  setQInput(e.target.value);
                  setSugOpen(true);
                }}
                onFocus={() => setSugOpen(true)}
                onBlur={() => setTimeout(() => setSugOpen(false), 120)}
                placeholder="Pesquisar por código ou descrição"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
              {sugOpen && suggestionsFiltradas.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-56 overflow-auto border border-gray-200 rounded bg-white shadow-sm">
                  {suggestionsFiltradas.map((s) => (
                    <button
                      key={s.item_id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setQInput(String(s.codigo || ''));
                        setQAplicado(String(s.codigo || ''));
                        setOffset(0);
                        setOffsetHistory([]);
                        setSugOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                    >
                      <div className="text-xs font-medium text-gray-800">{s.codigo}</div>
                      <div className="text-[11px] text-gray-600">{s.descricao || 'Sem descrição'}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={limparPesquisa}
                disabled={loading}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 text-sm"
              >
                Limpar
              </button>
            </div>
          </div>
          <div className="text-xs text-gray-600 mt-3">
            Total de artigos: <strong>{total}</strong>
          </div>
        </section>

        <section className="overflow-x-auto rounded-2xl shadow-lg bg-white mt-4">
          <table className="min-w-full text-xs sm:text-[16px]">
            <thead>
              <tr className="bg-gradient-to-r from-[#0a1fff] to-[#3b82f6] text-white font-bold">
                <th className="py-4 px-6 text-left w-36 first:rounded-tl-2xl">CÓDIGO</th>
                <th className="py-4 px-6 text-left">DESCRIÇÃO</th>
                <th className="py-4 px-6 text-left w-56 last:rounded-tr-2xl">QUANTIDADE</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="px-6 py-8 text-center text-gray-500" colSpan={3}>
                    Nenhum artigo encontrado.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.item_id} className="border-b border-gray-200 last:border-b-0 hover:bg-gray-50">
                  <td className="py-3 px-6 font-semibold text-gray-700">{r.codigo || '—'}</td>
                  <td className="py-3 px-6 text-gray-800">{r.descricao || '—'}</td>
                  <td className="py-3 px-6">
                    <span className="font-bold text-green-700">{formatQtd(r.quantidade)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={irAnterior}
            disabled={loading || offsetHistory.length === 0}
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Anterior
          </button>
          <button
            type="button"
            onClick={irProxima}
            disabled={loading || nextOffset === null}
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Próxima
          </button>
          <span className="text-xs text-gray-500">Offset: {offset}</span>
        </div>

        {erro && (
          <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
            {erro}
          </div>
        )}
      </div>
    </div>
  );
};

export default ConsultaStockNacionalArmazem;
