import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Package, Calendar, MapPin, Tag, Hash } from 'react-feather';

const DetalhesItem = () => {
  const { id } = useParams();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoomImage, setZoomImage] = useState(null);

  const fetchItem = useCallback(async () => {
    try {
      const response = await fetch(`/api/itens/${id}`);
      if (response.ok) {
        const data = await response.json();
        setItem(data);
      }
    } catch (error) {
      // Erro silencioso para melhor UX
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchItem();
  }, [fetchItem]);



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
              <span>{item.categoria}</span>
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
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Imagens</h2>
              
              {item.imagens && item.imagens.length > 0 ? (
                <div className="grid grid-cols-2 gap-4">
                  {item.imagens.map((imagem, index) => (
                    <div
                      key={index}
                      className="relative group cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
                      onClick={() => setZoomImage(imagem)}
                      tabIndex={0}
                      aria-label={`Ampliar imagem ${index + 1} de ${item.nome}`}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setZoomImage(imagem)}
                    >
                      <img
                        src={imagem}
                        alt={`Foto ${index + 1} do item ${item.nome}`}
                        className="w-full h-24 object-cover rounded-lg group-hover:scale-105 transition-transform"
                        style={{ maxHeight: 100 }}
                      />
                    </div>
                  ))}
                </div>
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
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Unidade</p>
                      <p className="font-medium">{item.unidade || ''}</p>
                    </div>
                  </div>
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
                      <p className="font-medium">{item.comprimento || ''} x {item.largura || ''} x {item.altura || ''} {item.unidade || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center md:col-span-2">
                    <MapPin className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Localização</p>
                      <p className="font-medium">{item.localizacao || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Tag className="w-4 h-4 text-gray-400 mr-2" />
                    <div>
                      <p className="text-sm text-gray-500">Unidade de Armazenamento</p>
                      <p className="font-medium">{item.unidadeArmazenamento || '-'}</p>
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
                        item.armazens.map((a, idx) => (
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
          className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50"
          onClick={() => setZoomImage(null)}
          tabIndex={0}
          aria-label="Fechar imagem ampliada"
          onKeyDown={e => (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && setZoomImage(null)}
        >
          <img src={zoomImage} alt="Imagem ampliada do item" className="max-w-full max-h-[80vh] rounded-lg shadow-lg border-4 border-white" />
        </div>
      )}
    </div>
  );
};

export default DetalhesItem; 