import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../utils/apiUrl';
import Toast from '../components/Toast';

function ContagemMicroway() {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [itens, setItens] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [loadingParse, setLoadingParse] = useState(false);
  const [loadingGerar, setLoadingGerar] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('success');

  const notify = (message, type = 'success') => {
    setToastMessage(message);
    setToastType(type);
    setShowToast(true);
  };

  useEffect(() => {
    if (!user || !isAuthenticated) {
      navigate('/login');
    }
  }, [user, isAuthenticated, navigate]);

  const filteredItens = useMemo(() => {
    const q = String(filter || '').trim().toLowerCase();
    if (!q) return itens;
    return itens.filter((it) => {
      const cod = String(it.codigo || '').toLowerCase();
      const desc = String(it.descricao || '').toLowerCase();
      return cod.includes(q) || desc.includes(q);
    });
  }, [itens, filter]);

  const allFilteredSelected = filteredItens.length > 0
    && filteredItens.every((it) => selected.has(String(it.codigo)));

  const toggleOne = (codigo) => {
    const key = String(codigo);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredItens.forEach((it) => next.delete(String(it.codigo)));
      } else {
        filteredItens.forEach((it) => next.add(String(it.codigo)));
      }
      return next;
    });
  };

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext !== 'xlsx' && ext !== 'xls') {
      notify('Seleccione um ficheiro Excel (.xlsx ou .xls).', 'error');
      e.target.value = '';
      return;
    }
    setFile(f);
    setItens([]);
    setSelected(new Set());
  };

  const handleParse = useCallback(async () => {
    if (!file) {
      notify('Seleccione o ficheiro MW.xlsx primeiro.', 'error');
      return;
    }
    const token = localStorage.getItem('token');
    if (!token) {
      notify('Sessão expirada. Faça login novamente.', 'error');
      navigate('/login');
      return;
    }
    setLoadingParse(true);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      const response = await fetch(apiUrl('/api/admin/contagem-microway/parse'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao ler ficheiro MW.');
      }
      const lista = Array.isArray(data.itens) ? data.itens : [];
      setItens(lista);
      setSelected(new Set(lista.map((it) => String(it.codigo))));
      notify(`${lista.length} artigo(s) encontrado(s) no ficheiro.`);
    } catch (e) {
      notify(e.message || 'Erro ao processar ficheiro.', 'error');
    } finally {
      setLoadingParse(false);
    }
  }, [file, navigate]);

  const handleGerar = async () => {
    const codigos = [...selected];
    if (!codigos.length) {
      notify('Seleccione pelo menos um artigo.', 'error');
      return;
    }
    if (!file) {
      notify('O ficheiro MW original é necessário para gerar o STOCK MW.', 'error');
      return;
    }
    const token = localStorage.getItem('token');
    if (!token) {
      notify('Sessão expirada. Faça login novamente.', 'error');
      navigate('/login');
      return;
    }
    const descricoes_mw = {};
    for (const it of itens) {
      if (!selected.has(String(it.codigo))) continue;
      descricoes_mw[it.codigo] = it.descricao_mw || it.descricao || '';
    }
    setLoadingGerar(true);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      formData.append('codigos', JSON.stringify(codigos));
      formData.append('descricoes_mw', JSON.stringify(descricoes_mw));
      const response = await fetch(apiUrl('/api/admin/contagem-microway/gerar'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao gerar ficheiro.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `STOCK MW ${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify(`STOCK MW gerado com ${codigos.length} artigo(s).`);
    } catch (e) {
      notify(e.message || 'Erro ao gerar STOCK MW.', 'error');
    } finally {
      setLoadingGerar(false);
    }
  };

  if (!user || !isAuthenticated) {
    return null;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Contagem Microway</h1>
        <p className="mt-1 text-sm text-gray-600">
          Carregue um ficheiro MW.xlsx, seleccione os artigos e gere o STOCK MW somando a coluna Stock do ficheiro
          (FUNCTIONAL em localizações normais, DAMAGED em armazéns APEADO, EXPEDITION em localizações EXP.*).
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <label className="mb-2 block text-sm font-medium text-gray-700">Ficheiro MW (.xlsx)</label>
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-md file:border-0 file:bg-[#0915FF] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#0712cc]"
        />
        {file && (
          <p className="mt-2 text-xs text-gray-500">
            Ficheiro:
            {' '}
            {file.name}
          </p>
        )}
        <button
          type="button"
          disabled={!file || loadingParse}
          onClick={handleParse}
          className="mt-4 rounded-md bg-[#0915FF] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0712cc] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingParse ? 'A ler ficheiro…' : 'Carregar lista de artigos'}
        </button>
      </div>

      {itens.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                Artigos (
                {itens.length}
                )
              </h2>
              <p className="text-xs text-gray-500">
                {selected.size}
                {' '}
                seleccionado(s)
              </p>
            </div>
            <input
              type="search"
              placeholder="Filtrar código ou descrição…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div className="max-h-[420px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      aria-label="Seleccionar todos visíveis"
                    />
                  </th>
                  <th className="px-4 py-2">ERP</th>
                  <th className="px-4 py-2">Descrição</th>
                  <th className="px-4 py-2 text-right">Stock MW</th>
                  <th className="px-4 py-2">Catálogo</th>
                </tr>
              </thead>
              <tbody>
                {filteredItens.map((it) => {
                  const cod = String(it.codigo);
                  return (
                    <tr key={cod} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(cod)}
                          onChange={() => toggleOne(cod)}
                          aria-label={`Seleccionar ${cod}`}
                        />
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{cod}</td>
                      <td className="px-4 py-2 text-gray-800">{it.descricao || it.descricao_mw || '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs tabular-nums">
                        {Number(it.stock_mw || 0).toLocaleString('pt-PT')}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {it.no_catalogo ? (
                          <span className="text-green-700">Sim</span>
                        ) : (
                          <span className="text-amber-700">Não</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-gray-200 px-4 py-4">
            <button
              type="button"
              disabled={loadingGerar || selected.size === 0}
              onClick={handleGerar}
              className="rounded-md border border-[#0915FF] bg-white px-4 py-2 text-sm font-semibold text-[#0915FF] hover:bg-[#0915FF]/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingGerar ? 'A gerar STOCK MW…' : 'Gerar STOCK MW.xlsx'}
            </button>
          </div>
        </div>
      )}

      {showToast && (
        <Toast
          message={toastMessage}
          type={toastType}
          onClose={() => setShowToast(false)}
        />
      )}
    </div>
  );
}

export default ContagemMicroway;
