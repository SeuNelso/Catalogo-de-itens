import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, FileText, Upload } from 'react-feather';
import * as XLSX from 'xlsx';
import { analisarControloStock, stockEstaConciliado } from '../utils/controloStockAnalise';

const ficheirosNecessarios = [
  { key: 'anterior', title: 'Stock do dia anterior', description: 'Stock inicial a verificar.' },
  { key: 'movimentos', title: 'Movimentos do dia atual', description: 'Entradas, saídas e saldos iniciais.' },
  { key: 'atual', title: 'Stock do dia atual', description: 'Stock final para comparar.' },
];

const formatarQuantidade = (value) =>
  new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 4 }).format(value);

const formatarData = (value) => {
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${String(parsed.d).padStart(2, '0')}/${String(parsed.m).padStart(2, '0')}/${parsed.y}`;
    }
  }
  if (value instanceof Date) return value.toLocaleDateString('pt-PT');
  return value ? String(value) : '—';
};

const lerFicheiro = async (file) => {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) throw new Error(`O ficheiro "${file.name}" não contém folhas.`);
  return XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
};

function CartaoFicheiro({ file, item, onChange }) {
  const inputId = `ficheiro-stock-${item.key}`;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <label htmlFor={inputId} className="mb-2 block text-sm font-semibold text-slate-800">
        {item.title}
      </label>
      <p className="mb-3 text-xs text-slate-500">{item.description}</p>
      <label
        htmlFor={inputId}
        className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-teal-600 hover:bg-teal-50"
      >
        {file ? <FileText size={17} className="shrink-0 text-teal-700" /> : <Upload size={17} className="shrink-0 text-slate-500" />}
        <span className="break-all">{file?.name || 'Selecionar ficheiro Excel'}</span>
      </label>
      <input
        id={inputId}
        type="file"
        accept=".xlsx,.xls"
        onChange={(event) => {
          onChange(event.target.files?.[0] || null);
          event.target.value = '';
        }}
        className="sr-only"
      />
    </div>
  );
}

function MovimentosArtigo({ item }) {
  return (
    <div className="overflow-x-auto border-t border-slate-200 bg-slate-50 p-3">
      {item.movimentos.length ? (
        <table className="w-full min-w-[780px] text-left text-xs">
          <thead className="text-slate-600">
            <tr>
              <th className="px-2 py-2">Data / hora</th>
              <th className="px-2 py-2">Tipo</th>
              <th className="px-2 py-2">Documento</th>
              <th className="px-2 py-2 text-right">Quantidade</th>
              <th className="px-2 py-2">Armazém</th>
              <th className="px-2 py-2">Localização</th>
              <th className="px-2 py-2 text-right">Stock após movimento</th>
            </tr>
          </thead>
          <tbody>
            {item.movimentos.map((movement, index) => (
              <tr key={`${movement.documento}-${movement.data}-${index}`} className="border-t border-slate-200">
                <td className="whitespace-nowrap px-2 py-2">
                  {formatarData(movement.data)}{movement.hora ? ` ${movement.hora}` : ''}
                </td>
                <td className="px-2 py-2">{movement.tipo}</td>
                <td className="px-2 py-2">{movement.documento || '—'}</td>
                <td className="px-2 py-2 text-right">
                  {movement.quantidade ? formatarQuantidade(movement.quantidade) : '—'}
                  {movement.unidade ? ` ${movement.unidade}` : ''}
                </td>
                <td className="px-2 py-2">{movement.armazem || '—'}</td>
                <td className="px-2 py-2">{movement.localizacao || '—'}</td>
                <td className="px-2 py-2 text-right">
                  {movement.stockAtual === '' ? '—' : formatarQuantidade(Number(movement.stockAtual))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="m-0 py-2 text-sm text-slate-600">Não existem movimentos deste artigo no ficheiro.</p>
      )}
    </div>
  );
}

export default function AnaliseControloStock() {
  const [files, setFiles] = useState({ anterior: null, movimentos: null, atual: null });
  const [resultados, setResultados] = useState(null);
  const [erro, setErro] = useState('');
  const [aAnalisar, setAAnalisar] = useState(false);
  const [pesquisa, setPesquisa] = useState('');
  const [mostrarTodos, setMostrarTodos] = useState(false);
  const [artigoExpandido, setArtigoExpandido] = useState(null);

  const divergencias = useMemo(
    () => resultados?.filter((item) => !stockEstaConciliado(item)) || [],
    [resultados]
  );
  const resultadosFiltrados = useMemo(() => {
    if (!resultados) return [];
    const base = mostrarTodos ? resultados : divergencias;
    const query = pesquisa.trim().toLocaleLowerCase('pt-PT');
    if (!query) return base;
    return base.filter((item) =>
      `${item.artigo} ${item.descricao}`.toLocaleLowerCase('pt-PT').includes(query)
    );
  }, [divergencias, mostrarTodos, pesquisa, resultados]);

  const atualizarFicheiro = (key, file) => {
    setFiles((current) => ({ ...current, [key]: file }));
    setResultados(null);
    setErro('');
    setArtigoExpandido(null);
  };

  const executarAnalise = async (event) => {
    event.preventDefault();
    const emFalta = ficheirosNecessarios.find(({ key }) => !files[key]);
    if (emFalta) {
      setErro(`Selecione o ficheiro: ${emFalta.title}.`);
      return;
    }

    setAAnalisar(true);
    setErro('');
    setResultados(null);
    try {
      const [stockAnteriorRows, movimentosRows, stockAtualRows] = await Promise.all([
        lerFicheiro(files.anterior),
        lerFicheiro(files.movimentos),
        lerFicheiro(files.atual),
      ]);
      setResultados(analisarControloStock({ stockAnteriorRows, movimentosRows, stockAtualRows }));
    } catch (error) {
      setErro(error.message || 'Não foi possível analisar os ficheiros.');
    } finally {
      setAAnalisar(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-3 py-6 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-teal-700 p-3 text-white"><FileText size={24} /></div>
            <div>
              <h1 className="m-0 text-2xl font-bold text-slate-900">Análise de controlo de stock</h1>
              <p className="mb-0 mt-1 text-sm text-slate-600">
                Compare o stock anterior, os movimentos do dia e o stock atual.
              </p>
            </div>
          </div>
          <p className="mb-0 mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
            A comparação é feita pelo total de cada artigo, somando as localizações e armazéns. Assim,
            transferências internas (saída e entrada) não alteram o total esperado. Os ficheiros são
            processados localmente no navegador.
          </p>
        </header>

        <form onSubmit={executarAnalise} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="grid gap-4 md:grid-cols-3">
            {ficheirosNecessarios.map((item) => (
              <CartaoFicheiro
                key={item.key}
                item={item}
                file={files[item.key]}
                onChange={(file) => atualizarFicheiro(item.key, file)}
              />
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={aAnalisar}
              className="rounded-lg bg-teal-700 px-5 py-2.5 font-semibold text-white hover:bg-teal-800 disabled:cursor-wait disabled:opacity-60"
            >
              {aAnalisar ? 'A analisar…' : 'Analisar stock'}
            </button>
            {erro && <p role="alert" className="m-0 text-sm font-medium text-red-700">{erro}</p>}
          </div>
        </form>

        {resultados && (
          <section aria-label="Resultados da análise" className="mt-6">
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="m-0 text-sm text-slate-500">Artigos analisados</p>
                <p className="mb-0 mt-1 text-2xl font-bold text-slate-900">{resultados.length}</p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="m-0 text-sm text-emerald-800">Conciliados</p>
                <p className="mb-0 mt-1 flex items-center gap-2 text-2xl font-bold text-emerald-900">
                  <CheckCircle size={21} /> {resultados.length - divergencias.length}
                </p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="m-0 text-sm text-amber-800">Artigos divergentes</p>
                <p className="mb-0 mt-1 flex items-center gap-2 text-2xl font-bold text-amber-900">
                  <AlertTriangle size={21} /> {divergencias.length}
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="m-0 text-lg font-bold text-slate-900">
                  {mostrarTodos ? 'Artigos analisados' : 'Divergências encontradas'}
                </h2>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="search"
                    value={pesquisa}
                    onChange={(event) => setPesquisa(event.target.value)}
                    placeholder="Pesquisar artigo ou descrição"
                    aria-label="Pesquisar artigo ou descrição"
                    className="min-w-52 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setMostrarTodos((current) => !current)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {mostrarTodos ? 'Mostrar divergências' : 'Mostrar todos'}
                  </button>
                </div>
              </div>

              {resultadosFiltrados.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                      <tr>
                        <th className="px-4 py-3">Artigo</th>
                        <th className="px-4 py-3">Descrição</th>
                        <th className="px-4 py-3 text-right">Stock anterior</th>
                        <th className="px-4 py-3 text-right">Movimento líquido</th>
                        <th className="px-4 py-3 text-right">Stock esperado</th>
                        <th className="px-4 py-3 text-right">Stock atual</th>
                        <th className="px-4 py-3 text-right">Diferença</th>
                        <th className="px-4 py-3">Movimentos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resultadosFiltrados.map((item) => {
                        const divergente = !stockEstaConciliado(item);
                        const expandido = artigoExpandido === item.artigo;
                        return (
                          <React.Fragment key={item.artigo}>
                            <tr className={divergente ? 'border-t border-amber-100 bg-amber-50/60' : 'border-t border-slate-100'}>
                              <td className="px-4 py-3 font-semibold text-slate-900">{item.artigo}</td>
                              <td className="max-w-xs truncate px-4 py-3 text-slate-700" title={item.descricao}>{item.descricao || '—'}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{formatarQuantidade(item.stockAnterior)}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{formatarQuantidade(item.quantidadeMovimentada)}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{formatarQuantidade(item.stockEsperado)}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{formatarQuantidade(item.stockAtual)}</td>
                              <td className={`px-4 py-3 text-right font-bold tabular-nums ${divergente ? 'text-red-700' : 'text-emerald-700'}`}>
                                {formatarQuantidade(item.diferenca)}
                              </td>
                              <td className="px-4 py-3">
                                <button
                                  type="button"
                                  aria-expanded={expandido}
                                  onClick={() => setArtigoExpandido(expandido ? null : item.artigo)}
                                  className="inline-flex items-center gap-1 whitespace-nowrap font-semibold text-teal-800 underline hover:text-teal-950"
                                >
                                  {expandido ? 'Fechar movimentos' : `Ver movimentos (${item.movimentos.length})`}
                                  {expandido ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                </button>
                              </td>
                            </tr>
                            {expandido && (
                              <tr><td colSpan="8" className="p-0"><MovimentosArtigo item={item} /></td></tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="m-0 p-6 text-center text-sm text-slate-600">
                  {mostrarTodos
                    ? 'Nenhum artigo corresponde à pesquisa.'
                    : divergencias.length
                      ? 'Nenhuma divergência corresponde à pesquisa.'
                      : 'Não foram encontradas divergências. Todos os artigos estão conciliados.'}
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
