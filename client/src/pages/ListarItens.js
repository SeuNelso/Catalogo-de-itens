import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';
import styles from './ListarItens.module.css';
import { FaFilter } from 'react-icons/fa';
import { FaCamera, FaSearch } from 'react-icons/fa';
import Webcam from 'react-webcam';

const ListarItens = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [itens, setItens] = useState([]);
  const [toast, setToast] = useState(null);
  const [paginaAtual, setPaginaAtual] = useState(1);
  const [loading, setLoading] = useState(false);
  // Remover variáveis não utilizadas
  // const [quantidadeFiltro, setQuantidadeFiltro] = useState(''); // não usado
  // const [itensPorPagina, setItensPorPagina] = useState(10); // não usado
  // const [tabelaRef, setTabelaRef] = useState(null); // não usado
  // const [totalItens, setTotalItens] = useState(0); // não usado

  const navigate = useNavigate();

  const [ordemCodigoAsc, setOrdemCodigoAsc] = useState(true);
  const [ordemDescricaoAsc, setOrdemDescricaoAsc] = useState(true);
  const [codigoFiltro, setCodigoFiltro] = useState('');
  const [descricaoFiltro, setDescricaoFiltro] = useState('');
  const [showCodigoFiltro, setShowCodigoFiltro] = useState(false);
  const [showDescricaoFiltro, setShowDescricaoFiltro] = useState(false);
  const codigoFiltroRef = useRef(null);
  const descricaoFiltroRef = useRef(null);

  const [showImageModal, setShowImageModal] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageResults, setImageResults] = useState([]);
  const [imageError, setImageError] = useState('');
  const [activeTab, setActiveTab] = useState('upload');
  const [selectedFile, setSelectedFile] = useState(null);
  const [webcamImage, setWebcamImage] = useState(null);
  const webcamRef = useRef(null);
  const fileInputRef = useRef(null);

  const { user } = useAuth();
  const isAdmin = user && user.role === 'admin';

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const [naoCadastrados, setNaoCadastrados] = useState([]);

  // Buscar artigos não cadastrados do localStorage ao montar
  useEffect(() => {
    const salvos = localStorage.getItem('artigos_nao_cadastrados');
    if (salvos) {
      try {
        setNaoCadastrados(JSON.parse(salvos));
      } catch {}
    }
  }, []);

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Corrigir useEffect para não dar erro de dependência
  useEffect(() => {
    fetchItens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginaAtual]);

  useEffect(() => {
    function calcularItensPorPagina() {
      // Altura do cabeçalho, filtros, margens, etc.
      // const alturaCabecalho = 250; // considera header, filtros, paginação, etc. (não usado)
      // const alturaLinha = 48; // altura média de uma linha da tabela (não usado)
      // const alturaDisponivel = window.innerHeight - alturaCabecalho; // não usado
    }
    calcularItensPorPagina();
    window.addEventListener('resize', calcularItensPorPagina);
    return () => window.removeEventListener('resize', calcularItensPorPagina);
  }, []);

  useEffect(() => {
    setPaginaAtual(1); // Sempre volta para a primeira página ao filtrar
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
    setLoading(true);
    try {
      const response = await fetch(`/api/itens?page=${paginaAtual}&limit=10`); // itensPorPagina não usado
      if (response.ok) {
        const data = await response.json();
        let arr = [];
        if (Array.isArray(data.itens)) arr = data.itens;
        else if (Array.isArray(data)) arr = data;
        setItens(arr);
        // setTotalItens(data.total || arr.length); // não usado
      } else {
        setItens([]);
        // setTotalItens(0); // não usado
      }
    } catch (error) {
      setItens([]);
      // setTotalItens(0); // não usado
      setToast({ type: 'error', message: 'Erro ao carregar itens.' });
    } finally {
      setLoading(false);
    }
  };

  // Calcular itens da página atual após filtrar:
  const itensFiltrados = Array.isArray(itens) ? itens.filter(item => {
    const termo = searchTerm.trim().toLowerCase();
    if (!termo) return true;
    return (
      (item.codigo && item.codigo.toLowerCase().includes(termo)) ||
      (item.nome && item.nome.toLowerCase().includes(termo)) ||
      (item.descricao && item.descricao.toLowerCase().includes(termo))
    );
  }) : [];
  const totalPaginas = Math.ceil(itensFiltrados.length / 10); // itensPorPagina não usado
  const itensPagina = Array.isArray(itensFiltrados) ? itensFiltrados.slice((paginaAtual - 1) * 10, paginaAtual * 10) : []; // itensPorPagina não usado

  const ordenarPorCodigo = () => {
    setOrdemCodigoAsc(!ordemCodigoAsc);
    setItens([...itens].sort((a, b) => {
      if (ordemCodigoAsc) {
        return (a.codigo || '').localeCompare(b.codigo || '');
      } else {
        return (b.codigo || '').localeCompare(a.codigo || '');
      }
    }));
  };
  const ordenarPorDescricao = () => {
    setOrdemDescricaoAsc(!ordemDescricaoAsc);
    setItens([...itens].sort((a, b) => {
      if (ordemDescricaoAsc) {
        return (a.nome || '').localeCompare(b.nome || '');
      } else {
        return (b.nome || '').localeCompare(a.nome || '');
      }
    }));
  };

  // Funções do modal de busca por imagem
  const handleFileSelect = (file) => {
    if (file && file.type.startsWith('image/')) {
      setSelectedFile(file);
      setWebcamImage(null);
      setImageResults([]);
      setImageError('');
    }
  };
  const handleFileInput = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelect(e.target.files[0]);
    }
  };
  const captureWebcam = () => {
    if (webcamRef.current) {
      const imageSrc = webcamRef.current.getScreenshot();
      setWebcamImage(imageSrc);
      setSelectedFile(null);
      setImageResults([]);
      setImageError('');
    }
  };
  const resetImageModal = () => {
    setSelectedFile(null);
    setWebcamImage(null);
    setImageResults([]);
    setImageError('');
    setImageLoading(false);
    setActiveTab('upload');
  };
  const analyzeImage = async () => {
    const imageToAnalyze = selectedFile || webcamImage;
    if (!imageToAnalyze) return;
    setImageLoading(true);
    setImageResults([]);
    setImageError('');
    try {
      const formData = new FormData();
      if (selectedFile) {
        formData.append('image', selectedFile);
      } else if (webcamImage) {
        // Convert base64 to blob
        const response = await fetch(webcamImage);
        const blob = await response.blob();
        formData.append('image', blob, 'webcam.jpg');
      }
      const response = await fetch('/api/reconhecer', {
        method: 'POST',
        body: formData,
      });
      if (response.ok) {
        const data = await response.json();
        setImageResults(data.resultados || []);
      } else {
        setImageError('Erro na análise da imagem.');
      }
    } catch (err) {
      setImageError('Erro ao analisar imagem.');
    } finally {
      setImageLoading(false);
    }
  };

  return (
    <div className={`bg-[#e5e5e5] flex flex-col items-center${isMobile ? ' catalogo-mobile-stack' : ''}`}>
      {/* Modal de busca por imagem */}
      {showImageModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, maxWidth: 420, width: '100%', padding: 28, boxShadow: '0 8px 32px rgba(9,21,255,0.10)', position: 'relative' }}>
            <button onClick={() => { resetImageModal(); setShowImageModal(false); }} style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', fontSize: 22, color: '#0915FF', cursor: 'pointer' }}>×</button>
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <button
                onClick={() => setActiveTab('upload')}
                style={{ flex: 1, background: activeTab === 'upload' ? '#0915FF' : '#f7f8fc', color: activeTab === 'upload' ? '#fff' : '#0915FF', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: 'pointer' }}
              >Upload</button>
              <button
                onClick={() => setActiveTab('webcam')}
                style={{ flex: 1, background: activeTab === 'webcam' ? '#0915FF' : '#f7f8fc', color: activeTab === 'webcam' ? '#fff' : '#0915FF', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: 'pointer' }}
              >Câmera</button>
            </div>
            {/* Upload */}
            {activeTab === 'upload' && (
              <div style={{ textAlign: 'center', marginBottom: 18 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileInput}
                  style={{ display: 'none' }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontWeight: 600, cursor: 'pointer', marginBottom: 10 }}
                >Selecionar Imagem</button>
                {selectedFile && (
                  <div style={{ marginTop: 10 }}>
                    <img src={URL.createObjectURL(selectedFile)} alt="Preview" style={{ maxWidth: 180, borderRadius: 8, marginBottom: 8 }} />
                    <button onClick={() => setSelectedFile(null)} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 13 }}>Remover</button>
                  </div>
                )}
              </div>
            )}
            {/* Webcam */}
            {activeTab === 'webcam' && (
              <div style={{ textAlign: 'center', marginBottom: 18 }}>
                {!webcamImage ? (
                  <>
                    <Webcam
                      ref={webcamRef}
                      screenshotFormat="image/jpeg"
                      style={{ width: 220, height: 160, borderRadius: 8, marginBottom: 10 }}
                    />
                    <div>
                      <button
                        onClick={captureWebcam}
                        style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontWeight: 600, cursor: 'pointer', marginRight: 8 }}
                      >Capturar Foto</button>
                    </div>
                  </>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <img src={webcamImage} alt="Preview" style={{ maxWidth: 180, borderRadius: 8, marginBottom: 8 }} />
                    <button onClick={() => setWebcamImage(null)} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 13 }}>Remover</button>
                  </div>
                )}
              </div>
            )}
            {/* Analisar botão */}
            {(selectedFile || webcamImage) && (
              <button
                onClick={analyzeImage}
                disabled={imageLoading}
                style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontWeight: 600, cursor: imageLoading ? 'not-allowed' : 'pointer', width: '100%', marginBottom: 10 }}
              >{imageLoading ? 'Analisando...' : 'Analisar Imagem'}</button>
            )}
            {/* Resultados */}
            {imageError && (
              <div style={{ color: '#b91c1c', margin: '10px 0', textAlign: 'center' }}>{imageError}</div>
            )}
            {imageResults.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ color: '#1a7f37', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>{imageResults.length} resultado(s) encontrado(s):</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {imageResults.map((item, idx) => (
                    <li key={item.id} style={{ marginBottom: 10, background: '#f7f8fc', borderRadius: 8, padding: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 500, color: '#0915FF' }}>{item.nome}</span>
                      <button onClick={() => window.location.href = `/item/${item.id}`} style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Ver Detalhes</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Resultados reconhecidos no topo */}
      {imageResults.length > 0 && (
        <div style={{ width: '100%', maxWidth: 1800, margin: '24px auto 0 auto', background: '#e6fbe6', borderRadius: 12, boxShadow: '0 2px 8px rgba(9,21,255,0.06)', padding: 18 }}>
          <div style={{ color: '#1a7f37', fontWeight: 600, marginBottom: 8, fontSize: 16 }}>Itens reconhecidos:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {imageResults.map((item) => (
              <div key={item.id} style={{ background: '#fff', border: '1.5px solid #d1d5db', borderRadius: 8, padding: 14, minWidth: 180, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                <span style={{ fontWeight: 600, color: '#0915FF', fontSize: 15 }}>{item.nome}</span>
                <span style={{ color: '#444', fontSize: 13 }}>{item.descricao}</span>
                <button onClick={() => window.location.href = `/item/${item.id}`}
                  style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', fontWeight: 600, cursor: 'pointer', fontSize: 13, marginTop: 6 }}>
                  Ver Detalhes
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{
        display: isMobile ? 'block' : 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        justifyContent: 'center',
        alignItems: isMobile ? 'stretch' : 'flex-start',
        gap: isMobile ? 0 : 48,
        width: '100%',
        maxWidth: 1800,
        marginTop: 0
      }}>
        {/* Card de busca visual */}
        <div style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
          padding: 32,
          minWidth: isMobile ? 'unset' : 300,
          maxWidth: isMobile ? '100%' : 340,
          flex: isMobile ? 'unset' : '0 0 340px',
          marginTop: 0,
          marginLeft: 0,
          marginRight: isMobile ? 0 : 'auto',
          width: isMobile ? '100%' : undefined,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          position: 'relative'
        }}>
          <button
            onClick={() => setShowImageModal(true)}
            style={{ background: '#0915FF', color: '#fff', fontWeight: 700, border: 'none', borderRadius: 8, padding: '10px 28px', fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', boxShadow: '0 2px 8px rgba(9,21,255,0.08)', marginBottom: 8 }}
          >
            <FaCamera style={{ marginRight: 8 }} /> Tirar foto / Enviar imagem
          </button>
          <div style={{ color: '#0915FF', fontWeight: 700, fontSize: 22, marginBottom: 0, textAlign: 'center' }}>
            Consulta Visual de Itens
          </div>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
            <input
              type="text"
              placeholder="Busque pelo código ou descrição"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              style={{
                border: '1.5px solid #d1d5db',
                borderRadius: '24px 0 0 24px',
                padding: '12px 18px',
                fontSize: 16,
                outline: 'none',
                width: 180,
                background: '#fff',
                boxShadow: 'none',
                borderRight: 'none',
              }}
            />
            <button
              style={{
                background: '#0915FF',
                color: '#fff',
                border: 'none',
                borderRadius: '0 24px 24px 0',
                padding: '0 16px',
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: 20
              }}
              tabIndex={-1}
              disabled
            >
              <FaSearch />
            </button>
          </div>
          {/* Itens não cadastrados - agora abaixo do card de busca visual */}
          {naoCadastrados.length > 0 && (
            <div style={{
              margin: '18px 0 0 0',
              width: '100%',
              background: '#fffde7',
              border: '1px solid #ffe082',
              borderRadius: 10,
              boxShadow: '0 1px 4px rgba(250,204,21,0.04)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 18, color: '#eab308' }}>⚠️</span>
                <h3 style={{ color: '#b45309', fontWeight: 700, fontSize: 16, margin: 0, letterSpacing: 0 }}>Itens não cadastrados</h3>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: 10,
                width: '100%',
                maxWidth: 320,
                maxHeight: '40vh', // Limita a altura máxima a 40% da viewport
                overflowY: 'auto', // Adiciona scroll vertical se necessário
              }}>
                {naoCadastrados.map((art, idx) => (
                  <div key={idx} style={{
                    background: '#fff',
                    border: '1px solid #ffe082',
                    borderRadius: 8,
                    boxShadow: '0 1px 4px rgba(250,204,21,0.04)',
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    minHeight: 60,
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: '#b45309', marginBottom: 1 }}>{art.codigo}</div>
                    <div style={{ color: '#444', fontSize: 13, marginBottom: 4 }}>{art.descricao}</div>
                    <button
                      style={{
                        background: '#ffe082',
                        color: '#7c4700',
                        border: 'none',
                        borderRadius: 6,
                        padding: '4px 12px',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                        marginTop: 'auto',
                        transition: 'background 0.2s, color 0.2s',
                      }}
                      onClick={() => {
                        navigate(`/cadastrar?codigo=${encodeURIComponent(art.codigo)}&descricao=${encodeURIComponent(art.descricao)}`);
                      }}
                    >Cadastrar</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {/* Card da tabela ou cards mobile */}
        <div style={{
          flex: 1,
          minWidth: isMobile ? 'unset' : 350,
          marginTop: 0,
          marginLeft: isMobile ? 0 : 'auto',
          marginRight: 0,
          display: 'flex',
          justifyContent: 'center',
          width: isMobile ? '100%' : undefined
        }}>
          {isMobile ? (
            <div style={{ width: '100%', padding: '8px 0' }}>
              <div style={{ textAlign: 'center', color: '#0915FF', fontWeight: 700, fontSize: 20, margin: '12px 0 16px 0' }}>Itens em Estoque</div>
              {itensPagina.length === 0 && (
                <div style={{ textAlign: 'center', color: '#888', margin: '24px 0' }}>Nenhum item encontrado.</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
                {itensPagina.map(item => (
                  <div key={item.id} style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(9,21,255,0.08)', border: '1.5px solid #d1d5db', width: '95%', maxWidth: 400, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontWeight: 700, color: '#0915FF', fontSize: 16 }}>Código: <span style={{ color: '#222' }}>{item.codigo}</span></div>
                    <div style={{ color: '#444', fontSize: 15, fontWeight: 500 }}>Descrição: <span style={{ color: '#222', fontWeight: 400 }}>{item.nome || item.descricao}</span></div>
                    <div style={{ fontWeight: 600, color: '#222', fontSize: 15 }}>Quantidade: <span style={{ color: item.quantidade > 0 ? '#1a7f37' : '#b91c1c', background: item.quantidade > 0 ? '#e6fbe6' : '#ffeaea', borderRadius: 6, padding: '2px 10px', marginLeft: 4 }}>{item.quantidade}</span></div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button onClick={() => navigate(`/item/${item.id}`)} style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 700, fontSize: 15, cursor: 'pointer', width: '100%' }}>Detalhes</button>
                      {user && (
                        <button onClick={() => navigate(`/editar/${item.id}`)} style={{ background: '#FFD600', color: '#0915FF', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 700, fontSize: 15, cursor: 'pointer', width: '100%' }}>Editar</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {/* Paginação */}
              <div style={{ margin: '18px 0 0 0', display: 'flex', justifyContent: 'center' }}>
                <button
                  onClick={() => setPaginaAtual(p => Math.max(1, p - 1))}
                  disabled={paginaAtual === 1}
                  style={{ minWidth: 36, height: 36, border: '1.5px solid #0915FF', background: '#fff', color: '#0915FF', fontWeight: 600, fontSize: 16, borderRadius: 7, cursor: paginaAtual === 1 ? 'not-allowed' : 'pointer', margin: 2 }}
                >Anterior</button>
                {(() => {
                  const botoes = [];
                  const mostrar = 2; // Quantos botões mostrar no início/fim
                  const vizinhos = 2; // Quantos vizinhos ao redor da página atual
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
                          style={{
                            minWidth: 36,
                            height: 36,
                            border: '1.5px solid #0915FF',
                            background: paginaAtual === p ? '#0915FF' : '#fff',
                            color: paginaAtual === p ? '#fff' : '#0915FF',
                            fontWeight: 700,
                            fontSize: 16,
                            borderRadius: 7,
                            cursor: 'pointer',
                            margin: 2
                          }}
                          disabled={paginaAtual === p}
                        >{p}</button>
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
                  style={{ minWidth: 36, height: 36, border: '1.5px solid #0915FF', background: '#fff', color: '#0915FF', fontWeight: 600, fontSize: 16, borderRadius: 7, cursor: paginaAtual === totalPaginas ? 'not-allowed' : 'pointer', margin: 2 }}
                >Próximo</button>
              </div>
            </div>
          ) : (
            <div className={styles['catalogo-card']} style={{ margin: 0, boxShadow: '0 8px 32px rgba(9,21,255,0.08)', width: isMobile ? '100%' : '100%' }}>
              <div className={styles['catalogo-conteudo']} style={{ width: '100%' }}>
              <div className={styles['catalogo-subtitulo']}>Itens em Estoque</div>
                {!isMobile && (
                  <table className={styles['catalogo-tabela']} style={{ width: '100%', minWidth: 600, maxWidth: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ whiteSpace: 'nowrap', cursor: 'pointer', position: 'relative' }} onClick={() => setShowCodigoFiltro(v => !v)}>
                      CÓDIGO
                      <button onClick={e => { e.stopPropagation(); ordenarPorCodigo(); }} style={{ background: 'none', border: 'none', marginLeft: 6, cursor: 'pointer' }} title="Ordenar">
                        <FaFilter color="#fff" size={14} style={{ verticalAlign: 'middle' }} />
                      </button>
                      <br />
                      {showCodigoFiltro && (
                        <input
                          ref={codigoFiltroRef}
                          type="text"
                          value={codigoFiltro}
                          onChange={e => setCodigoFiltro(e.target.value)}
                          placeholder="Filtrar"
                          style={{
                            width: 70,
                            border: '1px solid #e0e7ef',
                            borderRadius: 5,
                            padding: '2px 6px',
                            fontSize: 12,
                            marginLeft: 8,
                            marginTop: 0,
                            background: '#f7fafd',
                            color: '#222',
                            position: 'absolute',
                            left: 'auto',
                            right: 0,
                            top: 8,
                            zIndex: 10,
                            boxShadow: '0 2px 8px rgba(9,21,255,0.06)',
                          }}
                          autoFocus
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                    </th>
                    <th style={{ whiteSpace: 'nowrap', cursor: 'pointer', position: 'relative' }} onClick={() => setShowDescricaoFiltro(v => !v)}>
                      DESCRIÇÃO
                      <button onClick={e => { e.stopPropagation(); ordenarPorDescricao(); }} style={{ background: 'none', border: 'none', marginLeft: 6, cursor: 'pointer' }} title="Ordenar">
                        <FaFilter color="#fff" size={14} style={{ verticalAlign: 'middle' }} />
                      </button>
                      <br />
                      {showDescricaoFiltro && (
                        <input
                          ref={descricaoFiltroRef}
                          type="text"
                          value={descricaoFiltro}
                          onChange={e => setDescricaoFiltro(e.target.value)}
                          placeholder="Filtrar"
                          style={{
                            width: 120,
                            border: '1px solid #e0e7ef',
                            borderRadius: 5,
                            padding: '2px 6px',
                            fontSize: 12,
                            marginLeft: 8,
                            marginTop: 0,
                            background: '#f7fafd',
                            color: '#222',
                            position: 'absolute',
                            left: 'auto',
                            right: 0,
                            top: 8,
                            zIndex: 10,
                            boxShadow: '0 2px 8px rgba(9,21,255,0.06)',
                          }}
                          autoFocus
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                    </th>
                    <th>QUANTIDADE</th>
                    <th>AÇÃO</th>
                  </tr>
                </thead>
                <tbody>
                  {itensPagina.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', color: '#888', padding: '32px 0' }}>Nenhum item encontrado.</td>
                    </tr>
                  ) : (
                    itensPagina.map(item => (
                      <tr key={item.id}>
                        <td title={item.codigo || '-'}>
                          <Link to={`/item/${item.id}`} className={styles['catalogo-link']}>
                            {item.codigo || '-'}
                          </Link>
                        </td>
                        <td title={item.nome}>
                          {item.nome}
                        </td>
                        <td title={item.quantidade !== undefined ? String(item.quantidade) : '-'}>
                          <span className={
                            item.quantidade > 10
                              ? `${styles['catalogo-quantidade']} ${styles['verde']}`
                              : `${styles['catalogo-quantidade']} ${styles['vermelho']}`
                          }>
                            {/* Exibir 0 normalmente, apenas ocultar se for null ou undefined */}
                            {item.quantidade !== null && item.quantidade !== undefined ? item.quantidade : '-'}
                          </span>
                        </td>
                        <td>
                          <button
                            className="px-4 py-1 rounded bg-[#0915FF] text-white font-semibold text-xs hover:bg-[#2336ff] transition-all"
                            onClick={() => navigate(`/item/${item.id}`)}
                            style={{ marginRight: 8 }}
                          >
                            Detalhes
                          </button>
                          {isAdmin && (
                            <button
                              className="px-4 py-1 rounded bg-[#FFB800] text-black font-semibold text-xs hover:bg-[#ffe066] transition-all"
                              onClick={() => navigate(`/editar/${item.id}`)}
                            >
                              Editar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
                )}
              {/* Adicionar controles de paginação centralizados abaixo da tabela: */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: '100%', marginTop: 18, marginBottom: 0, minHeight: 40 }}>
                  {/* Espaço fixo para o loader, para não mover a paginação */}
                  <div style={{ width: 110, display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
                    {loading && (
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <svg style={{ width: 28, height: 28 }} viewBox="0 0 50 50">
                          <circle cx="25" cy="25" r="20" fill="none" stroke="#0915FF" strokeWidth="5" strokeDasharray="31.4 31.4" strokeLinecap="round">
                            <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite" />
                          </circle>
                        </svg>
                        <span style={{ color: '#0915FF', fontWeight: 600, fontSize: 15, marginLeft: 6 }}>Carregando...</span>
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
                    {/* Paginação */}
                <button
                  onClick={() => setPaginaAtual(p => Math.max(1, p - 1))}
                  disabled={paginaAtual === 1}
                  style={{ minWidth: 36, height: 36, border: '1.5px solid #0915FF', background: '#fff', color: '#0915FF', fontWeight: 600, fontSize: 16, borderRadius: 7, cursor: paginaAtual === 1 ? 'not-allowed' : 'pointer', margin: 2 }}
                >Anterior</button>
                {(() => {
                  const botoes = [];
                  const mostrar = 2; // Quantos botões mostrar no início/fim
                  const vizinhos = 2; // Quantos vizinhos ao redor da página atual
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
                          style={{
                            minWidth: 36,
                            height: 36,
                            border: '1.5px solid #0915FF',
                            background: paginaAtual === p ? '#0915FF' : '#fff',
                            color: paginaAtual === p ? '#fff' : '#0915FF',
                            fontWeight: 700,
                            fontSize: 16,
                            borderRadius: 7,
                            cursor: 'pointer',
                            margin: 2
                          }}
                          disabled={paginaAtual === p}
                        >{p}</button>
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
                  style={{ minWidth: 36, height: 36, border: '1.5px solid #0915FF', background: '#fff', color: '#0915FF', fontWeight: 600, fontSize: 16, borderRadius: 7, cursor: paginaAtual === totalPaginas ? 'not-allowed' : 'pointer', margin: 2 }}
                >Próximo</button>
              </div>
            </div>
          </div>
            </div>
          )}
        </div>
      </div>
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
};

export default ListarItens; 