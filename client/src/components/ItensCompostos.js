import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Edit2, Trash2, Package, Camera, ExternalLink } from 'react-feather';
import { useNavigate } from 'react-router-dom';
import Toast from './Toast';

const ItensCompostos = ({ itemId, isEditing = false, onImagemCompletaChange, imagensCompostas = [] }) => {
  const navigate = useNavigate();
  const [componentes, setComponentes] = useState([]);
  const [itensDisponiveis, setItensDisponiveis] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdicionar, setShowAdicionar] = useState(false);
  const [selectedItem, setSelectedItem] = useState('');
  const [quantidade, setQuantidade] = useState(1);
  const [editingComponente, setEditingComponente] = useState(null);
  const [toast, setToast] = useState(null);
  const [isItemComposto, setIsItemComposto] = useState(false);
  const [imagemPreview, setImagemPreview] = useState(null);

  // Função para lidar com mudança do checkbox
  const handleCheckboxChange = async (checked) => {
    setIsItemComposto(checked);
    
    // Se desmarcou o checkbox e há componentes, perguntar se quer remover
    if (!checked && componentes.length > 0) {
      if (window.confirm('Deseja remover todos os itens da composição?')) {
        // Remover todos os componentes
        for (const componente of componentes) {
          await removerComponente(componente.id);
        }
      } else {
        // Se não quiser remover, manter o checkbox marcado
        setIsItemComposto(true);
      }
    }
  };

  // Função para lidar com seleção de imagem
  const handleImagemSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.type.startsWith('image/')) {
        setImagemPreview(URL.createObjectURL(file));
        // Notificar o componente pai sobre a mudança
        if (onImagemCompletaChange) {
          onImagemCompletaChange(file);
        }
      } else {
        setToast({ type: 'error', message: 'Por favor, selecione apenas arquivos de imagem' });
      }
    }
  };

  // Função para remover imagem
  const handleRemoveImagem = () => {
    setImagemPreview(null);
    // Notificar o componente pai sobre a remoção
    if (onImagemCompletaChange) {
      onImagemCompletaChange(null);
    }
  };

  // Função para navegar para os detalhes do item
  const handleItemClick = (itemId) => {
    navigate(`/item/${itemId}`);
  };

  // Buscar componentes do item
  const fetchComponentes = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/itens/${itemId}/componentes`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setComponentes(data);
      }
    } catch (error) {
      console.error('Erro ao buscar componentes:', error);
    }
  }, [itemId]);

  // Buscar itens disponíveis para componentes
  const fetchItensDisponiveis = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/itens-para-componentes', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        // Filtrar o próprio item e componentes já adicionados
        const componentesIds = componentes.map(c => c.item_id);
        const itensFiltrados = data.filter(item => 
          item.id !== parseInt(itemId) && !componentesIds.includes(item.id)
        );
        setItensDisponiveis(itensFiltrados);
      }
    } catch (error) {
      console.error('Erro ao buscar itens disponíveis:', error);
    }
  }, [itemId, componentes]);

  useEffect(() => {
    fetchComponentes();
  }, [fetchComponentes]);

  useEffect(() => {
    // Se há componentes, o item é composto
    if (componentes.length > 0) {
      setIsItemComposto(true);
    } else {
      // Se não há componentes, desmarcar o checkbox
      setIsItemComposto(false);
    }
  }, [componentes.length]);

  useEffect(() => {
    if (showAdicionar) {
      fetchItensDisponiveis();
    }
  }, [showAdicionar, fetchItensDisponiveis]);

     const adicionarComponente = async () => {
     if (!selectedItem || quantidade <= 0 || !Number.isInteger(parseFloat(quantidade))) {
       setToast({ type: 'error', message: 'Selecione um item e informe uma quantidade inteira válida' });
       return;
     }

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/itens/${itemId}/componentes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          item_componente_id: selectedItem,
          quantidade_componente: parseFloat(quantidade)
        })
      });

             if (response.ok) {
         setToast({ type: 'success', message: 'Item adicionado à composição com sucesso!' });
        setShowAdicionar(false);
        setSelectedItem('');
        setQuantidade(1);
        fetchComponentes();
             } else {
         const error = await response.json();
         setToast({ type: 'error', message: error.error || 'Erro ao adicionar item à composição' });
       }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

     const removerComponente = async (componenteId) => {
     if (!window.confirm('Tem certeza que deseja remover este item da composição?')) return;

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/itens/${itemId}/componentes/${componenteId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

             if (response.ok) {
         setToast({ type: 'success', message: 'Item removido da composição com sucesso!' });
        fetchComponentes();
             } else {
         const error = await response.json();
         setToast({ type: 'error', message: error.error || 'Erro ao remover item da composição' });
       }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

     const atualizarQuantidade = async (componenteId, novaQuantidade) => {
     if (novaQuantidade <= 0 || !Number.isInteger(parseFloat(novaQuantidade))) {
       setToast({ type: 'error', message: 'Quantidade necessária deve ser um número inteiro maior que zero' });
       return;
     }

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/itens/${itemId}/componentes/${componenteId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          quantidade_componente: parseFloat(novaQuantidade)
        })
      });

             if (response.ok) {
         setToast({ type: 'success', message: 'Quantidade necessária atualizada com sucesso!' });
        setEditingComponente(null);
        fetchComponentes();
             } else {
         const error = await response.json();
         setToast({ type: 'error', message: error.error || 'Erro ao atualizar quantidade necessária' });
       }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

    return (
    <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] p-4 sm:p-8 mb-6">
      {/* Checkbox para ativar composição */}
      {isEditing && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <label className="flex items-center gap-2 text-sm text-blue-800 cursor-pointer">
                         <input
               type="checkbox"
               checked={isItemComposto}
               onChange={(e) => handleCheckboxChange(e.target.checked)}
               className="rounded border-blue-300 text-blue-600 focus:ring-blue-500"
             />
            <span className="font-medium">Este item é composto por outros itens</span>
          </label>
          <p className="text-xs text-blue-700 mt-1 ml-6">
            Marque esta opção se o item é formado por outros itens do catálogo
          </p>
        </div>
      )}

      {/* Seção de composição - só aparece se o checkbox estiver marcado */}
      {isItemComposto && (
        <>
          {/* Seção de imagem do item completo */}
          {isEditing ? (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center mb-3">
                <Camera className="text-green-600 w-5 h-5 mr-2" />
                <h4 className="font-semibold text-green-900">Imagem do Item Completo</h4>
              </div>
              <p className="text-sm text-green-700 mb-3">
                Adicione uma foto que represente o item completo montado
              </p>
              
              <div className="space-y-3">
                {!imagemPreview ? (
                  <div className="border-2 border-dashed border-green-300 rounded-lg p-4 text-center">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImagemSelect}
                      className="hidden"
                      id="imagem-completa"
                    />
                    <label
                      htmlFor="imagem-completa"
                      className="cursor-pointer flex flex-col items-center gap-2"
                    >
                      <Camera className="text-green-500 w-8 h-8" />
                      <span className="text-sm text-green-600 font-medium">
                        Clique para selecionar uma imagem
                      </span>
                      <span className="text-xs text-green-500">
                        JPG, PNG, GIF (máx. 5MB)
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="relative">
                    <img
                      src={imagemPreview}
                      alt="Preview da imagem do item completo"
                      className="w-full max-w-xs h-auto rounded-lg border border-green-300"
                    />
                    <button
                      onClick={handleRemoveImagem}
                      className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm hover:bg-red-600"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Exibir imagem do item completo em modo de visualização
            imagensCompostas.length > 0 && (
              <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center mb-3">
                  <Camera className="text-green-600 w-5 h-5 mr-2" />
                  <h4 className="font-semibold text-green-900">Imagem do Item Completo</h4>
                </div>
                <p className="text-sm text-green-700 mb-3">
                  Foto do item completo montado
                </p>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {imagensCompostas.map((imagem, index) => (
                    <div key={imagem.id} className="relative group">
                      <img
                        src={imagem.caminho}
                        alt={`Imagem do item completo ${index + 1}`}
                        className="w-full h-48 object-cover rounded-lg border border-green-300 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                        onClick={() => {
                          // Abrir em modal ou nova aba
                          window.open(imagem.caminho, '_blank');
                        }}
                      />
                      <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-20 transition-all duration-200 rounded-lg flex items-center justify-center">
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <span className="text-white text-sm font-medium bg-black bg-opacity-50 px-2 py-1 rounded">
                            Clique para ampliar
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}

          <div className="flex items-center mb-4">
            <Package className="text-[#0915FF] w-6 h-6 mr-3" />
            <h3 className="text-lg font-semibold text-gray-900">Composição do Item</h3>
            {!isEditing && (
              <span className="text-xs text-gray-500 ml-2">(Clique nos itens para ver detalhes)</span>
            )}
            {isEditing && (
              <button
                onClick={() => setShowAdicionar(!showAdicionar)}
                className="ml-auto bg-[#0915FF] text-white px-3 py-1 rounded-lg text-sm flex items-center gap-2 hover:bg-blue-700"
              >
                <Plus className="w-4 h-4" />
                Adicionar à Composição
              </button>
            )}
          </div>

      {/* Formulário para adicionar componente */}
      {showAdicionar && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                     <h4 className="font-semibold text-blue-900 mb-3">Adicionar Item à Composição</h4>
          
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-blue-800 mb-1">Item</label>
              <select
                value={selectedItem}
                onChange={(e) => setSelectedItem(e.target.value)}
                className="w-full px-3 py-2 border border-blue-300 rounded-lg text-sm"
              >
                <option value="">Selecione um item</option>
                {itensDisponiveis.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.codigo} - {item.descricao}
                  </option>
                ))}
              </select>
            </div>
            
                         <div>
               <label className="block text-sm font-medium text-blue-800 mb-1">Quantidade Necessária</label>
                               <input
                  type="number"
                  min="1"
                  step="1"
                  value={quantidade}
                  onChange={(e) => setQuantidade(e.target.value)}
                  className="w-full px-3 py-2 border border-blue-300 rounded-lg text-sm"
                  placeholder="Ex: 2"
                />
                               <p className="text-xs text-blue-600 mt-1">Quantidade inteira do componente necessária para 1 unidade do item principal</p>
             </div>
            
            <div className="flex items-end gap-2">
              <button
                onClick={adicionarComponente}
                disabled={loading || !selectedItem}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50"
              >
                {loading ? 'Adicionando...' : 'Adicionar'}
              </button>
              <button
                onClick={() => {
                  setShowAdicionar(false);
                  setSelectedItem('');
                  setQuantidade(1);
                }}
                className="bg-gray-500 text-white px-4 py-2 rounded-lg text-sm"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lista de componentes */}
      {componentes.length > 0 ? (
        <div className="space-y-3">
          {componentes.map((componente) => (
            <div key={componente.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg group">
              <div className="flex-1 cursor-pointer hover:bg-gray-100 transition-colors duration-200 p-2 rounded" onClick={() => handleItemClick(componente.item_id)}>
                                 <div className="font-medium text-gray-900 flex items-center gap-2 group-hover:text-blue-600 transition-colors duration-200">
                   {componente.codigo} - {componente.descricao}
                   <ExternalLink className="w-4 h-4 text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                 </div>
                                  <div className="text-sm text-gray-600 group-hover:text-blue-500 transition-colors duration-200">
                    Unidade: {componente.unidadearmazenamento} | Qtd. Necessária: {Math.round(componente.quantidade_componente)}
                  </div>
              </div>
              
              <div className="flex items-center gap-3">
                {editingComponente === componente.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={quantidade}
                      onChange={(e) => setQuantidade(e.target.value)}
                      className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
                    />
                    <button
                      onClick={() => atualizarQuantidade(componente.id, quantidade)}
                      className="text-green-600 hover:text-green-800"
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => {
                        setEditingComponente(null);
                        setQuantidade(componente.quantidade_componente);
                      }}
                      className="text-gray-600 hover:text-gray-800"
                    >
                      ✕
                    </button>
                  </div>
                                 ) : (
                                      <div className="flex items-center gap-2">
                     {isEditing && (
                       <>
                         <button
                           onClick={() => {
                             setEditingComponente(componente.id);
                             setQuantidade(componente.quantidade_componente);
                           }}
                           className="text-blue-600 hover:text-blue-800"
                         >
                           <Edit2 className="w-4 h-4" />
                         </button>
                         <button
                           onClick={() => removerComponente(componente.id)}
                           className="text-red-600 hover:text-red-800"
                         >
                           <Trash2 className="w-4 h-4" />
                         </button>
                       </>
                     )}
                   </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-gray-500">
          <Package className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                   <p>Nenhum item na composição</p>
         {isEditing && (
           <p className="text-sm mt-1">Clique em "Adicionar à Composição" para começar</p>
         )}
        </div>
      )}

               </>
       )}

       {/* Mensagem quando não é item composto */}
       {!isItemComposto && isEditing && (
         <div className="text-center py-8 text-gray-500">
           <Package className="w-12 h-12 mx-auto mb-3 text-gray-300" />
           <p>Marque o checkbox acima para configurar a composição do item</p>
         </div>
       )}

       {toast && <Toast {...toast} onClose={() => setToast(null)} />}
     </div>
   );
 };

export default ItensCompostos; 