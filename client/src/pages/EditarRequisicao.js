import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';
import { FaArrowLeft, FaSave, FaPlus, FaTrash } from 'react-icons/fa';
import axios from 'axios';

const EditarRequisicao = () => {
  const { id } = useParams();
  const [formData, setFormData] = useState({
    armazem_origem_id: '',
    armazem_id: '',
    status: 'pendente',
    observacoes: ''
  });
  const [itens, setItens] = useState([]);
  const [armazens, setArmazens] = useState([]);
  const [itensRequisicao, setItensRequisicao] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [toast, setToast] = useState(null);
  const [buscaItem, setBuscaItem] = useState('');
  const [itensFiltrados, setItensFiltrados] = useState([]);
  const [mostrarListaItens, setMostrarListaItens] = useState(false);
  const [itemSelecionado, setItemSelecionado] = useState(null);
  const [quantidadeAtual, setQuantidadeAtual] = useState('');
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user && user.role === 'admin';
  const canEdit = user && (user.role === 'admin' || user.role === 'controller');

  useEffect(() => {
    fetchRequisicao();
    fetchItens();
    fetchArmazens();
  }, [id]);

  useEffect(() => {
    if (buscaItem.trim()) {
      const filtrados = itens.filter(item =>
        item.codigo.toLowerCase().includes(buscaItem.toLowerCase()) ||
        item.descricao.toLowerCase().includes(buscaItem.toLowerCase())
      ).slice(0, 10);
      setItensFiltrados(filtrados);
      setMostrarListaItens(true);
    } else {
      setItensFiltrados([]);
      setMostrarListaItens(false);
    }
  }, [buscaItem, itens]);

  const fetchRequisicao = async () => {
    try {
      setLoadingData(true);
      const token = localStorage.getItem('token');
      const response = await axios.get(`/api/requisicoes/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.data) {
        const req = response.data;
        setFormData({
          armazem_origem_id: req.armazem_origem_id || '',
          armazem_id: req.armazem_id,
          status: req.status,
          observacoes: req.observacoes || ''
        });
        // Carregar itens da requisição
        if (req.itens && Array.isArray(req.itens)) {
          setItensRequisicao(req.itens.map(item => ({
            item_id: item.item_id,
            quantidade: item.quantidade,
            item_codigo: item.item_codigo,
            item_descricao: item.item_descricao
          })));
        }
      }
    } catch (error) {
      console.error('Erro ao buscar requisição:', error);
      setToast({ type: 'error', message: 'Erro ao carregar requisição' });
      navigate('/requisicoes');
    } finally {
      setLoadingData(false);
    }
  };

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
    }
  };

  const handleItemSelect = (item) => {
    setItemSelecionado(item);
    setBuscaItem(`${item.codigo} - ${item.descricao}`);
    setMostrarListaItens(false);
  };

  const handleAddItem = () => {
    if (!itemSelecionado || !quantidadeAtual || parseInt(quantidadeAtual) <= 0) {
      setToast({ type: 'error', message: 'Selecione um item e informe uma quantidade válida' });
      return;
    }

    const itemExistente = itensRequisicao.find(ri => ri.item_id === itemSelecionado.id);
    if (itemExistente) {
      setItensRequisicao(itensRequisicao.map(ri => 
        ri.item_id === itemSelecionado.id 
          ? { ...ri, quantidade: parseInt(quantidadeAtual) }
          : ri
      ));
    } else {
      setItensRequisicao([...itensRequisicao, {
        item_id: itemSelecionado.id,
        quantidade: parseInt(quantidadeAtual),
        item_codigo: itemSelecionado.codigo,
        item_descricao: itemSelecionado.descricao
      }]);
    }

    setItemSelecionado(null);
    setBuscaItem('');
    setQuantidadeAtual('');
  };

  const handleRemoveItem = (itemId) => {
    setItensRequisicao(itensRequisicao.filter(ri => ri.item_id !== itemId));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.armazem_id) {
      setToast({ type: 'error', message: 'Selecione um armazém destino' });
      return;
    }

    if (itensRequisicao.length === 0) {
      setToast({ type: 'error', message: 'A requisição deve ter pelo menos um item' });
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
        status: formData.status,
        observacoes: formData.observacoes || null
      };

      const response = await axios.put(`/api/requisicoes/${id}`, payload, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 200) {
        setToast({ type: 'success', message: 'Requisição atualizada com sucesso!' });
        setTimeout(() => {
          navigate('/requisicoes');
        }, 1500);
      }
    } catch (error) {
      console.error('Erro ao atualizar requisição:', error);
      const errorMessage = error.response?.data?.error || 'Erro ao atualizar requisição';
      setToast({ type: 'error', message: errorMessage });
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  if (loadingData) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto"></div>
          <p className="mt-4 text-gray-600">Carregando requisição...</p>
        </div>
      </div>
    );
  }

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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Editar Requisição #{id}</h1>
          <p className="text-gray-600">Atualize as informações da requisição</p>
        </div>

        {/* Form */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Armazém Origem */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Armazém Origem
              </label>
              <select
                name="armazem_origem_id"
                value={formData.armazem_origem_id}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
              >
                <option value="">Selecione o armazém de origem</option>
                {armazens.map((armazem) => (
                  <option key={armazem.id} value={armazem.id}>
                    {armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : armazem.descricao}
                  </option>
                ))}
              </select>
            </div>

            {/* Armazém Destino */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Armazém Destino <span className="text-red-500">*</span>
              </label>
              <select
                name="armazem_id"
                value={formData.armazem_id}
                onChange={handleChange}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
              >
                <option value="">Selecione o armazém destino</option>
                {armazens.map((armazem) => (
                  <option key={armazem.id} value={armazem.id}>
                    {armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : armazem.descricao}
                  </option>
                ))}
              </select>
            </div>

            {/* Status (permite cancelar) */}
            {canEdit && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Status
                </label>
                <select
                  name="status"
                  value={formData.status}
                  onChange={handleChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                >
                  <option value="pendente">Pendente</option>
                  <option value="atendida">Atendida</option>
                  <option value="cancelada">Cancelada</option>
                </select>
                <p className="mt-1 text-sm text-gray-500">Para atender a requisição, use &quot;Preparar&quot; na lista</p>
              </div>
            )}

            {/* Adicionar/Editar Itens */}
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
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                      />
                      {mostrarListaItens && itensFiltrados.length > 0 && (
                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                          {itensFiltrados.map((item) => (
                            <div
                              key={item.id}
                              onClick={() => handleItemSelect(item)}
                              className="px-4 py-2 hover:bg-gray-100 cursor-pointer border-b border-gray-200 last:border-b-0"
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
                      type="number"
                      value={quantidadeAtual}
                      onChange={(e) => setQuantidadeAtual(e.target.value)}
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

              {/* Lista de Itens */}
              {itensRequisicao.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Itens ({itensRequisicao.length})</h4>
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
                    Salvando...
                  </>
                ) : (
                  <>
                    <FaSave /> Salvar Alterações
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

export default EditarRequisicao;
