import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';
import { AlertTriangle, Plus, ArrowLeft, Search, ChevronLeft, ChevronRight } from 'react-feather';

const ItensNaoCadastrados = () => {
  const [naoCadastrados, setNaoCadastrados] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  // Estados para paginação e filtros
  const [paginaAtual, setPaginaAtual] = useState(1);
  const [itensPorPagina] = useState(20);
  const [searchTerm, setSearchTerm] = useState('');

  // Verificar se o usuário tem permissão
  const isAdmin = user && user.role === 'admin';
  const isController = user && user.role === 'controller';
  const canAccess = isAdmin || isController;

  useEffect(() => {
    if (!canAccess) {
      setToast({
        type: 'error',
        message: 'Acesso negado. Apenas administradores e controllers podem acessar esta página.'
      });
      return;
    }

    fetchNaoCadastrados();
  }, [canAccess]);

  const fetchNaoCadastrados = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await fetch('/api/itens-nao-cadastrados', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setNaoCadastrados(data);
      } else {
        const errorData = await response.json();
        setToast({
          type: 'error',
          message: errorData.error || 'Erro ao buscar itens não cadastrados'
        });
      }
    } catch (error) {
      console.error('Erro ao buscar itens não cadastrados:', error);
      setToast({
        type: 'error',
        message: 'Erro ao conectar com o servidor'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCadastrar = (item) => {
    navigate(`/cadastrar?codigo=${encodeURIComponent(item.codigo)}&descricao=${encodeURIComponent(item.descricao)}`);
  };

  const handleLimparTodos = async () => {
    if (!window.confirm('Tem certeza que deseja remover todos os itens não cadastrados? Esta ação não pode ser desfeita.')) {
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/itens-nao-cadastrados', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        setNaoCadastrados([]);
        setToast({
          type: 'success',
          message: 'Todos os itens não cadastrados foram removidos'
        });
      } else {
        const errorData = await response.json();
        setToast({
          type: 'error',
          message: errorData.error || 'Erro ao remover itens não cadastrados'
        });
      }
    } catch (error) {
      console.error('Erro ao remover itens não cadastrados:', error);
      setToast({
        type: 'error',
        message: 'Erro ao conectar com o servidor'
      });
    }
  };

  // Filtrar itens baseado no termo de busca
  const itensFiltrados = naoCadastrados.filter(item =>
    item.codigo.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.descricao.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Calcular paginação
  const totalPaginas = Math.ceil(itensFiltrados.length / itensPorPagina);
  const inicio = (paginaAtual - 1) * itensPorPagina;
  const fim = inicio + itensPorPagina;
  const itensPagina = itensFiltrados.slice(inicio, fim);

  // Funções de paginação
  const irParaPagina = (pagina) => {
    setPaginaAtual(Math.max(1, Math.min(pagina, totalPaginas)));
  };

  const proximaPagina = () => {
    if (paginaAtual < totalPaginas) {
      setPaginaAtual(paginaAtual + 1);
    }
  };

  const paginaAnterior = () => {
    if (paginaAtual > 1) {
      setPaginaAtual(paginaAtual - 1);
    }
  };

  // Resetar busca
  const limparBusca = () => {
    setSearchTerm('');
    setPaginaAtual(1);
  };

  if (!canAccess) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full">
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Acesso Negado</h2>
            <p className="text-gray-600 mb-6">
              Apenas administradores e controllers podem acessar esta página.
            </p>
            <Link
              to="/"
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Voltar ao Início
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <button
                onClick={() => navigate(-1)}
                className="mr-4 p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <ArrowLeft className="w-5 h-5 text-gray-600" />
              </button>
              <h1 className="text-2xl font-bold text-gray-900">Itens Não Cadastrados</h1>
            </div>
            <div className="flex items-center space-x-4">
              <button
                onClick={fetchNaoCadastrados}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Atualizar
              </button>
              {naoCadastrados.length > 0 && (
                <button
                  onClick={handleLimparTodos}
                  className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
                >
                  Limpar Todos
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        ) : naoCadastrados.length === 0 ? (
          <div className="text-center py-12">
            <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-900 mb-2">
              Nenhum item não cadastrado encontrado
            </h3>
            <p className="text-gray-600 mb-6">
              Todos os itens foram cadastrados ou não há itens pendentes.
            </p>
            <Link
              to="/"
              className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors inline-flex items-center"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Voltar ao Catálogo
            </Link>
          </div>
        ) : (
          <div>
            {/* Stats e Controles */}
            <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {naoCadastrados.length} item{naoCadastrados.length !== 1 ? 's' : ''} não cadastrado{naoCadastrados.length !== 1 ? 's' : ''}
                  </h2>
                  <p className="text-sm text-gray-600 mt-1">
                    Mostrando {itensPagina.length} de {itensFiltrados.length} itens
                  </p>
                </div>
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                  <span className="text-sm text-yellow-700 font-medium">Pendentes</span>
                </div>
              </div>

              {/* Barra de Busca */}
              <div className="mt-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <input
                    type="text"
                    placeholder="Buscar por código ou descrição..."
                    value={searchTerm}
                    onChange={(e) => {
                      setSearchTerm(e.target.value);
                      setPaginaAtual(1);
                    }}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {searchTerm && (
                    <button
                      onClick={limparBusca}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Paginação Superior */}
            {totalPaginas > 1 && (
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm text-gray-600">
                  Página {paginaAtual} de {totalPaginas}
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={paginaAnterior}
                    disabled={paginaAtual === 1}
                    className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={proximaPagina}
                    disabled={paginaAtual === totalPaginas}
                    className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Items Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {itensPagina.map((item, index) => (
                <div
                  key={index}
                  className="bg-white rounded-lg shadow-sm border border-yellow-200 hover:shadow-md transition-shadow"
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <h3 className="font-bold text-lg text-yellow-700 mb-1 truncate">
                          {item.codigo}
                        </h3>
                        <p className="text-gray-700 text-sm leading-relaxed line-clamp-3">
                          {item.descricao}
                        </p>
                      </div>
                    </div>

                    {/* Informações compactas */}
                    <div className="space-y-2 mb-4">
                      {/* Armazéns info - apenas se houver */}
                      {item.armazens && Object.keys(item.armazens).length > 0 && (
                        <div className="text-xs">
                          <span className="font-medium text-gray-600">Armazéns: </span>
                          <span className="text-gray-700">
                            {Object.keys(item.armazens).length} local(is)
                          </span>
                        </div>
                      )}

                      {/* Data de importação */}
                      {item.data_importacao && (
                        <div className="text-xs text-gray-500">
                          {new Date(item.data_importacao).toLocaleDateString('pt-BR')}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => handleCadastrar(item)}
                      className="w-full bg-yellow-500 text-white py-2 px-3 rounded-lg hover:bg-yellow-600 transition-colors flex items-center justify-center text-sm"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Cadastrar
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Paginação Inferior */}
            {totalPaginas > 1 && (
              <div className="flex items-center justify-center mt-8">
                <div className="flex items-center space-x-2">
                  <button
                    onClick={paginaAnterior}
                    disabled={paginaAtual === 1}
                    className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Anterior
                  </button>
                  
                  {/* Números das páginas */}
                  <div className="flex items-center space-x-1">
                    {Array.from({ length: Math.min(5, totalPaginas) }, (_, i) => {
                      let pagina;
                      if (totalPaginas <= 5) {
                        pagina = i + 1;
                      } else if (paginaAtual <= 3) {
                        pagina = i + 1;
                      } else if (paginaAtual >= totalPaginas - 2) {
                        pagina = totalPaginas - 4 + i;
                      } else {
                        pagina = paginaAtual - 2 + i;
                      }
                      
                      return (
                        <button
                          key={pagina}
                          onClick={() => irParaPagina(pagina)}
                          className={`px-3 py-2 rounded-lg border ${
                            pagina === paginaAtual
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          {pagina}
                        </button>
                      );
                    })}
                  </div>
                  
                  <button
                    onClick={proximaPagina}
                    disabled={paginaAtual === totalPaginas}
                    className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Próxima
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
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
  );
};

export default ItensNaoCadastrados; 