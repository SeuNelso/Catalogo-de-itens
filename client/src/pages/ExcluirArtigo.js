import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import Toast from '../components/Toast';

export default function ExcluirArtigo() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [itens, setItens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [paginaAtual, setPaginaAtual] = useState(1);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const [totalPaginas, setTotalPaginas] = useState(1); // Adicionado para controlar o total de páginas
  const [searchTerm, setSearchTerm] = useState(''); // Termo de pesquisa
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(''); // Termo de pesquisa com debounce

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const fetchItens = useCallback(async () => {
    try {
      const searchParam = debouncedSearchTerm.trim() ? `&search=${encodeURIComponent(debouncedSearchTerm.trim())}` : '';
      const response = await fetch(`/api/itens?incluirInativos=true&page=${paginaAtual}&limit=10${searchParam}`);
      if (response.ok) {
        const data = await response.json();
        setItens(data.itens || []);
        // Atualizar total de páginas baseado na resposta do servidor
        if (data.totalPages) {
          setTotalPaginas(data.totalPages);
        }
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro ao carregar itens.' });
    } finally {
      setLoading(false);
    }
  }, [debouncedSearchTerm, paginaAtual]);

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
      return;
    }
    fetchItens();
  }, [user, navigate, fetchItens]); // Removido paginaAtual pois está no useCallback

  // Debounce para o termo de pesquisa
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 500); // Aguarda 500ms após parar de digitar

    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Recarregar dados quando o termo de pesquisa com debounce mudar
  useEffect(() => {
    if (user && user.role === 'admin') {
      setPaginaAtual(1); // Reset para primeira página
      fetchItens();
    }
  }, [debouncedSearchTerm, user, fetchItens]); // Adicionado user e fetchItens às dependências

  useEffect(() => {
    function handleClickOutside(event) {
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Usar diretamente os itens do servidor (já filtrados)
  const itensPagina = itens;

  const handleDelete = async (id) => {
    if (!window.confirm('Tem certeza que deseja excluir este artigo? Esta ação não pode ser desfeita.')) return;
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/itens/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.ok) {
        setItens(prev => prev.filter(item => item.id !== id));
        setToast({ type: 'success', message: 'Artigo excluído com sucesso!' });
      } else {
        setToast({ type: 'error', message: 'Erro ao excluir artigo.' });
      }
    } catch (err) {
      setToast({ type: 'error', message: 'Erro de conexão ao excluir artigo.' });
    }
  };

  return (
    <div className="min-h-screen bg-[#e5e5e5] flex flex-col items-center pb-12 px-2 sm:px-0">
      <div className="w-full max-w-[98vw] sm:max-w-[1200px] mx-auto mt-4 sm:mt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] mx-auto flex flex-col items-center p-4 sm:p-8 w-full gap-4 sm:gap-6">
          <h1 className="text-xl sm:text-2xl font-bold text-[#0915FF] mb-4 sm:mb-6 text-center">Excluir Artigos</h1>
          
          {/* Campo de pesquisa */}
          <div className="w-full max-w-md mx-auto mb-6">
            <div className="relative">
              <input
                type="text"
                placeholder="Pesquisar por código ou descrição..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full px-4 py-3 pl-10 pr-4 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  <svg className="h-5 w-5 text-gray-400 hover:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          
          {loading ? (
            <div className="text-center text-gray-500">Carregando...</div>
          ) : (
            <div className="w-full">
              {isMobile ? (
                <div className="flex flex-col gap-4 items-center w-full">
                  {itensPagina.length === 0 ? (
                    <div className="text-center text-gray-400 py-8">
                      {searchTerm ? 'Nenhum artigo encontrado para a pesquisa.' : 'Nenhum artigo encontrado.'}
                    </div>
                  ) : (
                    itensPagina.map(item => (
                      <div key={item.id} className="bg-white rounded-xl shadow border border-[#d1d5db] w-full max-w-[400px] p-4 flex flex-col gap-2">
                        <div className="font-bold text-[#0915FF] text-base">Código: <span className="text-[#222]">{item.codigo}</span></div>
                        <div className="text-[#444] text-sm font-medium">Descrição: <span className="text-[#222] font-normal">{item.nome}</span></div>
                        <div className="text-[#444] text-sm font-medium">
                          Status: 
                          <span className={`ml-1 font-normal ${item.ativo ? 'text-green-600' : 'text-red-600'}`}>
                            {item.ativo ? 'Ativo' : 'Inativo'}
                          </span>
                        </div>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="mt-2 bg-red-600 text-white rounded-lg px-3 py-2 font-bold text-xs w-full hover:bg-red-700 transition"
                        >
                          Excluir
                        </button>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl">
                  <table className="min-w-full text-xs sm:text-base">
                    <thead>
                      <tr className="bg-gradient-to-r from-[#0a1fff] to-[#3b82f6] text-white font-bold">
                        <th className="py-3 px-4 text-center font-mono">CÓDIGO</th>
                        <th className="py-3 px-4 text-left">DESCRIÇÃO</th>
                        <th className="py-3 px-4 text-center">STATUS</th>
                        <th className="py-3 px-4">AÇÃO</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itensPagina.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-center text-gray-400 py-8">
                            {searchTerm ? 'Nenhum artigo encontrado para a pesquisa.' : 'Nenhum artigo encontrado.'}
                          </td>
                        </tr>
                      ) : (
                        itensPagina.map(item => (
                          <tr key={item.id} className="hover:bg-blue-50 transition border-b border-[#d1d5db] last:border-b-0">
                            <td className="py-2 px-4 text-center font-mono text-[#0915FF]">{item.codigo}</td>
                            <td className="py-2 px-4 whitespace-nowrap overflow-hidden text-ellipsis max-w-xs">{item.nome}</td>
                            <td className="py-2 px-4 text-center">
                              <span className={`px-2 py-1 rounded-full text-xs font-semibold ${item.ativo ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                {item.ativo ? 'Ativo' : 'Inativo'}
                              </span>
                            </td>
                            <td className="py-2 px-4">
                              <button
                                onClick={() => handleDelete(item.id)}
                                className="px-4 py-1 rounded-lg bg-red-600 text-white font-semibold text-xs hover:bg-red-700 transition"
                              >
                                Excluir
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Paginação igual ao catálogo */}
              <div className="flex flex-wrap justify-center items-center gap-2 mt-6">
                <button
                  onClick={() => setPaginaAtual(p => Math.max(1, p - 1))}
                  disabled={paginaAtual === 1}
                  className="paginacao-btn"
                >
                  Anterior
                </button>
                {(() => {
                  const botoes = [];
                  const mostrar = 2;
                  const vizinhos = 2;
                  for (let p = 1; p <= totalPaginas; p++) {
                    if (
                      p <= mostrar ||
                      p > totalPaginas - mostrar ||
                      (p >= paginaAtual - vizinhos && p <= paginaAtual + vizinhos)
                    ) {
                      botoes.push(
                        <button
                          key={p}
                          onClick={() => setPaginaAtual(p)}
                          className={
                            paginaAtual === p
                              ? "paginacao-btn bg-[#0915FF] text-white font-bold border border-[#0915FF] rounded px-2 mx-1"
                              : "paginacao-btn border border-[#d1d5db] rounded px-2 mx-1"
                          }
                        >
                          {p}
                        </button>
                      );
                    } else if (
                      (p === mostrar + 1 && paginaAtual - vizinhos > mostrar + 1) ||
                      (p === totalPaginas - mostrar && paginaAtual + vizinhos < totalPaginas - mostrar)
                    ) {
                      botoes.push(
                        <span key={p} className="min-w-[24px] text-center text-[#0915FF]">...</span>
                      );
                    }
                  }
                  return botoes;
                })()}
                <button
                  onClick={() => setPaginaAtual(p => Math.min(totalPaginas, p + 1))}
                  disabled={paginaAtual === totalPaginas}
                  className="paginacao-btn"
                >
                  Próximo
                </button>
              </div>
            </div>
          )}
          {toast && (
            <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
          )}
        </div>
      </div>
    </div>
  );
} 