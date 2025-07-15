import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Package, Calendar, MapPin, Tag, Hash } from 'react-feather';

const DetalhesItem = () => {
  const { id } = useParams();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [zoomImage, setZoomImage] = useState(null);
  const imagensScrollRef = useRef(null);
  // Variáveis de controle do drag
  const isDownRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftRef = useRef(0);

  // Handlers para mouse
  const handleMouseDown = (e) => {
    isDownRef.current = true;
    imagensScrollRef.current.classList.add('active');
    startXRef.current = e.pageX - imagensScrollRef.current.offsetLeft;
    scrollLeftRef.current = imagensScrollRef.current.scrollLeft;
  };
  const handleMouseLeave = () => {
    isDownRef.current = false;
    imagensScrollRef.current.classList.remove('active');
  };
  const handleMouseUp = () => {
    isDownRef.current = false;
    imagensScrollRef.current.classList.remove('active');
  };
  const handleMouseMove = (e) => {
    if (!isDownRef.current) return;
    e.preventDefault();
    const x = e.pageX - imagensScrollRef.current.offsetLeft;
    const walk = (x - startXRef.current) * 2;
    imagensScrollRef.current.scrollLeft = scrollLeftRef.current - walk;
  };
  // Handlers para touch
  const handleTouchStart = (e) => {
    isDownRef.current = true;
    startXRef.current = e.touches[0].pageX - imagensScrollRef.current.offsetLeft;
    scrollLeftRef.current = imagensScrollRef.current.scrollLeft;
    // Salva a posição inicial do Y para detectar direção
    imagensScrollRef.current._startY = e.touches[0].clientY;
  };
  const handleTouchEnd = () => {
    isDownRef.current = false;
    imagensScrollRef.current._startY = null;
  };
  const handleTouchMove = (e) => {
    if (!isDownRef.current) return;
    const x = e.touches[0].pageX - imagensScrollRef.current.offsetLeft;
    const y = e.touches[0].clientY;
    const startY = imagensScrollRef.current._startY || 0;
    // Se o movimento for mais horizontal que vertical, previne o scroll da tela
    if (Math.abs(e.touches[0].clientX - startXRef.current) > Math.abs(y - startY)) {
      e.preventDefault();
    }
    const walk = (x - startXRef.current) * 2;
    imagensScrollRef.current.scrollLeft = scrollLeftRef.current - walk;
  };

  const fetchItem = useCallback(async () => {
    try {
      const response = await fetch(`/api/itens/${id}`);
      if (response.ok) {
        const data = await response.json();
        setItem(data);
      } else {
        setError('Item não encontrado');
      }
    } catch (error) {
      setError('Erro ao carregar item');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchItem();
  }, [fetchItem]);

  // Adiciona listeners de touch com passive: false para garantir o preventDefault
  useEffect(() => {
    const container = imagensScrollRef.current;
    if (!container) return;
    // Funções auxiliares
    const onTouchStart = (e) => handleTouchStart(e);
    const onTouchEnd = (e) => handleTouchEnd(e);
    const onTouchMove = (e) => handleTouchMove(e);
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // Adicionar um state para detectar se é mobile
  const [isMobile, setIsMobile] = useState(window.innerWidth < 700);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 700);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);


  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Carregando item...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Erro</h2>
          <p className="text-gray-600 mb-4">{error}</p>
          <Link to="/listar" className="btn btn-primary">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Voltar ao Catálogo
          </Link>
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Item não encontrado</h2>
          <p className="text-gray-600 mb-4">O item que você está procurando não existe.</p>
          <Link to="/listar" className="btn btn-primary">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Voltar ao Catálogo
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link 
            to="/listar" 
            className="inline-flex items-center text-primary hover:text-primary-dark mb-4 transition-colors"
          >
            <ArrowLeft className="w-5 h-5 mr-2" />
            Voltar ao Catálogo
          </Link>
          
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            {item.nome}
          </h1>
          
          <div className="flex items-center space-x-4 text-sm text-gray-600">
            <div className="flex items-center">
              <Tag className="w-4 h-4 mr-1" />
              <span>{typeof item.categoria === 'object' && item.categoria !== null ? item.categoria.nome : item.categoria}</span>
            </div>
            {item.data_cadastro && (
              <div className="flex items-center">
                <Calendar className="w-4 h-4 mr-1" />
                <span>Cadastrado em {formatDate(item.data_cadastro)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Images */}
          <div className="space-y-6">
            <div
              className="bg-white rounded-lg shadow-md p-6"
              style={isMobile ? {
                width: '290px',
                height: '191px',
                margin: '0 auto',
                padding: '15px',
                boxSizing: 'border-box',
                maxWidth: '100%'
              } : {}}
            >
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Imagens</h2>
              
              {item.imagens && item.imagens.length > 0 ? (
                <>
                  {/* Grid para desktop */}
                  <div
                    className="imagens-grid-desktop"
                    style={{
                      display: 'none',
                      gap: 18,
                      justifyItems: 'center',
                      alignItems: 'center'
                    }}
                  >
                    {item.imagens.map((imagem, index) => (
                      <div
                        key={index}
                        style={{
                          width: 120,
                          height: 120,
                          overflow: 'hidden',
                          borderRadius: 10,
                          background: '#f3f4f6',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        onClick={() => setZoomImage(imagem)}
                      >
                        <img
                          src={imagem}
                          alt={`Foto ${index + 1} do item ${item.nome}`}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            cursor: 'pointer'
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  {/* Carrossel para mobile */}
                  <div
                    className="imagens-scroll-mobile"
                    style={{
                      display: 'flex',
                      overflowX: 'auto',
                      gap: 12,
                      paddingBottom: 8
                    }}
                    ref={imagensScrollRef}
                    onMouseDown={handleMouseDown}
                    onMouseLeave={handleMouseLeave}
                    onMouseUp={handleMouseUp}
                    onMouseMove={handleMouseMove}
                  >
                    {item.imagens.map((imagem, index) => (
                      <div
                        key={index}
                        style={{
                          minWidth: 120,
                          minHeight: 120,
                          maxWidth: 120,
                          maxHeight: 120,
                          overflow: 'hidden',
                          borderRadius: 10,
                          background: '#f3f4f6',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        onClick={() => setZoomImage(imagem)}
                      >
                        <img
                          src={imagem}
                          alt={`Foto ${index + 1} do item ${item.nome}`}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            cursor: 'pointer'
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-center py-12">
                  <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-600">Nenhuma imagem disponível</p>
                </div>
              )}
            </div>
          </div>

          {/* Details */}
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Informações Básicas</h2>
              
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-gray-900 mb-2">Descrição</h3>
                  <p className="text-gray-600 leading-relaxed">
                    {item.descricao || ''}
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center">
                    <Hash className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Código</p>
                      <p className="font-medium">{item.codigo || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Setor</p>
                      <p className="font-medium">{item.setor || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Família</p>
                      <p className="font-medium">{item.familia || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Subfamília</p>
                      <p className="font-medium">{item.subfamilia || ''}</p>
                    </div>
                  </div>
                  {/* Remover campo Unidade */}
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Peso</p>
                      <p className="font-medium">{item.peso || ''} {item.unidadePeso || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center md:col-span-2">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Dimensões</p>
                      <p className="font-medium">{item.comprimento || ''} x {item.largura || ''} x {item.altura || ''}{item.unidade ? ` ${item.unidade}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Unidade de Armazenamento</p>
                      <p className="font-medium">{item.unidadearmazenamento || '-'}</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <Package className="w-4 h-4 text-gray-400 mr-2" />
                  <div>
                    <p className="text-sm text-gray-500">Quantidade</p>
                    <p className="font-medium">{item.quantidade !== undefined ? item.quantidade : ''}</p>
                  </div>
                </div>
              </div>
              {/* Quantidade por armazém */}
              {item.armazens && (
                <div className="mt-6">
                  <h3 className="font-semibold text-gray-900 mb-2">Quantidade por Armazém</h3>
                  <table className="min-w-[220px] border border-gray-200 rounded">
                    <thead>
                      <tr>
                        <th className="px-3 py-2 border-b text-left text-sm font-bold text-gray-700">Armazém</th>
                        <th className="px-3 py-2 border-b text-left text-sm font-bold text-gray-700">Quantidade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.armazens.length === 0 ? (
                        <tr>
                          <td colSpan={2} className="px-3 py-2 text-gray-500 text-center">Nenhum armazém cadastrado</td>
                        </tr>
                      ) : (
                        [...item.armazens].sort((a, b) => (a.armazem || '').localeCompare(b.armazem || '')).map((a, idx) => (
                          <tr key={idx}>
                            <td className="px-3 py-1 border-b text-gray-700">{a.armazem}</td>
                            <td className="px-3 py-1 border-b text-gray-900 font-semibold">{a.quantidade}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Specifications */}
            {item.especificacoes && item.especificacoes.length > 0 && (
              <div className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-2xl font-bold text-gray-900 mb-4">Especificações</h2>
                
                <div className="space-y-3">
                  {item.especificacoes.map((spec, index) => (
                    <div key={index} className="flex justify-between py-2 border-b border-gray-100 last:border-b-0">
                      <span className="font-medium text-gray-900">{spec.nome}</span>
                      <span className="text-gray-600">{spec.valor}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Observations */}
            {item.observacoes && (
              <div className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-2xl font-bold text-gray-900 mb-4">Observações</h2>
                <p className="text-gray-600 leading-relaxed">{item.observacoes}</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Modal de Zoom */}
      {zoomImage && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setZoomImage(null)}
        >
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
            <img
              src={zoomImage}
              alt="Zoom"
              style={{
                maxWidth: '90vw',
                maxHeight: '90vh',
                borderRadius: 12,
                boxShadow: '0 4px 32px rgba(0,0,0,0.25)',
                background: '#fff',
                display: 'block'
              }}
            />
            <button
              onClick={() => setZoomImage(null)}
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
                border: 'none',
                borderRadius: '50%',
                width: 36,
                height: 36,
                fontSize: 22,
                cursor: 'pointer',
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)'
              }}
              aria-label="Fechar"
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DetalhesItem; 