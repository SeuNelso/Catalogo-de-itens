import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Search, ArrowLeft, CheckCircle, AlertCircle, Package } from 'react-feather';
import Toast from '../components/Toast';

const ImportarImagensAutomaticas = () => {
  const navigate = useNavigate();
  const [codigo, setCodigo] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [resultadoBusca, setResultadoBusca] = useState(null);
  const [resultadoImportacao, setResultadoImportacao] = useState(null);

  const buscarImagensNoBucket = async () => {
    if (!codigo.trim()) {
      setToast({ type: 'error', message: 'Digite um código para buscar' });
      return;
    }

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/imagens-bucket/${codigo.trim()}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setResultadoBusca(data);
        setResultadoImportacao(null);
      } else {
        const errorData = await response.json();
        setToast({ type: 'error', message: errorData.error || 'Erro ao buscar imagens' });
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

  const importarImagens = async () => {
    if (!codigo.trim()) {
      setToast({ type: 'error', message: 'Digite um código para importar' });
      return;
    }

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/importar-imagens-automaticas', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ codigo: codigo.trim() })
      });

      if (response.ok) {
        const data = await response.json();
        setResultadoImportacao(data);
        setToast({ type: 'success', message: 'Importação realizada com sucesso!' });
        // Recarregar a busca para mostrar o status atualizado
        buscarImagensNoBucket();
      } else {
        const errorData = await response.json();
        setToast({ type: 'error', message: errorData.error || 'Erro ao importar imagens' });
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

  const formatarTamanho = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatarData = (dataString) => {
    return new Date(dataString).toLocaleString('pt-BR');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 px-2 sm:px-4 py-4 sm:py-8">
      <div className="container mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Package className="text-[#0915FF] w-8 h-8" />
            <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0915FF]">Importar Imagens Automáticas</h1>
          </div>
          <p className="text-gray-600 text-sm sm:text-base">
            Importe imagens do bucket baseadas na nomenclatura do código do item (ex: 3000003_1.jpg, 3000003_2.jpg)
          </p>
        </div>

        {/* Card Principal */}
        <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] p-4 sm:p-8 mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-4">Buscar e Importar Imagens</h2>
          
          {/* Input do Código */}
          <div className="mb-6">
            <label className="block text-gray-700 font-semibold mb-2 text-sm sm:text-base">
              Código do Item
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                placeholder="Ex: 3000003"
                className="flex-1 px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base"
                onKeyPress={(e) => e.key === 'Enter' && buscarImagensNoBucket()}
              />
              <button
                onClick={buscarImagensNoBucket}
                disabled={loading}
                className="bg-[#0915FF] text-white font-semibold rounded-lg px-4 py-2 text-sm sm:text-base flex items-center gap-2 disabled:opacity-60"
              >
                <Search className="w-4 h-4" />
                Buscar
              </button>
            </div>
          </div>

          {/* Resultado da Busca */}
          {resultadoBusca && (
            <div className="mb-6">
              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <h3 className="font-semibold text-gray-900 mb-2">Informações do Item</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="font-medium">Código:</span> {resultadoBusca.codigo}
                  </div>
                  <div>
                    <span className="font-medium">Item existe:</span> 
                    <span className={resultadoBusca.itemExiste ? 'text-green-600' : 'text-red-600'}>
                      {resultadoBusca.itemExiste ? ' Sim' : ' Não'}
                    </span>
                  </div>
                  {resultadoBusca.itemInfo && (
                    <div className="sm:col-span-2">
                      <span className="font-medium">Descrição:</span> {resultadoBusca.itemInfo.descricao}
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-2">
                  Imagens Encontradas no Bucket ({resultadoBusca.totalImagens})
                </h3>
                
                {resultadoBusca.imagens.length === 0 ? (
                  <p className="text-gray-600">Nenhuma imagem encontrada com o padrão {resultadoBusca.codigo}_*</p>
                ) : (
                  <div className="space-y-2">
                    {resultadoBusca.imagens.map((imagem, index) => (
                      <div key={index} className="flex items-center justify-between p-2 bg-white rounded border">
                        <div className="flex items-center gap-2">
                          {imagem.jaCadastrada ? (
                            <CheckCircle className="w-4 h-4 text-green-600" />
                          ) : (
                            <AlertCircle className="w-4 h-4 text-yellow-600" />
                          )}
                          <span className="font-medium">{imagem.nome}</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {formatarTamanho(imagem.tamanho)} • {formatarData(imagem.dataModificacao)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {resultadoBusca.imagens.length > 0 && resultadoBusca.itemExiste && (
                  <button
                    onClick={importarImagens}
                    disabled={loading}
                    className="mt-4 bg-green-600 text-white font-semibold rounded-lg px-4 py-2 text-sm sm:text-base flex items-center gap-2 disabled:opacity-60"
                  >
                    <Upload className="w-4 h-4" />
                    Importar Imagens Não Cadastradas
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Resultado da Importação */}
          {resultadoImportacao && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <h3 className="font-semibold text-green-900 mb-2">Resultado da Importação</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="font-medium">Total encontradas:</span> {resultadoImportacao.totalEncontradas}
                </div>
                <div>
                  <span className="font-medium">Importadas:</span> {resultadoImportacao.imagensImportadas}
                </div>
                <div>
                  <span className="font-medium">Já existentes:</span> {resultadoImportacao.imagensJaExistentes}
                </div>
                <div>
                  <span className="font-medium">Item ID:</span> {resultadoImportacao.itemId}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Instruções */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-semibold text-blue-900 mb-2">Como usar:</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm text-blue-800">
            <li>Digite o código do item (ex: 3000003)</li>
            <li>Clique em "Buscar" para ver as imagens disponíveis no bucket</li>
            <li>As imagens devem seguir o padrão: <code className="bg-blue-100 px-1 rounded">CODIGO_NUMERO.extensao</code></li>
            <li>Exemplo: 3000003_1.jpg, 3000003_2.png, 3000003_3.webp</li>
            <li>Clique em "Importar" para adicionar as imagens ao item</li>
          </ol>
        </div>

        {/* Botão Voltar */}
        <div className="mt-6">
          <button
            onClick={() => navigate('/listar')}
            className="text-[#0915FF] font-semibold flex items-center gap-2 hover:underline text-sm sm:text-base"
          >
            <ArrowLeft className="w-5 h-5" />
            Voltar ao Catálogo
          </button>
        </div>
      </div>

      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </div>
  );
};

export default ImportarImagensAutomaticas; 