import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';
import { FaArrowLeft, FaSave, FaPlus, FaTrash, FaChevronDown } from 'react-icons/fa';
import axios from 'axios';

const CriarRequisicao = () => {
  const [formData, setFormData] = useState({
    armazem_origem_id: '',
    armazem_id: '',
    observacoes: ''
  });
  const [itens, setItens] = useState([]);
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
  const refOrigem = useRef(null);
  const refDestino = useRef(null);
  const refQuantidadeInput = useRef(null);
  const refBuscaItem = useRef(null);
  const refListaItens = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    fetchItens();
    fetchArmazens();
  }, []);

  useEffect(() => {
    if (buscaItem.trim()) {
      const filtrados = itens.filter(item =>
        item.codigo.toLowerCase().includes(buscaItem.toLowerCase()) ||
        item.descricao.toLowerCase().includes(buscaItem.toLowerCase())
      ).slice(0, 10);
      setItensFiltrados(filtrados);
      setMostrarListaItens(true);
      setSelectedItemIndex(filtrados.length > 0 ? 0 : -1);
    } else {
      setItensFiltrados([]);
      setMostrarListaItens(false);
      setSelectedItemIndex(-1);
    }
  }, [buscaItem, itens]);

  useEffect(() => {
    if (mostrarListaItens && selectedItemIndex >= 0 && refListaItens.current) {
      const el = refListaItens.current.querySelector(`[data-item-index="${selectedItemIndex}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedItemIndex, mostrarListaItens]);

  const fetchItens = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/itens?ativo=true&limit=1000', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.data) {
        setItens(response.data.itens || response.data || []);
      }
    } catch (error) {
      console.error('Erro ao buscar itens:', error);
      setToast({ type: 'error', message: 'Erro ao carregar itens' });
    }
  };

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
    setItemSelecionado(item);
    setBuscaItem(`${item.codigo} - ${item.descricao}`);
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
          ? { ...ri, quantidade: parseInt(quantidadeAtual) }
          : ri
      ));
    } else {
      // Adicionar novo item
      setItensRequisicao([...itensRequisicao, {
        item_id: itemSelecionado.id,
        quantidade: parseInt(quantidadeAtual),
        item_codigo: itemSelecionado.codigo,
        item_descricao: itemSelecionado.descricao
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

  const armazensOrigemFiltrados = filterArmazens(armazens, buscaArmazemOrigem);
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Buscar Item
                    </label>
                    <div className="relative">
                      <input
                        ref={refBuscaItem}
                        type="text"
                        placeholder="Buscar item por código ou descrição..."
                        value={buscaItem}
                        onChange={(e) => {
                          setBuscaItem(e.target.value);
                          if (!e.target.value) {
                            setItemSelecionado(null);
                          }
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
                      {mostrarListaItens && itensFiltrados.length > 0 && (
                        <div
                          ref={refListaItens}
                          className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto"
                        >
                          {itensFiltrados.map((item, index) => (
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
                              <div className="text-sm text-gray-500">{item.descricao}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
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
                </div>
                <button
                  type="button"
                  onClick={handleAddItem}
                  className="mt-4 w-full md:w-auto px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors flex items-center justify-center gap-2"
                >
                  <FaPlus /> Adicionar Item
                </button>
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
