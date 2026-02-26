import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaSearch, FaPlus, FaEdit, FaTrash, FaFilter, FaBoxOpen, FaChevronDown, FaChevronUp, FaCheck } from 'react-icons/fa';

const ListarRequisicoes = () => {
  const [requisicoes, setRequisicoes] = useState([]);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filtros, setFiltros] = useState({
    status: '',
    armazem_id: ''
  });
  const [armazens, setArmazens] = useState([]);
  const [mostrarFiltros, setMostrarFiltros] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const isAdmin = user && user.role === 'admin';
  const canEdit = user && (user.role === 'admin' || user.role === 'controller');

  useEffect(() => {
    fetchArmazens();
  }, []);

  useEffect(() => {
    fetchRequisicoes();
  }, [filtros]);

  const fetchArmazens = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/armazens?ativo=true', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setArmazens(data);
      }
    } catch (error) {
      console.error('Erro ao buscar armazéns:', error);
    }
  };

  const fetchRequisicoes = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      const params = new URLSearchParams();
      if (filtros.status) params.append('status', filtros.status);
      if (filtros.armazem_id) params.append('armazem_id', filtros.armazem_id);

      const response = await fetch(`/api/requisicoes?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setRequisicoes(data);
      } else {
        setToast({ type: 'error', message: 'Erro ao carregar requisições' });
      }
    } catch (error) {
      console.error('Erro ao buscar requisições:', error);
      setToast({ type: 'error', message: 'Erro ao carregar requisições' });
    } finally {
      setLoading(false);
    }
  };

  const downloadExport = async (urlPath, filename, successMsg) => {
    const token = localStorage.getItem('token');
    const response = await fetch(urlPath, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) {
      let msg = 'Falha ao exportar';
      try {
        const data = await response.json();
        if (data.error) msg = data.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
    setToast({ type: 'success', message: successMsg });
  };

  const handleExportTRFL = async (reqId) => {
    try {
      await downloadExport(
        `/api/requisicoes/${reqId}/export-trfl`,
        `TRFL_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'TRFL exportada. Requisição passou a Em expedição.'
      );
      fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRFL:', error);
      const msg = error.response?.data?.error || error.message || 'Erro ao exportar TRFL';
      setToast({ type: 'error', message: msg });
    }
  };

  const handleExportTRA = async (reqId) => {
    try {
      await downloadExport(
        `/api/requisicoes/${reqId}/export-tra`,
        `TRA_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        'TRA exportada. Requisição passou a Entregue.'
      );
      fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao exportar TRA:', error);
      const msg = error.response?.data?.error || error.message || 'Erro ao exportar TRA';
      setToast({ type: 'error', message: msg });
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Excluir requisição',
      message: 'Tem certeza que deseja excluir esta requisição?',
      variant: 'danger'
    });
    if (!ok) return;

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        setToast({ type: 'success', message: 'Requisição excluída com sucesso' });
        fetchRequisicoes();
      } else {
        const data = await response.json();
        setToast({ type: 'error', message: data.error || 'Erro ao excluir requisição' });
      }
    } catch (error) {
      console.error('Erro ao excluir requisição:', error);
      setToast({ type: 'error', message: 'Erro ao excluir requisição' });
    }
  };

  const handleConfirmarSeparacao = async (reqId) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/requisicoes/${reqId}/confirmar-separacao`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Falha ao confirmar');
      }
      setToast({ type: 'success', message: 'Separação confirmada com sucesso' });
      fetchRequisicoes();
    } catch (error) {
      console.error('Erro ao confirmar separação:', error);
      setToast({ type: 'error', message: error.message || 'Erro ao confirmar separação' });
    }
  };

  const getStatusBadge = (status) => {
    const badges = {
      pendente: 'bg-yellow-100 text-yellow-800',
      separado: 'bg-green-100 text-green-800',
      'EM EXPEDICAO': 'bg-blue-100 text-blue-800',
      Entregue: 'bg-emerald-100 text-emerald-800',
      cancelada: 'bg-red-100 text-red-800'
    };
    return badges[status] || 'bg-gray-100 text-gray-800';
  };

  const getStatusLabel = (status) => {
    const labels = {
      pendente: 'Pendente',
      separado: 'Separado',
      'EM EXPEDICAO': 'Em expedição',
      Entregue: 'Entregue',
      cancelada: 'Cancelada'
    };
    return labels[status] || status;
  };

  const filteredRequisicoes = requisicoes.filter(req => {
    const searchLower = searchTerm.toLowerCase();
    return (
      req.armazem_descricao?.toLowerCase().includes(searchLower) ||
      req.usuario_nome?.toLowerCase().includes(searchLower) ||
      req.itens?.some(item => 
        item.item_codigo?.toLowerCase().includes(searchLower) ||
        item.item_descricao?.toLowerCase().includes(searchLower)
      )
    );
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto"></div>
          <p className="mt-4 text-gray-600">Carregando requisições...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Requisições</h1>
            <p className="text-gray-600">Lista de requisições. Clique em uma para preparar e atender os itens.</p>
          </div>
          {canEdit && (
            <Link
              to="/requisicoes/criar"
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors"
            >
              <FaPlus /> Nova Requisição
            </Link>
          )}
        </div>

        {/* Filtros e Busca */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Busca */}
            <div className="flex-1 relative">
              <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar por armazém, item ou usuário..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
              />
            </div>

            {/* Botão Filtros */}
            <button
              onClick={() => setMostrarFiltros(!mostrarFiltros)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
            >
              <FaFilter /> Filtros
            </button>
          </div>

          {/* Painel de Filtros */}
          {mostrarFiltros && (
            <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={filtros.status}
                  onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                >
                  <option value="">Todos</option>
                  <option value="pendente">Pendente</option>
                  <option value="separado">Separado</option>
                  <option value="EM EXPEDICAO">Em expedição</option>
                  <option value="Entregue">Entregue</option>
                  <option value="cancelada">Cancelada</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Armazém</label>
                <select
                  value={filtros.armazem_id}
                  onChange={(e) => setFiltros({ ...filtros, armazem_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                >
                  <option value="">Todos</option>
                  {armazens.map((armazem) => (
                    <option key={armazem.id} value={armazem.id}>
                      {armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : armazem.descricao}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Lista de Requisições */}
        {filteredRequisicoes.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <p className="text-gray-500 text-lg">Nenhuma requisição encontrada</p>
            {canEdit && (
              <Link
                to="/requisicoes/criar"
                className="mt-4 inline-block text-[#0915FF] hover:underline"
              >
                Criar primeira requisição
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredRequisicoes.map((req) => (
              <div
                key={req.id}
                className="bg-white rounded-lg shadow-sm overflow-hidden"
              >
                {/* Header da Requisição — clicável para expandir/recolher itens */}
                <div
                  onClick={() => setExpandedId(prev => prev === req.id ? null : req.id)}
                  className="p-6 cursor-pointer hover:bg-gray-50/50 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 flex items-start gap-3">
                      <span className="text-gray-400 mt-0.5">
                        {expandedId === req.id ? <FaChevronUp /> : <FaChevronDown />}
                      </span>
                      <div>
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <span className="text-lg font-bold text-gray-900">#{req.id}</span>
                          <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadge(req.status)}`}>
                            {getStatusLabel(req.status)}
                          </span>
                          {req.itens && req.itens.length > 0 && (
                            <span className="text-xs text-gray-500">
                              {req.itens.length} {req.itens.length === 1 ? 'item' : 'itens'} — clique para {expandedId === req.id ? 'recolher' : 'ver'}
                            </span>
                          )}
                          {req.status === 'pendente' && canEdit && (
                            <span className="text-xs text-[#0915FF] flex items-center gap-1">
                              <FaBoxOpen /> Use o botão Preparar abaixo
                            </span>
                          )}
                          {req.status === 'separado' && req.separacao_confirmada && req.separacao_confirmada_em && (
                            <span className="text-xs text-green-700 flex items-center gap-1">
                              <FaCheck /> Separação confirmada em {new Date(req.separacao_confirmada_em).toLocaleString('pt-BR')}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600 space-y-1">
                          {req.armazem_origem_descricao && (
                            <div><strong>Origem:</strong> {req.armazem_origem_descricao}</div>
                          )}
                          <div><strong>Destino:</strong> {req.armazem_descricao}</div>
                          {req.localizacao && (
                            <div><strong>Localização:</strong> {req.localizacao}</div>
                          )}
                          <div><strong>Criado por:</strong> {req.usuario_nome || 'N/A'}</div>
                          <div><strong>Data:</strong> {new Date(req.created_at).toLocaleDateString('pt-BR')}</div>
                        </div>
                      </div>
                    </div>
                  <div className="flex gap-2 mt-4 sm:mt-0 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    {(req.status === 'separado' && req.separacao_confirmada) || req.status === 'EM EXPEDICAO' || req.status === 'Entregue' ? (
                      <button
                        onClick={() => handleExportTRFL(req.id)}
                        className="px-3 py-2 text-blue-700 hover:bg-blue-50 rounded-lg border border-blue-300 transition-colors"
                        title={req.status === 'separado' ? 'Baixar TRFL — o status passará a Em expedição' : 'Baixar TRFL novamente (se perdeu o ficheiro)'}
                      >
                        {req.status === 'separado' ? 'Baixar TRFL' : 'TRFL (baixar novamente)'}
                      </button>
                    ) : null}
                    {(req.status === 'EM EXPEDICAO' || req.status === 'Entregue') && (
                      <button
                        onClick={() => handleExportTRA(req.id)}
                        className="px-3 py-2 text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-300 transition-colors"
                        title={req.status === 'EM EXPEDICAO' ? 'Baixar TRA — o status passará a Entregue' : 'Baixar TRA novamente (se perdeu o ficheiro)'}
                      >
                        {req.status === 'EM EXPEDICAO' ? 'Baixar TRA' : 'TRA (baixar novamente)'}
                      </button>
                    )}
                    {req.status === 'separado' && !req.separacao_confirmada && canEdit && (
                      <button
                        onClick={() => handleConfirmarSeparacao(req.id)}
                        className="px-3 py-2 bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg transition-colors flex items-center gap-2"
                        title="Confirmar que os itens foram recolhidos (obrigatório antes de TRFL)"
                      >
                        <FaCheck /> Confirmar separação
                      </button>
                    )}
                    {req.status === 'pendente' && canEdit && (
                      <button
                        onClick={() => navigate(`/requisicoes/preparar/${req.id}`)}
                        className="px-3 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg transition-colors flex items-center gap-2"
                      >
                        <FaBoxOpen /> Preparar
                      </button>
                    )}
                    {req.status === 'pendente' && canEdit && (
                      <button
                        onClick={() => navigate(`/requisicoes/editar/${req.id}`)}
                        className="px-3 py-2 text-[#0915FF] hover:bg-[#0915FF] hover:text-white rounded-lg transition-colors"
                        title="Editar"
                      >
                        <FaEdit />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => handleDelete(req.id)}
                        className="px-3 py-2 text-red-600 hover:bg-red-600 hover:text-white rounded-lg transition-colors"
                        title="Excluir"
                      >
                        <FaTrash />
                      </button>
                    )}
                  </div>
                  </div>
                </div>

                {/* Itens e Observações — só visíveis ao expandir */}
                {expandedId === req.id && (
                  <div className="px-6 pb-6 pt-0 border-t border-gray-200 bg-gray-50/50">
                    {req.itens && req.itens.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-medium text-gray-700 mb-2">
                          Itens ({req.itens.length})
                        </h4>
                        <div className="space-y-2">
                          {req.itens.map((item, index) => (
                            <div
                              key={item.item_id || index}
                              className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-100"
                            >
                              <div className="flex-1">
                                <div className="font-medium text-gray-900">{item.item_codigo}</div>
                                <div className="text-sm text-gray-500">{item.item_descricao}</div>
                              </div>
                              <div className="text-sm font-medium text-gray-700">
                                Qtd: <span className="text-[#0915FF]">{item.quantidade}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {req.observacoes && (
                      <div>
                        <p className="text-sm text-gray-600">
                          <strong>Observações:</strong> {req.observacoes}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

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

export default ListarRequisicoes;
