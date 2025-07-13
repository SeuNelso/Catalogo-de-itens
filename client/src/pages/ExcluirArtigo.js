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

  return (
    <div className="min-h-screen bg-[#e5e5e5] flex flex-col items-center pb-12">
      <div style={{ width: '100%', maxWidth: 1100, margin: '40px auto 0 auto', display: 'block' }}>
        <div className={styles['catalogo-card']} style={{ margin: '0 auto', boxShadow: '0 8px 32px rgba(9,21,255,0.08)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
              className="mb-6 px-6 py-2 rounded bg-red-700 text-white font-bold text-sm hover:bg-red-800 transition-all shadow"
              style={{ display: 'block', marginLeft: 'auto', marginRight: 'auto' }}
            >
              Excluir Todos
            </button>
          )}
          {loading ? (
            <div className="text-center text-gray-500">Carregando...</div>
          ) : (
            <div className={styles['catalogo-conteudo']}>
              <table className={styles['catalogo-tabela']} style={{ margin: '0 auto', width: 'auto' }}>
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
                            className="px-4 py-1 rounded bg-red-600 text-white font-semibold text-xs hover:bg-red-700 transition-all"
                          >
                            Excluir
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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