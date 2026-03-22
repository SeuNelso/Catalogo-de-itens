import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getRequisicoesArmazemOrigemIds } from '../utils/requisicoesArmazemOrigem';
import { quantidadeStockNacionalNoArmazem } from '../utils/stockNacionalArmazem';
import Toast from '../components/Toast';
import { FaArrowLeft, FaSave, FaPlus, FaTrash, FaChevronDown } from 'react-icons/fa';
import axios from 'axios';

function itemTextoSecundario(item) {
  if (!item) return '';
  return (item.descricao || item.nome || '').trim();
}

const CriarRequisicao = () => {
  const [formData, setFormData] = useState({
    armazem_origem_id: '',
    armazem_id: '',
    observacoes: ''
  });
  const [armazens, setArmazens] = useState([]);
  const [itensRequisicao, setItensRequisicao] = useState([]); // Array de {item_id, quantidade}
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [buscaItem, setBuscaItem] = useState('');
  const [itensFiltrados, setItensFiltrados] = useState([]);
  const [mostrarListaItens, setMostrarListaItens] = useState(false);
  const [itemSelecionado, setItemSelecionado] = useState(null);
  const [quantidadeAtual, setQuantidadeAtual] = useState('');
  const [buscaArmazemOrigem, setBuscaArmazemOrigem] = useState('');
  const [buscaArmazemDestino, setBuscaArmazemDestino] = useState('');
  const [openOrigem, setOpenOrigem] = useState(false);
  const [openDestino, setOpenDestino] = useState(false);
  const [selectedItemIndex, setSelectedItemIndex] = useState(-1);
  const [itensBuscaLoading, setItensBuscaLoading] = useState(false);
  const refOrigem = useRef(null);
  const refDestino = useRef(null);
  const refQuantidadeInput = useRef(null);
  const refBuscaItem = useRef(null);
  const refListaItens = useRef(null);
  const debounceBuscaRef = useRef(null);
  const skipBuscaRef = useRef(false);
  const abortBuscaRef = useRef(null);
  const abortStockRef = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  /** Stock nacional (armazens_item) no armazém de origem para o item em seleção */
  const [stockOrigem, setStockOrigem] = useState({
    loading: false,
    valor: null,
    erro: false
  });

  useEffect(() => {
    fetchArmazens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const allowed = getRequisicoesArmazemOrigemIds(user);
    if (allowed.length !== 1 || user?.role === 'admin' || user?.role === 'controller') return;
    setFormData((prev) => {
      if (prev.armazem_origem_id) return prev;
      return { ...prev, armazem_origem_id: String(allowed[0]) };
    });
  }, [user]);

  useEffect(() => {
    if (skipBuscaRef.current) {
      skipBuscaRef.current = false;
      return;
    }
    const q = buscaItem.trim();
    if (!q) {
      if (abortBuscaRef.current) abortBuscaRef.current.abort();
      setItensFiltrados([]);
      setMostrarListaItens(false);
      setSelectedItemIndex(-1);
      setItensBuscaLoading(false);
      return;
    }
    if (debounceBuscaRef.current) clearTimeout(debounceBuscaRef.current);
    debounceBuscaRef.current = setTimeout(async () => {
      if (abortBuscaRef.current) abortBuscaRef.current.abort();
      const ac = new AbortController();
      abortBuscaRef.current = ac;
      setItensBuscaLoading(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/itens', {
          params: {
            search: q,
            limit: 200,
            page: 1,
            incluirInativos: true
          },
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal
        });
        if (abortBuscaRef.current !== ac) return;
        const list = data.itens || [];
        setItensFiltrados(list);
        setMostrarListaItens(true);
        setSelectedItemIndex(list.length > 0 ? 0 : -1);
      } catch (err) {
        if (axios.isCancel?.(err) || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        console.error('Erro ao buscar itens:', err);
        setItensFiltrados([]);
        setToast({ type: 'error', message: 'Erro ao pesquisar itens' });
      } finally {
        if (abortBuscaRef.current === ac) setItensBuscaLoading(false);
      }
    }, 280);
    return () => {
      clearTimeout(debounceBuscaRef.current);
      abortBuscaRef.current?.abort();
    };
  }, [buscaItem]);

  useEffect(() => {
    if (mostrarListaItens && selectedItemIndex >= 0 && refListaItens.current) {
      const el = refListaItens.current.querySelector(`[data-item-index="${selectedItemIndex}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedItemIndex, mostrarListaItens]);

  useEffect(() => {
    if (!itemSelecionado?.id || !formData.armazem_origem_id) {
      setStockOrigem({ loading: false, valor: null, erro: false });
      return;
    }
    const arm = armazens.find((a) => a.id === parseInt(formData.armazem_origem_id, 10));
    if (!arm) {
      setStockOrigem({ loading: false, valor: null, erro: false });
      return;
    }
    if (abortStockRef.current) abortStockRef.current.abort();
    const ac = new AbortController();
    abortStockRef.current = ac;
    setStockOrigem((s) => ({ ...s, loading: true, erro: false }));
    (async () => {
      try {
        const { data } = await axios.get(`/api/itens/${itemSelecionado.id}`, {
          signal: ac.signal
        });
        if (abortStockRef.current !== ac) return;
        const rows = data.armazens || [];
        const q = quantidadeStockNacionalNoArmazem(rows, arm);
        setStockOrigem({ loading: false, valor: q, erro: false });
      } catch (err) {
        if (axios.isCancel?.(err) || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        if (abortStockRef.current !== ac) return;
        setStockOrigem({ loading: false, valor: null, erro: true });
      }
    })();
    return () => {
      ac.abort();
    };
  }, [itemSelecionado?.id, formData.armazem_origem_id, armazens]);

  const fetchArmazens = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/armazens?ativo=true', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.data) {
        setArmazens(response.data);
      }
    } catch (error) {
      console.error('Erro ao buscar armazéns:', error);
      setToast({ type: 'error', message: 'Erro ao carregar armazéns' });
    }
  };

  const handleItemSelect = (item) => {
    if (debounceBuscaRef.current) clearTimeout(debounceBuscaRef.current);
    if (abortBuscaRef.current) abortBuscaRef.current.abort();
    skipBuscaRef.current = true;
    setItemSelecionado(item);
    setBuscaItem(`${item.codigo} - ${itemTextoSecundario(item)}`);
    setMostrarListaItens(false);
    setSelectedItemIndex(-1);
    setTimeout(() => refQuantidadeInput.current?.focus(), 0);
  };

  const handleAddItem = () => {
    if (!itemSelecionado || !quantidadeAtual || parseInt(quantidadeAtual) <= 0) {
      setToast({ type: 'error', message: 'Selecione um item e informe uma quantidade válida' });
      return;
    }

    // Verificar se o item já foi adicionado
    const itemExistente = itensRequisicao.find(ri => ri.item_id === itemSelecionado.id);
    if (itemExistente) {
      // Atualizar quantidade do item existente
      setItensRequisicao(itensRequisicao.map(ri => 
        ri.item_id === itemSelecionado.id 
          ? { 
              ...ri, 
              quantidade: parseInt(quantidadeAtual)
            }
          : ri
      ));
    } else {
      // Adicionar novo item
      setItensRequisicao([...itensRequisicao, {
        item_id: itemSelecionado.id,
        quantidade: parseInt(quantidadeAtual),
        item_codigo: itemSelecionado.codigo,
        item_descricao: itemTextoSecundario(itemSelecionado)
      }]);
    }

    // Limpar seleção
    setItemSelecionado(null);
    setBuscaItem('');
    setQuantidadeAtual('');
    setTimeout(() => refBuscaItem.current?.focus(), 0);
  };

  const handleRemoveItem = (itemId) => {
    setItensRequisicao(itensRequisicao.filter(ri => ri.item_id !== itemId));
  };

  const getArmazemLabel = (armazem) =>
    armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : (armazem.descricao || '');

  const filterArmazens = (lista, busca) => {
    if (!busca.trim()) return lista;
    const q = busca.trim().toLowerCase();
    return lista.filter(a =>
      (a.codigo || '').toLowerCase().includes(q) ||
      (a.descricao || '').toLowerCase().includes(q)
    );
  };

  const armazensListaOrigem = useMemo(() => {
    const centrais = (armazens || []).filter((a) => (a.tipo || '').toLowerCase() === 'central');
    const allowed = getRequisicoesArmazemOrigemIds(user);
    if (allowed.length > 0 && user?.role !== 'admin' && user?.role !== 'controller') {
      const set = new Set(allowed);
      return centrais.filter((a) => set.has(a.id));
    }
    return centrais;
  }, [armazens, user]);

  const armazensOrigemFiltrados = filterArmazens(armazensListaOrigem, buscaArmazemOrigem);
  const armazensDestinoFiltrados = filterArmazens(armazens, buscaArmazemDestino);

  const armazemOrigemSelecionado = armazens.find(a => a.id === parseInt(formData.armazem_origem_id, 10));
  const armazemDestinoSelecionado = armazens.find(a => a.id === parseInt(formData.armazem_id, 10));

  useEffect(() => {
    const onClose = (e) => {
      if (refOrigem.current && !refOrigem.current.contains(e.target)) setOpenOrigem(false);
      if (refDestino.current && !refDestino.current.contains(e.target)) setOpenDestino(false);
    };
    document.addEventListener('mousedown', onClose);
    return () => document.removeEventListener('mousedown', onClose);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.armazem_id) {
      setToast({ type: 'error', message: 'Selecione o armazém destino' });
      return;
    }

    if (itensRequisicao.length === 0) {
      setToast({ type: 'error', message: 'Adicione pelo menos um item à requisição' });
      return;
    }

    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      const payload = {
        armazem_origem_id: formData.armazem_origem_id ? parseInt(formData.armazem_origem_id) : null,
        armazem_id: parseInt(formData.armazem_id),
        itens: itensRequisicao.map(ri => ({
          item_id: ri.item_id,
          quantidade: ri.quantidade
        })),
        observacoes: formData.observacoes || null
      };

      const response = await axios.post('/api/requisicoes', payload, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 201) {
        setToast({ type: 'success', message: 'Requisição criada com sucesso!' });
        setTimeout(() => {
          navigate('/requisicoes');
        }, 1500);
      }
    } catch (error) {
      console.error('Erro ao criar requisição:', error);
      const errorMessage = error.response?.data?.error || 'Erro ao criar requisição';
      setToast({ type: 'error', message: errorMessage });
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => navigate('/requisicoes')}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-800"
          >
            <FaArrowLeft /> Voltar
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Nova Requisição</h1>
          <p className="text-gray-600">Etapa 1: Defina origem, itens, quantidades e destino. A localização será preenchida na preparação.</p>
        </div>

        {/* Form */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <form
            onSubmit={handleSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            className="space-y-6"
          >
            {/* Armazém Origem */}
            <div ref={refOrigem}>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Armazém Origem
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={openOrigem ? buscaArmazemOrigem : (armazemOrigemSelecionado ? getArmazemLabel(armazemOrigemSelecionado) : '')}
                  onChange={(e) => {
                    setBuscaArmazemOrigem(e.target.value);
                    setOpenOrigem(true);
                  }}
                  onFocus={() => {
                    setOpenOrigem(true);
                    setBuscaArmazemOrigem('');
                  }}
                  placeholder="Clique e escreva para pesquisar..."
                  className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                />
                <FaChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                {openOrigem && (
                  <ul className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-auto">
                    {armazensOrigemFiltrados.length === 0 ? (
                      <li className="px-4 py-3 text-gray-500 text-sm">Nenhum armazém encontrado</li>
                    ) : (
                      armazensOrigemFiltrados.map((armazem) => (
                        <li
                          key={armazem.id}
                          onClick={() => {
                            setFormData(prev => ({ ...prev, armazem_origem_id: String(armazem.id) }));
                            setOpenOrigem(false);
                            setBuscaArmazemOrigem('');
                          }}
                          className="px-4 py-2 hover:bg-[#0915FF]/10 cursor-pointer text-gray-900"
                        >
                          {getArmazemLabel(armazem)}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">De onde os itens serão retirados</p>
            </div>

            {/* Armazém Destino */}
            <div ref={refDestino}>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Armazém Destino <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={openDestino ? buscaArmazemDestino : (armazemDestinoSelecionado ? getArmazemLabel(armazemDestinoSelecionado) : '')}
                  onChange={(e) => {
                    setBuscaArmazemDestino(e.target.value);
                    setOpenDestino(true);
                  }}
                  onFocus={() => {
                    setOpenDestino(true);
                    setBuscaArmazemDestino('');
                  }}
                  placeholder="Clique e escreva para pesquisar..."
                  className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                />
                <FaChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                {openDestino && (
                  <ul className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-auto">
                    {armazensDestinoFiltrados.length === 0 ? (
                      <li className="px-4 py-3 text-gray-500 text-sm">Nenhum armazém encontrado</li>
                    ) : (
                      armazensDestinoFiltrados.map((armazem) => (
                        <li
                          key={armazem.id}
                          onClick={() => {
                            setFormData(prev => ({ ...prev, armazem_id: String(armazem.id) }));
                            setOpenDestino(false);
                            setBuscaArmazemDestino('');
                          }}
                          className="px-4 py-2 hover:bg-[#0915FF]/10 cursor-pointer text-gray-900"
                        >
                          {getArmazemLabel(armazem)}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">Viatura/armazém que receberá os itens</p>
            </div>

            {/* Adicionar Itens */}
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Itens da Requisição</h3>
              
              {/* Busca e Seleção de Item */}
              <div className="mb-4 p-4 bg-gray-50 rounded-lg">
                {/* Linha 1: busca + qtd | Linha 2: stock + botão (o botão não desce quando o stock aparece) */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                  <div className="md:col-span-7 lg:col-span-8">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Buscar Item
                    </label>
                    <div className="relative">
                      <input
                        ref={refBuscaItem}
                        type="text"
                        placeholder="Pesquisa no catálogo (todos os itens, ativos e inativos)…"
                        value={buscaItem}
                        onChange={(e) => {
                          setBuscaItem(e.target.value);
                          setItemSelecionado(null);
                        }}
                        onFocus={() => {
                          if (buscaItem.trim()) {
                            setMostrarListaItens(true);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown') {
                            if (mostrarListaItens && itensFiltrados.length > 0) {
                              e.preventDefault();
                              setSelectedItemIndex((i) =>
                                i < itensFiltrados.length - 1 ? i + 1 : i
                              );
                            }
                          } else if (e.key === 'ArrowUp') {
                            if (mostrarListaItens && itensFiltrados.length > 0) {
                              e.preventDefault();
                              setSelectedItemIndex((i) => (i > 0 ? i - 1 : 0));
                            }
                          } else if (e.key === 'Enter') {
                            e.preventDefault();
                            if (mostrarListaItens && itensFiltrados.length > 0) {
                              const idx = selectedItemIndex >= 0 ? selectedItemIndex : 0;
                              handleItemSelect(itensFiltrados[idx]);
                            } else if (itemSelecionado) {
                              refQuantidadeInput.current?.focus();
                            }
                          }
                        }}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                      />
                      {mostrarListaItens && buscaItem.trim() && (
                        <div
                          ref={refListaItens}
                          className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto"
                        >
                          {itensBuscaLoading ? (
                            <div className="px-4 py-3 text-sm text-gray-500">A pesquisar…</div>
                          ) : itensFiltrados.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-gray-500">Nenhum item encontrado</div>
                          ) : (
                            itensFiltrados.map((item, index) => (
                              <div
                                key={item.id}
                                data-item-index={index}
                                onClick={() => handleItemSelect(item)}
                                className={`px-4 py-2 cursor-pointer border-b border-gray-200 last:border-b-0 ${
                                  index === selectedItemIndex
                                    ? 'bg-[#0915FF]/15 text-[#0915FF]'
                                    : 'hover:bg-gray-100'
                                }`}
                              >
                                <div className="font-medium text-gray-900">{item.codigo}</div>
                                <div className="text-sm text-gray-500">{itemTextoSecundario(item)}</div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="md:col-span-5 lg:col-span-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Quantidade
                    </label>
                    <input
                      ref={refQuantidadeInput}
                      type="number"
                      value={quantidadeAtual}
                      onChange={(e) => setQuantidadeAtual(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddItem();
                        }
                      }}
                      min="1"
                      placeholder="Qtd"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                    />
                  </div>

                  <div className="md:col-span-7 lg:col-span-8 min-h-0">
                    {(formData.armazem_origem_id || itemSelecionado) && (
                      <div className="md:pr-2 rounded-lg bg-gray-50 px-3 py-2.5">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">
                          Stock nacional · armazém origem
                        </div>
                        <div
                          className="text-xs text-gray-600 mt-0.5 truncate"
                          title={
                            armazemOrigemSelecionado
                              ? getArmazemLabel(armazemOrigemSelecionado)
                              : 'Armazém de origem'
                          }
                        >
                          {armazemOrigemSelecionado
                            ? getArmazemLabel(armazemOrigemSelecionado)
                            : 'Selecione o armazém de origem'}
                        </div>
                        <div className="mt-2 text-2xl font-bold tabular-nums text-gray-900 min-h-[2rem] flex items-center">
                          {!formData.armazem_origem_id || !itemSelecionado
                            ? '—'
                            : stockOrigem.loading
                              ? '…'
                              : stockOrigem.erro
                                ? '—'
                                : stockOrigem.valor != null
                                  ? stockOrigem.valor
                                  : '—'}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="md:col-span-5 lg:col-span-4 flex items-start md:justify-end">
                    <button
                      type="button"
                      onClick={handleAddItem}
                      className="w-full sm:w-auto min-w-[11rem] px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors flex items-center justify-center gap-2 shrink-0"
                    >
                      <FaPlus /> Adicionar Item
                    </button>
                  </div>
                </div>
              </div>

              {/* Lista de Itens Adicionados */}
              {itensRequisicao.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Itens Adicionados ({itensRequisicao.length})</h4>
                  <div className="space-y-2">
                    {itensRequisicao.map((ri) => (
                      <div
                        key={ri.item_id}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
                      >
                        <div className="flex-1">
                          <div className="font-medium text-gray-900">{ri.item_codigo}</div>
                          <div className="text-sm text-gray-500">{ri.item_descricao}</div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm font-medium text-gray-700">
                            Qtd: <span className="text-[#0915FF]">{ri.quantidade}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(ri.item_id)}
                            className="text-red-600 hover:text-red-800 p-2"
                          >
                            <FaTrash />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Observações */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Observações
              </label>
              <textarea
                name="observacoes"
                value={formData.observacoes}
                onChange={handleChange}
                rows="4"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                placeholder="Observações adicionais sobre a requisição (opcional)"
              />
            </div>

            {/* Botões */}
            <div className="flex flex-col sm:flex-row gap-4 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => navigate('/requisicoes')}
                className="flex-1 px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={loading || itensRequisicao.length === 0}
                className="flex-1 px-6 py-3 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    Criando...
                  </>
                ) : (
                  <>
                    <FaSave /> Criar Requisição
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Toast */}
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

export default CriarRequisicao;
