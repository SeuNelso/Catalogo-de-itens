import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import Toast from '../components/Toast';
import styles from './ListarItens.module.css';

export default function ExcluirArtigo() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [itens, setItens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [paginaAtual, setPaginaAtual] = useState(1);
  const [showCodigoFiltro, setShowCodigoFiltro] = useState(false);
  const [showDescricaoFiltro, setShowDescricaoFiltro] = useState(false);
  const [codigoFiltro, setCodigoFiltro] = useState('');
  const [descricaoFiltro, setDescricaoFiltro] = useState('');
  const codigoFiltroRef = useRef(null);
  const descricaoFiltroRef = useRef(null);
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
  }, [codigoFiltro, descricaoFiltro]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (codigoFiltroRef.current && !codigoFiltroRef.current.contains(event.target)) {
        setShowCodigoFiltro(false);
      }
      if (descricaoFiltroRef.current && !descricaoFiltroRef.current.contains(event.target)) {
        setShowDescricaoFiltro(false);
      }
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
    const codigoOk = codigoFiltro === '' || (item.codigo || '').toString().toLowerCase().includes(codigoFiltro.toLowerCase());
    const descricaoOk = descricaoFiltro === '' || (item.nome || '').toLowerCase().includes(descricaoFiltro.toLowerCase());
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
    <div className="min-h-screen bg-[#e5e5e5] flex flex-col items-center pb-12">
      <div style={{ width: '100%', maxWidth: isMobile ? '100%' : '1200px', margin: isMobile ? '16px auto 0 auto' : '40px auto 0 auto', display: 'block' }}>
        <div className={styles['catalogo-card']} style={{ margin: '0 auto', boxShadow: '0 8px 32px rgba(9,21,255,0.08)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: isMobile ? 12 : undefined, width: '100%' }}>
          <h1 className="text-2xl font-bold text-[#0915FF] mb-6 text-center">Excluir Artigos</h1>
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
              className="mb-6 px-6 py-2 rounded bg-red-700 text-black font-bold text-sm hover:bg-red-800 transition-all shadow"
              style={{ display: 'block', marginLeft: 'auto', marginRight: 'auto' }}
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
            className="mb-4 px-6 py-2 rounded bg-yellow-600 text-black font-bold text-sm hover:bg-yellow-700 transition-all shadow"
            style={{ display: 'block', marginLeft: 'auto', marginRight: 'auto' }}
          >
            Excluir Itens Não Cadastrados
          </button>
          {/* Botão Excluir TODOS os dados */}
          <div style={{ margin: '24px 0', textAlign: 'center' }}>
            <button
              onClick={() => setShowConfirmModal(true)}
              className="mb-4 px-6 py-2 rounded bg-yellow-600 text-black font-bold text-sm hover:bg-yellow-700 transition-all shadow"
            >
              Excluir TODOS os dados do banco
            </button>
          </div>
          {showConfirmModal && (
            <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.35)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 340, width: '90%', boxShadow: '0 8px 32px rgba(239,68,68,0.18)', textAlign: 'center' }}>
                <h2 style={{ color: '#b91c1c', fontWeight: 800, fontSize: 22, marginBottom: 18 }}>Tem certeza?</h2>
                <p style={{ color: '#444', fontSize: 16, marginBottom: 24 }}>
                  Esta ação irá <b>apagar TODOS os dados do banco</b> (itens, estoques, etc).<br />
                  <b>Não poderá ser desfeita!</b>
                </p>
                <button
                  onClick={handleDeleteAll}
                  disabled={deletingAll}
                  style={{ background: '#b91c1c', color: '#fff', fontWeight: 700, borderRadius: 8, padding: '10px 28px', fontSize: 16, border: 'none', marginRight: 12, cursor: deletingAll ? 'not-allowed' : 'pointer' }}
                >
                  {deletingAll ? 'Excluindo...' : 'Sim, apagar tudo'}
                </button>
                <button
                  onClick={() => setShowConfirmModal(false)}
                  style={{ background: '#eee', color: '#222', fontWeight: 600, borderRadius: 8, padding: '10px 18px', fontSize: 16, border: 'none', marginLeft: 12, cursor: 'pointer' }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <div className="text-center text-gray-500">Carregando...</div>
          ) : (
            <div className={styles['catalogo-conteudo']} style={{ width: '100%' }}>
              {isMobile ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', width: '100%' }}>
                  {itensPagina.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#888', padding: '32px 0' }}>Nenhum artigo encontrado.</div>
                  ) : (
                    itensPagina.map(item => (
                      <div key={item.id} style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(9,21,255,0.08)', border: '1.5px solid #d1d5db', width: '95%', maxWidth: 400, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontWeight: 700, color: '#0915FF', fontSize: 16 }}>Código: <span style={{ color: '#222' }}>{item.codigo}</span></div>
                        <div style={{ color: '#444', fontSize: 15, fontWeight: 500 }}>Descrição: <span style={{ color: '#222', fontWeight: 400 }}>{item.nome}</span></div>
                        <button
                          onClick={() => handleDelete(item.id)}
                          style={{ marginTop: 8, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 700, fontSize: 15, cursor: 'pointer', width: '100%' }}
                        >
                          Excluir
                        </button>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <table className={styles['catalogo-tabela']} style={{ margin: '0 auto', width: '100%', minWidth: 600, maxWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ whiteSpace: 'nowrap', textAlign: 'center', fontFamily: 'monospace', position: 'relative', cursor: 'pointer' }} onClick={() => setShowCodigoFiltro(v => !v)}>
                        CÓDIGO
                        <br />
                        {showCodigoFiltro && (
                          <input
                            ref={codigoFiltroRef}
                            type="text"
                            value={codigoFiltro}
                            onChange={e => setCodigoFiltro(e.target.value)}
                            placeholder="Filtrar"
                            style={{ width: 70, border: '1px solid #e0e7ef', borderRadius: 5, padding: '2px 6px', fontSize: 12, marginTop: 2, background: '#f7fafd', color: '#222', position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 28, zIndex: 10, boxShadow: '0 2px 8px rgba(9,21,255,0.06)' }}
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                        )}
                      </th>
                      <th style={{ whiteSpace: 'nowrap', textAlign: 'left', position: 'relative', cursor: 'pointer' }} onClick={() => setShowDescricaoFiltro(v => !v)}>
                        DESCRIÇÃO
                        <br />
                        {showDescricaoFiltro && (
                          <input
                            ref={descricaoFiltroRef}
                            type="text"
                            value={descricaoFiltro}
                            onChange={e => setDescricaoFiltro(e.target.value)}
                            placeholder="Filtrar"
                            style={{ width: 120, border: '1px solid #e0e7ef', borderRadius: 5, padding: '2px 6px', fontSize: 12, marginTop: 2, background: '#f7fafd', color: '#222', position: 'absolute', left: 0, top: 28, zIndex: 10, boxShadow: '0 2px 8px rgba(9,21,255,0.06)' }}
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                        )}
                      </th>
                      <th style={{ whiteSpace: 'nowrap' }}>AÇÃO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itensPagina.length === 0 ? (
                      <tr>
                        <td colSpan={3} style={{ textAlign: 'center', color: '#888', padding: '32px 0' }}>Nenhum artigo encontrado.</td>
                      </tr>
                    ) : (
                      itensPagina.map(item => (
                        <tr key={item.id} className="hover:bg-[#F0F4FF] transition">
                          <td className={styles['catalogo-link']} style={{ fontFamily: 'monospace', color: '#0915FF', textAlign: 'center' }}>{item.codigo}</td>
                          <td className="description-cell" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.nome}</td>
                          <td>
                            <button
                              onClick={() => handleDelete(item.id)}
                              className="px-4 py-1 rounded bg-red-600 text-black font-semibold text-xs hover:bg-red-700 transition-all"
                            >
                              Excluir
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
              {/* Paginação igual ao catálogo */}
              <div className={styles['paginacao']}>
                <button
                  onClick={() => setPaginaAtual(p => Math.max(1, p - 1))}
                  disabled={paginaAtual === 1}
                  className={styles['paginacao-btn']}
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
                              ? `${styles['paginacao-btn']} ${styles['ativo']}`
                              : styles['paginacao-btn']
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
                        <span key={p} style={{ minWidth: 24, textAlign: 'center', color: '#0915FF' }}>...</span>
                      );
                    }
                  }
                  return botoes;
                })()}
                <button
                  onClick={() => setPaginaAtual(p => Math.min(totalPaginas, p + 1))}
                  disabled={paginaAtual === totalPaginas}
                  className={styles['paginacao-btn']}
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