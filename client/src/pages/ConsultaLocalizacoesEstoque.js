import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { FaChevronLeft, FaChevronRight, FaWarehouse, FaMapMarkerAlt } from 'react-icons/fa';
import Toast from '../components/Toast';
import QrScannerModal from '../components/QrScannerModal';
import PesquisaComLeitorQr from '../components/PesquisaComLeitorQr';
import { FORMATOS_QR_BARCODE } from '../utils/qrBarcodeFormats';

const PAGE_SIZE_LOCAL = 10;

const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const ConsultaLocalizacoesEstoque = () => {
  const [armazens, setArmazens] = useState([]);
  const [loadingArmazens, setLoadingArmazens] = useState(true);
  const [armazemId, setArmazemId] = useState('');
  const [locId, setLocId] = useState('');
  const [linhas, setLinhas] = useState([]);
  const [loadingEstoque, setLoadingEstoque] = useState(false);
  const [toast, setToast] = useState(null);
  const [filtroLocal, setFiltroLocal] = useState('');
  const [filtroArtigoLocal, setFiltroArtigoLocal] = useState('');
  const [paginaLocal, setPaginaLocal] = useState(1);

  const [pesquisaArmazemQ, setPesquisaArmazemQ] = useState('');
  const [pesquisaArmazemLoading, setPesquisaArmazemLoading] = useState(false);
  const [pesquisaArmazemResult, setPesquisaArmazemResult] = useState(null);

  const [scannerLocalOpen, setScannerLocalOpen] = useState(false);
  const [scannerArtigoArmazemOpen, setScannerArtigoArmazemOpen] = useState(false);
  const [scannerArtigoLocalOpen, setScannerArtigoLocalOpen] = useState(false);

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
    () =>
      (armazens || []).filter((a) => String(a?.tipo || '').trim().toLowerCase() === 'central'),
    [armazens]
  );

  useEffect(() => {
    if (centrais.length !== 1 || armazemId) return;
    setArmazemId(String(centrais[0].id));
  }, [centrais, armazemId]);

  const armazemSelecionado = useMemo(
    () => centrais.find((a) => String(a.id) === String(armazemId)),
    [centrais, armazemId]
  );

  const localizacoesComId = useMemo(() => {
    const locs = armazemSelecionado?.localizacoes || [];
    return locs.filter((l) => l && l.id != null);
  }, [armazemSelecionado]);

  const localizacoesFiltradas = useMemo(() => {
    const q = normalize(filtroLocal);
    if (!q) return localizacoesComId;
    return localizacoesComId.filter((l) => {
      const t = normalize(l.localizacao || '');
      return t.includes(q);
    });
  }, [localizacoesComId, filtroLocal]);

  useEffect(() => {
    setLocId('');
    setLinhas([]);
    setPesquisaArmazemResult(null);
  }, [armazemId]);

  useEffect(() => {
    if (!armazemId || !locId) {
      setLinhas([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingEstoque(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get(
          `/api/armazens/${armazemId}/localizacoes/${locId}/estoque`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!cancelled) setLinhas(Array.isArray(data) ? data : []);
      } catch (e) {
        const d = e.response?.data;
        const hint = d?.hint ? ` ${d.hint}` : '';
        if (!cancelled) {
          setLinhas([]);
          setToast({
            type: 'error',
            message: (d?.error || 'Erro ao carregar itens da localização.') + hint
          });
        }
      } finally {
        if (!cancelled) setLoadingEstoque(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armazemId, locId]);

  useEffect(() => {
    setPaginaLocal(1);
    setFiltroArtigoLocal('');
  }, [locId]);

  useEffect(() => {
    setPaginaLocal(1);
  }, [filtroArtigoLocal]);

  const linhasFiltradasTabela = useMemo(() => {
    const q = normalize(filtroArtigoLocal);
    if (!q) return linhas;
    return linhas.filter((row) => {
      const c = normalize(row.codigo || '');
      const d = normalize(row.descricao || '');
      return c.includes(q) || d.includes(q);
    });
  }, [linhas, filtroArtigoLocal]);

  const totalPaginasLocal = Math.max(1, Math.ceil(linhasFiltradasTabela.length / PAGE_SIZE_LOCAL));
  const paginaLocalSegura = Math.min(paginaLocal, totalPaginasLocal);
  const inicioIdx = (paginaLocalSegura - 1) * PAGE_SIZE_LOCAL;
  const linhasPagina = linhasFiltradasTabela.slice(inicioIdx, inicioIdx + PAGE_SIZE_LOCAL);

  const totalQuantidade = useMemo(
    () => linhas.reduce((s, l) => s + (Number(l.quantidade) || 0), 0),
    [linhas]
  );

  const totalQuantidadeFiltrada = useMemo(
    () => linhasFiltradasTabela.reduce((s, l) => s + (Number(l.quantidade) || 0), 0),
    [linhasFiltradasTabela]
  );

  const locLabelAtual = useMemo(() => {
    const l = localizacoesComId.find((x) => String(x.id) === String(locId));
    return l ? l.localizacao : '';
  }, [localizacoesComId, locId]);

  const pesquisarArtigoNoArmazem = useCallback(
    async (e, qOverride) => {
      e?.preventDefault?.();
      const raw =
        qOverride !== undefined && qOverride !== null ? String(qOverride) : pesquisaArmazemQ;
      const q = raw.trim();
      if (!armazemId) {
        setToast({ type: 'error', message: 'Selecione um armazém.' });
        return;
      }
      if (q.length < 2) {
        setToast({ type: 'error', message: 'Digite pelo menos 2 caracteres.' });
        return;
      }
      setPesquisaArmazemLoading(true);
      setPesquisaArmazemResult(null);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get(`/api/armazens/${armazemId}/estoque-artigo-lookup`, {
          params: { q },
          headers: { Authorization: `Bearer ${token}` }
        });
        setPesquisaArmazemResult(data);
        if (!data?.itens?.length) {
          setToast({ type: 'info', message: 'Nenhum artigo com stock neste armazém corresponde à pesquisa.' });
        }
      } catch (err) {
        const d = err.response?.data;
        setToast({ type: 'error', message: d?.error || 'Erro ao pesquisar artigo.' });
      } finally {
        setPesquisaArmazemLoading(false);
      }
    },
    [armazemId, pesquisaArmazemQ]
  );

  const aplicarLeituraLocalizacao = useCallback(
    (texto) => {
      const v = (texto || '').trim();
      if (!v) return;

      const byId = localizacoesComId.find((l) => String(l.id) === v);
      if (byId) {
        setFiltroLocal(byId.localizacao || v);
        setLocId(String(byId.id));
        setToast({ type: 'success', message: `Localização: ${byId.localizacao}` });
        return;
      }

      const n = normalize(v);
      const exactNorm = localizacoesComId.filter((l) => normalize(l.localizacao || '') === n);
      if (exactNorm.length === 1) {
        setFiltroLocal(v);
        setLocId(String(exactNorm[0].id));
        setToast({ type: 'success', message: `Localização: ${exactNorm[0].localizacao}` });
        return;
      }

      setFiltroLocal(v);
      const filtered = !n
        ? localizacoesComId
        : localizacoesComId.filter((l) => normalize(l.localizacao || '').includes(n));
      if (filtered.length === 1) {
        setLocId(String(filtered[0].id));
        setToast({ type: 'success', message: `Localização: ${filtered[0].localizacao}` });
      } else if (filtered.length === 0) {
        setToast({
          type: 'error',
          message: 'Código lido não corresponde a nenhuma localização deste armazém.'
        });
      } else {
        setToast({ type: 'info', message: 'Filtro aplicado; selecione a localização na lista.' });
      }
    },
    [localizacoesComId]
  );

  const aplicarLeituraArtigoArmazem = useCallback(
    (texto) => {
      const v = (texto || '').trim();
      if (!v) return;
      setPesquisaArmazemQ(v);
      pesquisarArtigoNoArmazem(null, v);
    },
    [pesquisarArtigoNoArmazem]
  );

  const aplicarLeituraArtigoLocal = useCallback((texto) => {
    const v = (texto || '').trim();
    if (!v) return;
    setFiltroArtigoLocal(v);
  }, []);

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
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">
            Consulta: localizações e stock
          </h1>
          <p className="text-gray-600 text-sm sm:text-base">
            Armazéns <strong>centrais</strong>: escolha o armazém, depois a localização, para ver os artigos e quantidades
            registados. Use a pesquisa global para ver em que localizações um artigo tem stock.
          </p>
          <p className="mt-2 text-sm">
            <Link to="/armazens" className="text-[#0915FF] hover:underline">
              Ir para Armazéns
            </Link>
            <span className="text-gray-500"> — para criar/editar armazéns e gerir stock por localização.</span>
          </p>
        </div>

        {centrais.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-600">
            <FaWarehouse className="mx-auto text-4xl text-gray-300 mb-3" />
            <p>Não há armazéns centrais ativos para consultar neste contexto.</p>
            <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
              Se o seu perfil é de armazém, confirme em <strong>Meu perfil</strong> / administração que tem um armazém
              de origem de requisições associado ao seu utilizador.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-4 space-y-4">
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <FaWarehouse className="inline mr-2 text-[#0915FF]" />
                  Armazém central
                </label>
                <select
                  value={armazemId}
                  onChange={(e) => {
                    setArmazemId(e.target.value);
                    setFiltroLocal('');
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#0915FF]"
                >
                  <option value="">Selecione…</option>
                  {centrais.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.codigo} — {a.descricao}
                    </option>
                  ))}
                </select>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <FaMapMarkerAlt className="inline mr-2 text-emerald-600" />
                  Localização
                </label>
                {!armazemId ? (
                  <p className="text-sm text-gray-500">Primeiro selecione um armazém.</p>
                ) : localizacoesComId.length === 0 ? (
                  <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    Este armazém não tem localizações com identificador na base de dados. Edite o armazém em{' '}
                    <Link to="/armazens" className="underline font-medium">
                      Armazéns
                    </Link>{' '}
                    e guarde.
                  </p>
                ) : (
                  <>
                    <div className="mb-2">
                      <PesquisaComLeitorQr
                        value={filtroLocal}
                        onChange={(e) => setFiltroLocal(e.target.value)}
                        placeholder="Filtrar localizações…"
                        onLerClick={() => setScannerLocalOpen(true)}
                        disabled={!armazemId || localizacoesComId.length === 0}
                        lerDisabled={!armazemId || localizacoesComId.length === 0}
                        lerTitle="Ler QR ou código de barras da localização"
                        lerAriaLabel="Ler QR ou código de barras da localização"
                      />
                    </div>
                    <ul className="max-h-[min(360px,50vh)] overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                      {localizacoesFiltradas.length === 0 ? (
                        <li className="px-3 py-4 text-sm text-gray-500 text-center">Nenhuma localização corresponde ao filtro.</li>
                      ) : (
                        localizacoesFiltradas.map((l) => {
                          const sel = String(l.id) === String(locId);
                          return (
                            <li key={l.id}>
                              <button
                                type="button"
                                onClick={() => setLocId(String(l.id))}
                                className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${
                                  sel
                                    ? 'bg-[#0915FF]/10 text-[#0915FF] font-medium'
                                    : 'hover:bg-gray-50 text-gray-800'
                                }`}
                              >
                                <span className="font-mono">{l.localizacao}</span>
                                {l.tipo_localizacao && l.tipo_localizacao !== 'normal' && (
                                  <span className="ml-2 text-xs text-gray-500 uppercase">({l.tipo_localizacao})</span>
                                )}
                              </button>
                            </li>
                          );
                        })
                      )}
                    </ul>
                  </>
                )}
              </div>
            </div>

            <div className="lg:col-span-8 space-y-4">
              {armazemId && (
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 bg-slate-50">
                    <h2 className="text-sm font-semibold text-gray-800">Pesquisar artigo em todo o armazém</h2>
                    <p className="text-xs text-gray-600 mt-0.5">
                      Código ou trecho da descrição: mostra todas as localizações com quantidade &gt; 0 neste central.
                    </p>
                  </div>
                  <form onSubmit={pesquisarArtigoNoArmazem} className="p-4 flex flex-col sm:flex-row gap-2">
                    <div className="flex-1 min-w-0">
                      <PesquisaComLeitorQr
                        inputType="search"
                        value={pesquisaArmazemQ}
                        onChange={(e) => setPesquisaArmazemQ(e.target.value)}
                        placeholder="Ex.: 3000022 ou alicate…"
                        onLerClick={() => setScannerArtigoArmazemOpen(true)}
                        disabled={pesquisaArmazemLoading}
                        lerDisabled={pesquisaArmazemLoading}
                        lerTitle="Ler QR ou código de barras do artigo"
                        lerAriaLabel="Ler QR ou código de barras do artigo"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={pesquisaArmazemLoading}
                      className="px-4 py-2 rounded-lg bg-[#0915FF] text-white text-sm font-medium hover:bg-[#070FCC] disabled:opacity-50 whitespace-nowrap"
                    >
                      {pesquisaArmazemLoading ? 'A pesquisar…' : 'Pesquisar'}
                    </button>
                  </form>
                  {pesquisaArmazemResult?.possivelmente_mais && (
                    <p className="px-4 pb-2 text-[11px] text-amber-800">
                      Mostramos até {pesquisaArmazemResult.limite_itens || 30} artigos correspondentes; refine a pesquisa
                      se não encontrar o que procura.
                    </p>
                  )}
                  {Array.isArray(pesquisaArmazemResult?.itens) && pesquisaArmazemResult.itens.length > 0 && (
                    <div className="px-4 pb-4 space-y-4 max-h-[min(420px,55vh)] overflow-y-auto border-t border-gray-100">
                      {pesquisaArmazemResult.itens.map((it) => {
                        const totalLoc = (it.localizacoes || []).reduce(
                          (s, z) => s + (Number(z.quantidade) || 0),
                          0
                        );
                        return (
                          <div
                            key={it.item_id}
                            className="rounded-lg border border-gray-200 bg-gray-50/50 overflow-hidden"
                          >
                            <div className="px-3 py-2 bg-white border-b border-gray-100">
                              <span className="font-mono font-semibold text-gray-900">{it.codigo}</span>
                              <span className="text-sm text-gray-700 block sm:inline sm:ml-2">{it.descricao}</span>
                              <span className="text-xs text-gray-500 block mt-1 sm:mt-0 sm:inline sm:ml-2">
                                Total neste armazém: <strong className="tabular-nums">{totalLoc}</strong>
                              </span>
                            </div>
                            <table className="min-w-full text-xs sm:text-sm">
                              <thead className="bg-gray-100 text-left text-gray-600">
                                <tr>
                                  <th className="px-3 py-1.5 font-medium">Localização</th>
                                  <th className="px-3 py-1.5 font-medium">Tipo</th>
                                  <th className="px-3 py-1.5 font-medium text-right">Qtd</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100 bg-white">
                                {(it.localizacoes || []).map((z) => (
                                  <tr key={`${it.item_id}-${z.localizacao_id}`}>
                                    <td className="px-3 py-1.5 font-mono">{z.localizacao}</td>
                                    <td className="px-3 py-1.5 text-gray-600">{z.tipo_localizacao || '—'}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{z.quantidade}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden min-h-[280px]">
                <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                  <h2 className="text-sm font-semibold text-gray-800">Artigos na localização</h2>
                  {locId && locLabelAtual ? (
                    <p className="text-xs text-gray-600 mt-0.5">
                      <span className="font-mono">{locLabelAtual}</span>
                      {armazemSelecionado && (
                        <>
                          {' '}
                          · {armazemSelecionado.codigo} — {armazemSelecionado.descricao}
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-0.5">Selecione uma localização à esquerda.</p>
                  )}
                </div>
                <div className="p-4">
                  {!locId ? (
                    <p className="text-sm text-gray-500 text-center py-12">Escolha uma localização para ver o stock.</p>
                  ) : loadingEstoque ? (
                    <p className="text-sm text-gray-600 text-center py-12">A carregar artigos…</p>
                  ) : linhas.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-12">
                      Nenhum artigo com quantidade registada nesta localização.
                    </p>
                  ) : (
                    <>
                      <div className="mb-3">
                        <PesquisaComLeitorQr
                          inputType="search"
                          value={filtroArtigoLocal}
                          onChange={(e) => setFiltroArtigoLocal(e.target.value)}
                          placeholder="Filtrar por código ou descrição nesta localização…"
                          onLerClick={() => setScannerArtigoLocalOpen(true)}
                          disabled={loadingEstoque}
                          lerDisabled={loadingEstoque}
                          lerTitle="Ler QR ou código de barras do artigo"
                          lerAriaLabel="Ler QR ou código de barras do artigo"
                        />
                      </div>
                      <p className="text-xs text-gray-600 mb-3">
                        <span className="font-semibold tabular-nums">{linhas.length}</span> artigo(s) nesta localização
                        {filtroArtigoLocal.trim() ? (
                          <>
                            {' '}
                            · <span className="font-semibold tabular-nums">{linhasFiltradasTabela.length}</span> após
                            filtro · total unidades (filtrado):{' '}
                            <span className="font-semibold tabular-nums">{totalQuantidadeFiltrada}</span>
                          </>
                        ) : (
                          <>
                            {' '}
                            · total de unidades: <span className="font-semibold tabular-nums">{totalQuantidade}</span>
                          </>
                        )}
                      </p>
                      <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50 text-left text-xs text-gray-600">
                            <tr>
                              <th className="px-3 py-2 font-medium">Código</th>
                              <th className="px-3 py-2 font-medium">Descrição</th>
                              <th className="px-3 py-2 font-medium text-right w-28">Quantidade</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {linhasPagina.map((row) => (
                              <tr key={row.item_id} className="hover:bg-gray-50/80">
                                <td className="px-3 py-2 font-mono text-gray-900">{row.codigo}</td>
                                <td className="px-3 py-2 text-gray-700">{row.descricao}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-900">
                                  {row.quantidade}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {totalPaginasLocal > 1 && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-gray-700">
                          <span className="text-[11px] text-gray-500">
                            Pág. {paginaLocalSegura}/{totalPaginasLocal} · {PAGE_SIZE_LOCAL}/pág.
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setPaginaLocal((p) => Math.max(1, p - 1))}
                              disabled={paginaLocalSegura <= 1}
                              className="inline-flex items-center gap-0.5 px-2 py-1 rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 text-[11px]"
                            >
                              <FaChevronLeft className="text-[10px]" /> Ant.
                            </button>
                            <button
                              type="button"
                              onClick={() => setPaginaLocal((p) => Math.min(totalPaginasLocal, p + 1))}
                              disabled={paginaLocalSegura >= totalPaginasLocal}
                              className="inline-flex items-center gap-0.5 px-2 py-1 rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 text-[11px]"
                            >
                              Seg. <FaChevronRight className="text-[10px]" />
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <QrScannerModal
          open={scannerLocalOpen}
          onClose={() => setScannerLocalOpen(false)}
          onScan={aplicarLeituraLocalizacao}
          title="Ler localização (QR ou código de barras)"
          readerId="qr-reader-consulta-localizacao"
          formatsToSupport={FORMATOS_QR_BARCODE}
        />
        <QrScannerModal
          open={scannerArtigoArmazemOpen}
          onClose={() => setScannerArtigoArmazemOpen(false)}
          onScan={aplicarLeituraArtigoArmazem}
          title="Ler artigo no armazém (QR ou código de barras)"
          readerId="qr-reader-consulta-artigo-armazem"
          formatsToSupport={FORMATOS_QR_BARCODE}
        />
        <QrScannerModal
          open={scannerArtigoLocalOpen}
          onClose={() => setScannerArtigoLocalOpen(false)}
          onScan={aplicarLeituraArtigoLocal}
          title="Ler artigo na localização (QR ou código de barras)"
          readerId="qr-reader-consulta-artigo-local"
          formatsToSupport={FORMATOS_QR_BARCODE}
        />

        {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      </div>
    </div>
  );
};

export default ConsultaLocalizacoesEstoque;
