import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, ArrowLeft } from 'react-feather';
import Toast from '../components/Toast';

const DetectarImagensAutomaticas = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [resultadoTodos, setResultadoTodos] = useState(null);



  const detectarImagensTodos = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/detectar-imagens-todos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setResultadoTodos(data);
        setToast({ type: 'success', message: 'Detecção automática para todos os itens concluída!' });
      } else {
        const errorData = await response.json();
        setToast({ type: 'error', message: errorData.error || 'Erro na detecção automática' });
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 px-2 sm:px-4 py-4 sm:py-8">
      <div className="container mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="text-[#0915FF] w-8 h-8" />
            <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0915FF]">Detecção Automática de Imagens</h1>
          </div>
          <p className="text-gray-600 text-sm sm:text-base">
            Detecte e importe automaticamente imagens do bucket baseadas na nomenclatura dos códigos dos itens
          </p>
        </div>

        {/* Card Principal */}
        <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] p-4 sm:p-8 mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-4">Detecção Automática</h2>
          
          {/* Detecção para item específico */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-3">Detectar para Item Específico</h3>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
              <p className="text-blue-800 text-sm mb-3">
                Esta funcionalidade detecta automaticamente imagens no bucket quando você acessa os detalhes de um item.
              </p>
              <p className="text-blue-800 text-sm">
                <strong>Como funciona:</strong> Ao acessar os detalhes de um item, o sistema verifica automaticamente se há imagens no bucket com o padrão <code className="bg-blue-100 px-1 rounded">CODIGO_*</code> e as importa.
              </p>
            </div>
          </div>

          {/* Detecção para todos os itens */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-3">Detectar para Todos os Itens</h3>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
              <p className="text-yellow-800 text-sm mb-3">
                <strong>⚠️ Apenas para Administradores:</strong> Esta operação verifica todos os itens do catálogo e importa imagens automaticamente.
              </p>
              <p className="text-yellow-800 text-sm">
                <strong>Tempo estimado:</strong> Pode levar alguns minutos dependendo da quantidade de itens.
              </p>
            </div>
            
            <button
              onClick={detectarImagensTodos}
              disabled={loading}
              className="bg-yellow-600 text-white font-semibold rounded-lg px-6 py-3 text-sm sm:text-base flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Detectar Imagens para Todos os Itens
            </button>
          </div>

          {/* Resultado da detecção para todos */}
          {resultadoTodos && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-green-900 mb-2">Resultado da Detecção Global</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="font-medium">Total de itens:</span> {resultadoTodos.totalItens}
                </div>
                <div>
                  <span className="font-medium">Imagens importadas:</span> {resultadoTodos.totalImportadas}
                </div>
                <div>
                  <span className="font-medium">Imagens já existentes:</span> {resultadoTodos.totalJaExistentes}
                </div>
                <div>
                  <span className="font-medium">Itens com novas imagens:</span> {resultadoTodos.itensComNovasImagens.length}
                </div>
              </div>
              
              {resultadoTodos.itensComNovasImagens.length > 0 && (
                <div className="mt-3">
                  <h4 className="font-medium text-green-900 mb-2">Itens com novas imagens:</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                    {resultadoTodos.itensComNovasImagens.map((item, index) => (
                      <div key={index} className="bg-green-100 rounded px-2 py-1">
                        <span className="font-medium">{item.codigo}</span>: {item.importadas} imagens
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Informações sobre detecção automática */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-blue-900 mb-2">Como funciona a detecção automática:</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm text-blue-800">
            <li><strong>Detecção ao acessar detalhes:</strong> Quando você acessa os detalhes de um item, o sistema verifica automaticamente se há imagens no bucket</li>
            <li><strong>Padrão de nomenclatura:</strong> As imagens devem seguir o padrão <code className="bg-blue-100 px-1 rounded">CODIGO_NUMERO.extensao</code></li>
            <li><strong>Exemplo:</strong> Para o item 3000003, as imagens devem ser: 3000003_1.jpg, 3000003_2.png, etc.</li>
            <li><strong>Importação automática:</strong> As imagens são importadas automaticamente e aparecem nos detalhes do item</li>
            <li><strong>Sem duplicação:</strong> O sistema não importa imagens que já estão cadastradas</li>
          </ol>
        </div>

        {/* Vantagens */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-green-900 mb-2">Vantagens da detecção automática:</h3>
          <ul className="list-disc list-inside space-y-1 text-sm text-green-800">
            <li>✅ <strong>Sem intervenção manual:</strong> As imagens são detectadas automaticamente</li>
            <li>✅ <strong>Atualização em tempo real:</strong> Novas imagens aparecem imediatamente</li>
            <li>✅ <strong>Eficiência:</strong> Não precisa usar a página de importação manual</li>
            <li>✅ <strong>Consistência:</strong> Garante que todas as imagens sejam importadas</li>
            <li>✅ <strong>Performance:</strong> Executa em background sem afetar a experiência do usuário</li>
          </ul>
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

export default DetectarImagensAutomaticas; 