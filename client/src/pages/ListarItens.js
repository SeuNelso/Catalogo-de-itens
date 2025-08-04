import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';
import { FaSearch } from 'react-icons/fa';
import Webcam from 'react-webcam';

const ListarItens = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [itens, setItens] = useState([]);
  const [toast, setToast] = useState(null);
  const [paginaAtual, setPaginaAtual] = useState(1);
  const [loading, setLoading] = useState(false);
  
  // Estados para ordenação de colunas
  const [ordenacao, setOrdenacao] = useState({
    campo: null,
    direcao: 'asc' // 'asc' ou 'desc'
  });
  // Remover variáveis não utilizadas
  // const [quantidadeFiltro, setQuantidadeFiltro] = useState(''); // não usado
  // const [itensPorPagina, setItensPorPagina] = useState(10); // não usado
  // const [tabelaRef, setTabelaRef] = useState(null); // não usado
  // const [totalItens, setTotalItens] = useState(0); // não usado

  const navigate = useNavigate();

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
  const canEdit = user && (user.role === 'admin' || user.role === 'controller');
  
  // Verificação adicional de segurança
  const userCanEdit = Boolean(canEdit);

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const [naoCadastrados, setNaoCadastrados] = useState([]);
  const [mostrarInativos, setMostrarInativos] = useState(false);

  // Buscar artigos não cadastrados do servidor ao montar
  useEffect(() => {
    const fetchNaoCadastrados = async () => {
      try {
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
          console.error('Erro ao buscar itens não cadastrados:', response.statusText);
        }
      } catch (error) {
        console.error('Erro ao buscar itens não cadastrados:', error);
      }
    };

    fetchNaoCadastrados();
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

  // Remover referências a filtros não utilizados
  // useEffect(() => {}, [codigoFiltro, descricaoFiltro]);
  // if (codigoFiltroRef.current && !codigoFiltroRef.current.contains(event.target)) { setShowCodigoFiltro(false); }
  // if (descricaoFiltroRef.current && !descricaoFiltroRef.current.contains(event.target)) { setShowDescricaoFiltro(false); }

  const fetchItens = async () => {
    setLoading(true);
    try {
      const url = mostrarInativos ? `/api/itens?incluirInativos=true&page=${paginaAtual}&limit=10` : `/api/itens?page=${paginaAtual}&limit=10`;
      const response = await fetch(url); // itensPorPagina não usado
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

  // Função para ordenar itens
  const ordenarItens = (itens) => {
    if (!ordenacao.campo) return itens;
    
    return [...itens].sort((a, b) => {
      let valorA, valorB;
      
      switch (ordenacao.campo) {
        case 'codigo':
          valorA = a.codigo || '';
          valorB = b.codigo || '';
          break;
        case 'nome':
          valorA = a.nome || '';
          valorB = b.nome || '';
          break;
        case 'setor':
          valorA = a.setor || '';
          valorB = b.setor || '';
          break;
        case 'quantidade':
          valorA = a.quantidade || 0;
          valorB = b.quantidade || 0;
          break;
        default:
          return 0;
      }
      
      // Comparação para strings
      if (typeof valorA === 'string' && typeof valorB === 'string') {
        valorA = valorA.toLowerCase();
        valorB = valorB.toLowerCase();
      }
      
      if (valorA < valorB) return ordenacao.direcao === 'asc' ? -1 : 1;
      if (valorA > valorB) return ordenacao.direcao === 'asc' ? 1 : -1;
      return 0;
    });
  };

  // Filtro de itens ativos/inativos e busca geral
  const itensFiltrados = Array.isArray(itens) ? itens.filter(item => {
    if (!mostrarInativos && !item.ativo) return false;
    const termo = searchTerm.trim().toLowerCase();
    if (!termo) return true;
    return (
      (item.codigo && item.codigo.toLowerCase().includes(termo)) ||
      (item.nome && item.nome.toLowerCase().includes(termo)) ||
      (item.descricao && item.descricao.toLowerCase().includes(termo))
    );
  }) : [];

  // Aplicar ordenação
  const itensOrdenados = ordenarItens(itensFiltrados);
  const totalPaginas = Math.ceil(itensOrdenados.length / 10); // itensPorPagina não usado
  const itensPagina = Array.isArray(itensOrdenados) ? itensOrdenados.slice((paginaAtual - 1) * 10, paginaAtual * 10) : []; // itensPorPagina não usado

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

  // Atualizar itens ao mudar o checkbox de mostrar inativos
  useEffect(() => {
    fetchItens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginaAtual, mostrarInativos]);

  // Resetar página quando ordenação mudar
  useEffect(() => {
    setPaginaAtual(1);
  }, [ordenacao]);

  // Função para lidar com ordenação
  const handleOrdenacao = (campo) => {
    if (ordenacao.campo === campo) {
      // Se clicar no mesmo campo, alterna a direção
      setOrdenacao({
        campo,
        direcao: ordenacao.direcao === 'asc' ? 'desc' : 'asc'
      });
    } else {
      // Se clicar em um campo diferente, define como ascendente
      setOrdenacao({
        campo,
        direcao: 'asc'
      });
    }
  };

  return (
    <div className="bg-[#f3f6fd] flex flex-col items-center justify-center py-2 px-1 sm:px-4 pt-2">
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
        <div className="bg-white rounded-[16px] shadow-[0_8px_32px_rgba(9,21,255,0.08)] p-4 sm:p-8 min-w-[90vw] sm:min-w-[300px] max-w-[98vw] sm:max-w-[340px] flex flex-col items-center gap-4 sm:gap-6 relative">
          <button
            onClick={() => setShowImageModal(true)}
            className="w-full flex items-center justify-center gap-2 bg-[#0915FF] hover:bg-[#2336ff] text-white font-bold rounded-xl py-3 px-4 shadow-lg transition text-lg mb-4 border-2 border-[#0915FF] focus:outline-none focus:ring-2 focus:ring-[#2336ff]"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 10l4.553-2.276A2 2 0 0 1 22 9.618V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.382a2 2 0 0 1 1.447.618L10 7h4l.171-.382A2 2 0 0 1 15.618 5H19a2 2 0 0 1 2 2v2.382a2 2 0 0 1-.618 1.447L15 10z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            Tirar foto / Enviar imagem
          </button>
          <div className="text-blue-600 font-bold text-2xl mb-0 text-center">
            Consulta Visual de Itens
          </div>
          <div className="w-full flex items-center justify-center mt-8">
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
          {naoCadastrados.length > 0 && (isAdmin || user?.role === 'controller') && (
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
              <div className="text-center text-[#0915FF] font-bold text-lg sm:text-2xl mb-0">Itens em Estoque</div>
              {itensPagina.length === 0 && (
                <div className="text-center text-gray-400 my-6">Nenhum item encontrado.</div>
              )}
              <div className="flex flex-col gap-4 sm:gap-6 items-center">
                {itensPagina.map(item => (
                  <div key={item.id} className="bg-white rounded-xl shadow border border-[#d1d5db] w-full max-w-[400px] p-4 flex flex-col gap-2 sm:gap-3">
                    <div className="font-bold text-[#0915FF] text-base sm:text-lg">Código: <span className="text-[#222]">{item.codigo}</span></div>
                    <div className="text-[#444] text-sm sm:text-base font-medium">Descrição: <span className="text-[#222] font-normal">{item.nome || item.descricao}</span></div>
                    <div className="font-semibold text-[#222] text-sm sm:text-base">Setor: <span className="ml-1 px-2 py-1 rounded bg-blue-100 text-blue-700">{item.setor || '-'}</span></div>
                    <div className="font-semibold text-[#222] text-sm sm:text-base">Quantidade: <span className={`ml-1 px-2 py-1 rounded ${item.quantidade > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{item.quantidade != null && item.quantidade !== '' ? item.quantidade : 0}</span></div>
                    <div className="flex gap-2 sm:gap-4 mt-2">
                      <button onClick={() => navigate(`/item/${item.id}`)} className="bg-[#0915FF] text-white rounded-lg px-3 py-2 font-bold text-xs sm:text-base w-full transition hover:bg-[#2336ff]">Detalhes</button>
                      {userCanEdit && (
                        <button onClick={() => navigate(`/editar/${item.id}`)} className="bg-[#FFD600] text-[#0915FF] rounded-lg px-3 py-2 font-bold text-xs sm:text-base w-full transition hover:bg-yellow-400">Editar</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {/* Paginação Mobile - Versão Compacta */}
              <div className="mobile-pagination mt-4 flex justify-center items-center gap-2 flex-wrap px-2">
                {/* Botão Anterior */}
                <button
                  onClick={() => setPaginaAtual(p => Math.max(1, p - 1))}
                  disabled={paginaAtual === 1}
                  style={{ 
                    minWidth: 44, 
                    height: 44, 
                    border: '1.5px solid #0915FF', 
                    background: '#fff', 
                    color: '#0915FF', 
                    fontWeight: 600, 
                    fontSize: 14, 
                    borderRadius: 8, 
                    cursor: paginaAtual === 1 ? 'not-allowed' : 'pointer',
                    opacity: paginaAtual === 1 ? 0.5 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  ←
                </button>

                {/* Informação da página atual */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 14,
                  color: '#374151',
                  fontWeight: 500
                }}>
                  <span>Página</span>
                  <span style={{
                    background: '#0915FF',
                    color: '#fff',
                    padding: '4px 12px',
                    borderRadius: 6,
                    fontWeight: 700,
                    minWidth: 32,
                    textAlign: 'center'
                  }}>
                    {paginaAtual}
                  </span>
                  <span>de {totalPaginas}</span>
                </div>

                {/* Botão Próximo */}
                <button
                  onClick={() => setPaginaAtual(p => Math.min(totalPaginas, p + 1))}
                  disabled={paginaAtual === totalPaginas}
                  style={{ 
                    minWidth: 44, 
                    height: 44, 
                    border: '1.5px solid #0915FF', 
                    background: '#fff', 
                    color: '#0915FF', 
                    fontWeight: 600, 
                    fontSize: 14, 
                    borderRadius: 8, 
                    cursor: paginaAtual === totalPaginas ? 'not-allowed' : 'pointer',
                    opacity: paginaAtual === totalPaginas ? 0.5 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  →
                </button>
              </div>


            </div>
          ) : (
            <div className="catalogo-card" style={{ margin: 0, boxShadow: '0 8px 32px rgba(9,21,255,0.08)', width: isMobile ? '100%' : '100%' }}>
              <div className="catalogo-conteudo" style={{ width: '100%' }}>
              <div className="catalogo-subtitulo text-lg sm:text-xl font-bold mb-2">Itens em Estoque</div>
                {!isMobile && (
                  <div className="overflow-x-auto rounded-2xl shadow-lg bg-white">
                    <table className="min-w-full text-xs sm:text-[16px]">
                      <thead>
                        <tr className="bg-gradient-to-r from-[#0a1fff] to-[#3b82f6] text-white font-bold rounded-t-2xl">
                          <th 
                            className="py-4 px-6 w-32 first:rounded-tl-2xl cursor-pointer hover:bg-blue-600 transition-colors"
                            onClick={() => handleOrdenacao('codigo')}
                          >
                            <div className="flex items-center justify-center gap-2">
                              CÓDIGO
                              {ordenacao.campo === 'codigo' && (
                                <span className="text-sm">{ordenacao.direcao === 'asc' ? '↑' : '↓'}</span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="py-4 px-6 cursor-pointer hover:bg-blue-600 transition-colors"
                            onClick={() => handleOrdenacao('nome')}
                          >
                            <div className="flex items-center justify-center gap-2">
                              DESCRIÇÃO
                              {ordenacao.campo === 'nome' && (
                                <span className="text-sm">{ordenacao.direcao === 'asc' ? '↑' : '↓'}</span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="py-4 px-6 w-32 cursor-pointer hover:bg-blue-600 transition-colors"
                            onClick={() => handleOrdenacao('setor')}
                          >
                            <div className="flex items-center justify-center gap-2">
                              SETOR
                              {ordenacao.campo === 'setor' && (
                                <span className="text-sm">{ordenacao.direcao === 'asc' ? '↑' : '↓'}</span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="py-4 px-6 w-32 cursor-pointer hover:bg-blue-600 transition-colors"
                            onClick={() => handleOrdenacao('quantidade')}
                          >
                            <div className="flex items-center justify-center gap-2">
                              QUANTIDADE
                              {ordenacao.campo === 'quantidade' && (
                                <span className="text-sm">{ordenacao.direcao === 'asc' ? '↑' : '↓'}</span>
                              )}
                            </div>
                          </th>
                          <th className="py-4 px-6 w-40 last:rounded-tr-2xl">
                            <div className="flex items-center justify-center gap-2">
                              AÇÃO
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOrdenacao({ campo: null, direcao: 'asc' });
                                }}
                                className="text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600 transition-colors"
                                title="Limpar ordenação"
                              >
                                Limpar
                              </button>
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {itensPagina.length === 0 ? (
                          <tr>
                            <td colSpan={5} style={{ textAlign: 'center', color: '#888', padding: '32px 0' }}>Nenhum item encontrado.</td>
                          </tr>
                        ) : (
                          itensPagina.map(item => (
                            <tr key={item.id} className="hover:bg-blue-50 transition border-b border-[#d1d5db] last:border-b-0">
                              <td className="py-3 px-6 w-32">
                                <Link to={`/item/${item.id}`} className="catalogo-link">
                                  {item.codigo || '-'}
                                </Link>
                              </td>
                              <td className="py-3 px-6 break-words whitespace-pre-line max-w-xs" title={item.nome}>{item.nome}</td>
                              <td className="py-3 px-6 w-32">
                                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full font-bold text-[15px] shadow-sm bg-blue-100 text-blue-700">
                                  {item.setor || '-'}
                                </span>
                              </td>
                              <td className="py-3 px-6 w-32">
                                <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full font-bold text-[15px] shadow-sm ${item.quantidade === 0 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" class="lucide lucide-check-circle w-4 h-4"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg> {item.quantidade != null && item.quantidade !== '' ? item.quantidade : 0}
                                </span>
                              </td>
                              <td className="py-3 px-6 w-40">
                                <div className="flex items-center gap-2">
                                  <button className="px-4 py-2 rounded-lg bg-[#0915FF] text-white font-semibold shadow hover:bg-[#2336ff] transition" onClick={() => navigate(`/item/${item.id}`)}>
                                    Detalhes
                                  </button>
                                  {userCanEdit && (
                                    <button className="px-4 py-2 rounded-lg bg-[#FFB800] text-black font-semibold shadow hover:bg-yellow-400 transition" onClick={() => navigate(`/editar/${item.id}`)}>
                                      Editar
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              {/* Adicionar controles de paginação centralizados abaixo da tabela: */}
              {/* Checkbox para mostrar inativos */}
              <div style={{ margin: '16px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  id="mostrar-inativos"
                  checked={mostrarInativos}
                  onChange={e => setMostrarInativos(e.target.checked)}
                  style={{ width: 18, height: 18 }}
                />
                <label htmlFor="mostrar-inativos" style={{ fontSize: 15, color: '#374151', fontWeight: 500 }}>
                  Mostrar Inativos
                </label>
              </div>
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
                    {/* Paginação Desktop - Versão Completa */}
                    <div className="desktop-pagination" style={{ 
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: 4,
                      flexWrap: 'wrap'
                    }}>
                      <button
                        onClick={() => setPaginaAtual(p => Math.max(1, p - 1))}
                        disabled={paginaAtual === 1}
                        style={{ 
                          minWidth: 36, 
                          height: 36, 
                          border: '1.5px solid #0915FF', 
                          background: '#fff', 
                          color: '#0915FF', 
                          fontWeight: 600, 
                          fontSize: 16, 
                          borderRadius: 7, 
                          cursor: paginaAtual === 1 ? 'not-allowed' : 'pointer', 
                          margin: 2 
                        }}
                      >
                        Anterior
                      </button>
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
                              >
                                {p}
                              </button>
                            );
                          } else if (
                            (p === mostrar + 1 && paginaAtual - vizinhos > mostrar + 1) ||
                            (p === totalPaginas - mostrar && paginaAtual + vizinhos < totalPaginas - mostrar)
                          ) {
                            botoes.push(
                              <span key={p} style={{ minWidth: 24, textAlign: 'center', color: '#0915FF' }}>
                                ...
                              </span>
                            );
                          }
                        }
                        return botoes;
                      })()}
                      <button
                        onClick={() => setPaginaAtual(p => Math.min(totalPaginas, p + 1))}
                        disabled={paginaAtual === totalPaginas}
                        style={{ 
                          minWidth: 36, 
                          height: 36, 
                          border: '1.5px solid #0915FF', 
                          background: '#fff', 
                          color: '#0915FF', 
                          fontWeight: 600, 
                          fontSize: 16, 
                          borderRadius: 7, 
                          cursor: paginaAtual === totalPaginas ? 'not-allowed' : 'pointer', 
                          margin: 2 
                        }}
                      >
                        Próximo
                      </button>
                    </div>
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