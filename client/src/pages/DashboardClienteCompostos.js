import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';
import { Package, Download, ExternalLink, Loader } from 'react-feather';

const DashboardClienteCompostos = () => {
  const { user } = useAuth();
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [itens, setItens] = useState([]);
  const [quantidades, setQuantidades] = useState({});
  /** null | 'bulk' | item id (número) — exportação global ou por linha */
  const [exportBusy, setExportBusy] = useState(null);
  /** Excel de stock opcional: colunas x3 (código) e Total */
  const [stockFile, setStockFile] = useState(null);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/itens/dashboard-cliente-compostos', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => []);
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao carregar lista.');
      }
      setItens(Array.isArray(data) ? data : []);
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao carregar.' });
      setItens([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const setQtd = (id, value) => {
    setQuantidades((prev) => ({ ...prev, [String(id)]: value }));
  };

  const exportarComPedido = async (pedido, busyKey) => {
    if (!user) {
      setToast({ type: 'error', message: 'Inicie sessão.' });
      return;
    }
    setExportBusy(busyKey);
    try {
      const token = localStorage.getItem('token');
      let res;
      if (stockFile) {
        const fd = new FormData();
        fd.append('pedido', JSON.stringify(pedido));
        fd.append('stock', stockFile, stockFile.name);
        res = await fetch('/api/itens/dashboard-cliente-compostos/export', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd
        });
      } else {
        res = await fetch('/api/itens/dashboard-cliente-compostos/export', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ pedido })
        });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Erro ao gerar ficheiro.');
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition');
      let filename = `necessidades_cliente_compostos_${new Date().toISOString().slice(0, 10)}.xlsx`;
      if (cd) {
        const m = /filename="([^"]+)"/.exec(cd);
        if (m) filename = m[1];
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setToast({ type: 'success', message: 'Ficheiro gerado com sucesso.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro na exportação.' });
    } finally {
      setExportBusy(null);
    }
  };

  const exportar = async () => {
    const pedido = [];
    for (const row of itens) {
      const raw = quantidades[String(row.id)];
      if (raw === undefined || raw === '' || raw === null) continue;
      const q = parseFloat(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(q) || q <= 0) continue;
      pedido.push({ item_id: row.id, quantidade: q });
    }
    if (pedido.length === 0) {
      setToast({ type: 'error', message: 'Preencha pelo menos uma quantidade maior que zero.' });
      return;
    }
    await exportarComPedido(pedido, 'bulk');
  };

  const exportarLinha = async (row) => {
    const raw = quantidades[String(row.id)];
    if (raw === undefined || raw === '' || raw === null) {
      setToast({ type: 'error', message: 'Preencha a quantidade deste artigo para exportar.' });
      return;
    }
    const q = parseFloat(String(raw).trim().replace(',', '.'));
    if (!Number.isFinite(q) || q <= 0) {
      setToast({ type: 'error', message: 'Indique uma quantidade maior que zero.' });
      return;
    }
    await exportarComPedido([{ item_id: row.id, quantidade: q }], row.id);
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] p-6 flex items-center justify-center text-gray-600">
        Inicie sessão para aceder ao dashboard.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 flex items-center gap-2">
              <Package className="text-[#0915FF]" />
              Dashboard — compostos CLIENTE
            </h1>
          </div>
          <button
            type="button"
            onClick={exportar}
            disabled={exportBusy !== null || loading || itens.length === 0}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0915FF] text-white rounded-lg text-sm font-medium hover:bg-[#070FCC] disabled:opacity-50 shrink-0"
          >
            {exportBusy === 'bulk' ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {exportBusy === 'bulk' ? 'A gerar…' : 'Exportar Excel'}
          </button>
        </div>

        <div className="mb-6 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm">
          <div className="font-medium text-gray-900">Ficheiro de stock (opcional)</div>
          <p className="text-xs text-gray-500 mt-1 mb-2">
            Modelo tipo lista de stock: colunas <span className="font-mono text-gray-700">x3</span> (código do artigo) e{' '}
            <span className="font-mono text-gray-700">Total</span> (quantidade). O Excel exportado acrescenta{' '}
            <span className="font-mono text-gray-700">Stock (ficheiro)</span> e{' '}
            <span className="font-mono text-gray-700">Falta (após stock)</span>.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={(e) => setStockFile(e.target.files?.[0] || null)}
              className="text-xs text-gray-700 max-w-full"
            />
            {stockFile ? (
              <>
                <span className="text-xs text-gray-600 truncate max-w-[200px]" title={stockFile.name}>
                  {stockFile.name}
                </span>
                <button
                  type="button"
                  onClick={() => setStockFile(null)}
                  className="text-xs font-medium text-[#0915FF] hover:underline"
                >
                  Remover
                </button>
              </>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16 text-gray-500">
            <Loader className="w-8 h-8 animate-spin text-[#0915FF]" />
          </div>
        ) : itens.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-amber-950 text-sm">
            Nenhum artigo encontrado com setor CLIENTE e composição. Verifique setores em{' '}
            <code className="bg-amber-100 px-1 rounded">itens_setores</code> e linhas em{' '}
            <code className="bg-amber-100 px-1 rounded">itens_compostos</code>.
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-600 border-b border-gray-200 bg-gray-50">
                    <th className="px-3 py-2 font-semibold">Artigo</th>
                    <th className="px-3 py-2 font-semibold">Descrição</th>
                    <th className="px-3 py-2 font-semibold">Un.</th>
                    <th className="px-3 py-2 font-semibold w-36">Qtd. desejada (kit)</th>
                    <th className="px-3 py-2 font-semibold w-28">Excel</th>
                    <th className="px-3 py-2 font-semibold w-24">Ficha</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((row) => (
                    <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50/80">
                      <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">
                        {row.codigo}
                        {row.ativo === false && (
                          <span className="ml-2 text-[10px] uppercase text-amber-900 bg-amber-100 px-1 rounded">
                            Inativo
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-md">{row.descricao || '—'}</td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                        {row.unidadearmazenamento || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          placeholder="0"
                          value={quantidades[String(row.id)] ?? ''}
                          onChange={(e) => setQtd(row.id, e.target.value)}
                          className="w-full max-w-[120px] px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => exportarLinha(row)}
                          disabled={loading || exportBusy !== null}
                          title="Exportar necessidades só deste kit"
                          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-300 text-gray-800 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                        >
                          {exportBusy === row.id ? (
                            <Loader className="w-3.5 h-3.5 animate-spin text-[#0915FF]" />
                          ) : (
                            <Download className="w-3.5 h-3.5 text-[#0915FF]" />
                          )}
                          <span className="hidden sm:inline">Linha</span>
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          to={`/item/${row.id}`}
                          className="inline-flex items-center gap-1 text-[#0915FF] hover:underline text-xs"
                        >
                          Ver <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 text-xs text-gray-500 border-t border-gray-100">
              {itens.length} artigo(s) na lista.
            </div>
          </div>
        )}
      </div>
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
};

export default DashboardClienteCompostos;
