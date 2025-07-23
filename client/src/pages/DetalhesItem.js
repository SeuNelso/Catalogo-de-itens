import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Package, Calendar, Tag } from 'react-feather';

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
          <Package className="w-16 h-16 text-gray-800 mx-auto mb-4" />
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
          <Package className="w-16 h-16 text-gray-800 mx-auto mb-4" />
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 detalhes-item-root px-2 sm:px-0">
      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-8">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <Link 
            to="/listar" 
            className="inline-flex items-center text-primary hover:text-primary-dark mb-4 transition-colors text-sm sm:text-base"
          >
            <ArrowLeft className="w-5 h-5 mr-2" />
            Voltar ao Catálogo
          </Link>
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
            <Package className="w-7 h-7 sm:w-8 sm:h-8 text-[#0915FF]" />
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-[#0915FF] text-center sm:text-left">Detalhes do Item</h1>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4 text-xs sm:text-sm text-gray-600">
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
        <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-lg p-4 sm:p-8 mt-2 sm:mt-4 flex flex-col gap-4 sm:gap-6">
          {/* Código e Descrição acima das imagens */}
          <div className="flex flex-col gap-2 mb-4">
            <div className="text-[#0915FF] font-extrabold text-lg sm:text-2xl text-center sm:text-left">{item.codigo}</div>
            <div className="font-bold text-gray-900 text-base sm:text-lg text-center sm:text-left">{item.descricao}</div>
          </div>
          {/* Images */}
          <div className="space-y-4 sm:space-y-6">
            <div className="bg-white rounded-lg shadow-md p-3 sm:p-6">
              <h2 className="text-[#0915FF] text-lg sm:text-xl font-bold mb-3 sm:mb-4">Imagens</h2>
              {item.imagens && item.imagens.length > 0 ? (
                <div className="overflow-x-auto flex gap-3 sm:gap-4 pb-2">
                  {item.imagens.map((imagem, index) => (
                    <div
                      key={index}
                      className="min-w-[90px] min-h-[90px] max-w-[120px] max-h-[120px] overflow-hidden rounded-lg bg-[#f3f4f6] flex items-center justify-center cursor-pointer"
                      onClick={() => setZoomImage(imagem)}
                    >
                      {imagem.caminho && imagem.caminho.startsWith('http') && (
                        <img
                          src={imagem.caminho}
                          alt={`Foto ${index + 1} do item ${item.nome}`}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 sm:py-12">
                  <Package className="w-12 h-12 sm:w-16 sm:h-16 text-gray-800 mx-auto mb-4" />
                  <p className="text-gray-600">Nenhuma imagem disponível</p>
                </div>
              )}
            </div>
          </div>
          {/* Details */}
          <div className="space-y-4 sm:space-y-6">
            {/* Basic Info */}
            <div className="bg-white rounded-lg shadow-md p-3 sm:p-6">
              <h2 className="text-[#0915FF] text-lg sm:text-xl font-bold mb-3 sm:mb-4">Informações Básicas</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 sm:gap-y-3">
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Família:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.familia || '-'}</span>
                </div>
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Subfamília:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.subfamilia || '-'}</span>
                </div>
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Setor:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.setor || '-'}</span>
                </div>
                <div></div>
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Dimensões:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.comprimento || '-'} × {item.largura || '-'} × {item.altura || '-'} {item.unidade || ''}</span>
                </div>
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Peso:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.peso || '-'}{item.unidadepeso ? <span className='ml-1 text-xs sm:text-base text-gray-500 font-semibold'>({item.unidadepeso})</span> : ''}</span>
                </div>
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Tipo de controlo:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.tipocontrolo || '-'}</span>
                </div>
                <div></div>
                <div className="flex items-center mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Unidade de Armazenamento:</span>
                  <span className="ml-2 text-base sm:text-lg font-bold text-gray-800">{item.unidadearmazenamento || '-'}</span>
                </div>
                <div className="md:col-span-1 flex flex-col mb-1 sm:mb-2">
                  <span className="text-gray-500 font-semibold text-xs sm:text-base">Observações:</span>
                  <span className="ml-0 text-base sm:text-lg font-bold text-gray-800 whitespace-pre-line">{item.observacoes || '-'}</span>
                </div>
              </div>
              <div className="flex items-center mt-4">
                <Package className="w-4 h-4 text-gray-900 mr-2" />
                <div>
                  <p className="text-xs sm:text-sm text-gray-900">Quantidade</p>
                  <span className={`px-3 py-1 rounded-full font-bold text-xs sm:text-[15px] shadow-sm ${item.quantidade === 0 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{item.quantidade}</span>
                </div>
              </div>
            </div>
            {/* Quantidade por armazém */}
            {item.armazens && (
              <div className="mt-4 sm:mt-6 overflow-x-auto">
                <h3 className="font-semibold text-gray-900 mb-2">Quantidade por Armazém</h3>
                <table className="min-w-[220px] border border-gray-200 rounded text-xs sm:text-sm">
                  <thead>
                    <tr>
                      <th className="px-3 py-2 border-b text-left font-bold text-gray-700">Armazém</th>
                      <th className="px-3 py-2 border-b text-left font-bold text-gray-700">Quantidade</th>
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
            {/* Specifications */}
            {item.especificacoes && item.especificacoes.length > 0 && (
              <div className="bg-white rounded-lg shadow-md p-3 sm:p-6">
                <h2 className="text-[#0915FF] text-lg sm:text-xl font-bold mb-3 sm:mb-4">Especificações</h2>
                <div className="space-y-2 sm:space-y-3">
                  {item.especificacoes.map((spec, index) => (
                    <div key={index} className="flex justify-between py-2 border-b border-gray-100 last:border-b-0">
                      <span className="font-medium text-gray-900 text-xs sm:text-base">{spec.nome}</span>
                      <span className="text-gray-600 text-xs sm:text-base">{spec.valor}</span>
                    </div>
                  ))}
                </div>
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
              src={zoomImage.caminho}
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