import React, { useEffect, useState, useRef } from 'react';
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
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
      return;
    }
    fetchItens();
  }, [user, navigate]);

  useEffect(() => {
    setPaginaAtual(1);
  }, [paginaAtual]);

  useEffect(() => {
    function handleClickOutside(event) {
      // Remover referências a filtros não utilizados
      // if (codigoFiltroRef.current && !codigoFiltroRef.current.contains(event.target)) {
      //   setShowCodigoFiltro(false);
      // }
      // if (descricaoFiltroRef.current && !descricaoFiltroRef.current.contains(event.target)) {
      //   setShowDescricaoFiltro(false);
      // }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const fetchItens = async () => {
    try {
      const response = await fetch('/api/itens');
      if (response.ok) {
        const data = await response.json();
        setItens(Array.isArray(data.itens) ? data.itens : data); // Suporta ambos formatos
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro ao carregar itens.' });
    } finally {
      setLoading(false);
    }
  };

  // Filtro instantâneo
  const itensFiltrados = itens.filter(item => {
    const codigoOk = true; // Sem filtro de código
    const descricaoOk = true; // Sem filtro de descrição
    return codigoOk && descricaoOk;
  });
  const totalPaginas = Math.ceil(itensFiltrados.length / 10); // itensPorPagina foi removido
  const itensPagina = itensFiltrados.slice((paginaAtual - 1) * 10, paginaAtual * 10); // itensPorPagina foi removido

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

  const handleDeleteAll = async () => {
    setDeletingAll(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/limpar-banco', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        setItens([]);
        setToast({ type: 'success', message: 'Todos os dados foram excluídos!' });
      } else {
        setToast({ type: 'error', message: 'Erro ao excluir todos os dados.' });
      }
    } catch (err) {
      setToast({ type: 'error', message: 'Erro de conexão ao excluir todos.' });
    } finally {
      setDeletingAll(false);
      setShowConfirmModal(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#e5e5e5] flex flex-col items-center pb-12 px-2 sm:px-0">
      <div className="w-full max-w-[98vw] sm:max-w-[1200px] mx-auto mt-4 sm:mt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] mx-auto flex flex-col items-center p-4 sm:p-8 w-full gap-4 sm:gap-6">
          <h1 className="text-xl sm:text-2xl font-bold text-[#0915FF] mb-4 sm:mb-6 text-center">Excluir Artigos</h1>
          {/* Botão Excluir Todos */}
          {itens.length > 0 && (
            <button
              onClick={async () => {
                if (!window.confirm('Tem certeza que deseja excluir TODOS os artigos? Esta ação não pode ser desfeita.')) return;
                try {
                  const token = localStorage.getItem('token');
                  const response = await fetch('/api/itens', {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                  });
                  if (response.ok) {
                    setItens([]);
                    setToast({ type: 'success', message: 'Todos os artigos foram excluídos!' });
                  } else {
                    setToast({ type: 'error', message: 'Erro ao excluir todos os artigos.' });
                  }
                } catch (err) {
                  setToast({ type: 'error', message: 'Erro de conexão ao excluir todos.' });
                }
              }}
              className="mb-4 px-6 py-2 rounded-lg bg-red-700 text-white font-bold text-sm hover:bg-red-800 transition-all shadow"
            >
              Excluir Todos
            </button>
          )}
          {/* Botão Excluir itens não cadastrados */}
          <button
            onClick={() => {
              localStorage.removeItem('artigos_nao_cadastrados');
              setToast({ type: 'success', message: 'Itens não cadastrados removidos com sucesso!' });
            }}
            className="mb-4 px-6 py-2 rounded-lg bg-yellow-600 text-black font-bold text-sm hover:bg-yellow-700 transition-all shadow"
          >
            Excluir Itens Não Cadastrados
          </button>
          {/* Botão Excluir TODOS os dados */}
          <div className="my-4 text-center">
            <button
              onClick={() => setShowConfirmModal(true)}
              className="mb-4 px-6 py-2 rounded-lg bg-yellow-600 text-black font-bold text-sm hover:bg-yellow-700 transition-all shadow"
            >
              Excluir TODOS os dados do banco
            </button>
          </div>
          {showConfirmModal && (
            <div className="fixed inset-0 bg-black/35 z-50 flex items-center justify-center">
              <div className="bg-white rounded-2xl p-6 sm:p-8 max-w-xs w-[90vw] shadow-xl text-center">
                <h2 className="text-red-700 font-extrabold text-lg sm:text-2xl mb-3">Tem certeza?</h2>
                <p className="text-gray-700 text-sm sm:text-base mb-4">
                  Esta ação irá <b>apagar TODOS os dados do banco</b> (itens, estoques, etc).<br />
                  <b>Não poderá ser desfeita!</b>
                </p>
                <button
                  onClick={handleDeleteAll}
                  disabled={deletingAll}
                  className="bg-red-700 text-white font-bold rounded-lg px-6 py-2 mr-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {deletingAll ? 'Excluindo...' : 'Sim, apagar tudo'}
                </button>
                <button
                  onClick={() => setShowConfirmModal(false)}
                  className="bg-gray-200 text-gray-800 font-semibold rounded-lg px-4 py-2 ml-2"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <div className="text-center text-gray-500">Carregando...</div>
          ) : (
            <div className="w-full">
              {isMobile ? (
                <div className="flex flex-col gap-4 items-center w-full">
                  {itensPagina.length === 0 ? (
                    <div className="text-center text-gray-400 py-8">Nenhum artigo encontrado.</div>
                  ) : (
                    itensPagina.map(item => (
                      <div key={item.id} className="bg-white rounded-xl shadow border border-[#d1d5db] w-full max-w-[400px] p-4 flex flex-col gap-2">
                        <div className="font-bold text-[#0915FF] text-base">Código: <span className="text-[#222]">{item.codigo}</span></div>
                        <div className="text-[#444] text-sm font-medium">Descrição: <span className="text-[#222] font-normal">{item.nome}</span></div>
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
                        <th className="py-3 px-4">AÇÃO</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itensPagina.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="text-center text-gray-400 py-8">Nenhum artigo encontrado.</td>
                        </tr>
                      ) : (
                        itensPagina.map(item => (
                          <tr key={item.id} className="hover:bg-blue-50 transition border-b border-[#d1d5db] last:border-b-0">
                            <td className="py-2 px-4 text-center font-mono text-[#0915FF]">{item.codigo}</td>
                            <td className="py-2 px-4 whitespace-nowrap overflow-hidden text-ellipsis max-w-xs">{item.nome}</td>
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