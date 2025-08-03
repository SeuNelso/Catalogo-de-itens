import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft, Package } from 'react-feather';
import Toast from '../components/Toast';
import ItensCompostos from '../components/ItensCompostos';

const EditarItem = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [item, setItem] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [imagensExistentes, setImagensExistentes] = useState([]);
  const [imagensRemovidas, setImagensRemovidas] = useState([]);
  const [substituirImagens, setSubstituirImagens] = useState(false);
  const [imagemCompleta, setImagemCompleta] = useState(null);

  const [toast, setToast] = useState(null);
  const [formData, setFormData] = useState({
    codigo: '',
    descricao: '',
    familia: '',
    subfamilia: '',
    setor: '',
    comprimento: '',
    largura: '',
    altura: '',
    unidade: '',
    peso: '',
    unidadePeso: '',
    observacoes: '',
    unidadearmazenamento: '',
    quantidade: '', // campo adicionado
    tipocontrolo: '' // campo adicionado
  });

  // Listas independentes de famílias e subfamílias
  const familias = [
    "Consumível", "EPC", "EPI", "Equipamentos", "Ferramentas", "Materiais", "Imobilizado", "Software", "Serviços", "Licenças", "Impostos", "Donativos", "Despesas", "Juros", "Câmbio", "Penalidades"
  ];
  const subfamilias = [
    "Consumível", "Acessórios", "Altura", "Sinalética", "Calçado", "Roupa", "Informático", "Imobilizado", "Tecnológico", "Veículos", "Economato", "Digi Romania", "Colaboradores", "Combustíveis", "Comunicações", "Conservação de Edifícios", "Honorários", "Limpeza", "Policiamentos", "Quotas", "Rendas", "Seguros", "Serviços Bancários", "Sucata", "Transporte", "Vigilância", "Coimas", "IUC", "Água", "Eletricidade", "Nokia", "Ericsson"
  ];

  useEffect(() => {
    const fetchItem = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/itens/${id}`);
        if (response.ok) {
          const data = await response.json();
          setItem(data);
          setFormData({
            codigo: data.codigo || '',
            descricao: data.descricao || '',
            familia: data.familia || '',
            subfamilia: data.subfamilia || '',
            setor: data.setor || '',
            comprimento: data.comprimento || '',
            largura: data.largura || '',
            altura: data.altura || '',
            unidade: data.unidade || '',
            peso: data.peso || '',
            unidadePeso: data.unidadepeso || '',
            observacoes: data.observacoes || '',
            unidadearmazenamento: data.unidadearmazenamento || '',
            quantidade: data.quantidade || '', // campo adicionado
            tipocontrolo: data.tipocontrolo || '' // campo adicionado
          });

          setImagensExistentes(data.imagens || []);
        } else {
          setToast({ type: 'error', message: 'Item não encontrado' });
        }
      } catch {
        setToast({ type: 'error', message: 'Erro ao carregar item' });
      } finally {
        setLoading(false);
      }
    };
    fetchItem();
  }, [id]);

  useEffect(() => {
    function handleResize() {
      // setIsMobile(window.innerWidth <= 600); // This line was removed
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    const validFiles = files.filter(file => file.type.startsWith('image/'));
    if (validFiles.length !== files.length) {
      setToast({ type: 'error', message: 'Alguns arquivos não são imagens válidas' });
      return;
    }
    
    // Se substituirImagens está ativo, limpar imagens existentes e selecionadas
    if (substituirImagens) {
      // Adicionar todas as imagens existentes à lista de removidas
      setImagensRemovidas(prev => [...prev, ...imagensExistentes]);
      setImagensExistentes([]);
      setSelectedFiles(validFiles);
      setToast({ type: 'info', message: 'Imagens existentes serão substituídas pelas novas imagens' });
    } else {
      // Verificar limite de 5 imagens
      if (selectedFiles.length + validFiles.length + imagensExistentes.length > 5) {
        setToast({ type: 'error', message: `Máximo de 5 imagens permitidas por item. Você já tem ${imagensExistentes.length} imagens existentes e ${selectedFiles.length} novas selecionadas.` });
        return;
      }
      setSelectedFiles(prev => [...prev, ...validFiles]);
    }
  };

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };



  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const submitData = new FormData();
      // Log para depuração
      console.log('Valor selecionado para unidadePeso (edição):', formData.unidadePeso);
      Object.keys(formData).forEach(key => {
        if (key === 'unidadePeso') {
          submitData.append('unidadepeso', formData[key] ?? '');
        } else {
          submitData.append(key, formData[key] ?? '');
        }
      });
      selectedFiles.forEach(file => {
        submitData.append('imagens', file);
      });

      // Adicionar imagem do item completo se existir
      if (imagemCompleta) {
        submitData.append('imagemCompleta', imagemCompleta);
      }

      if (imagensRemovidas.length > 0) {
        submitData.append('imagensRemovidas', JSON.stringify(imagensRemovidas.map(img => img.id)));
      }
      if (substituirImagens) {
        submitData.append('substituirImagens', 'true');
      }
      const response = await fetch(`/api/itens/${id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: submitData
      });
      if (response.ok) {
        setToast({ type: 'success', message: 'Item atualizado com sucesso!' });
        setTimeout(() => navigate('/listar'), 1500);
      } else {
        let errorMsg = 'Erro ao atualizar item';
        try {
          const error = await response.json();
          errorMsg = error.message || JSON.stringify(error) || errorMsg;
        } catch {}
        setToast({ type: 'error', message: errorMsg });
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><div>Carregando...</div></div>;
  }

  return (
    <div className="min-h-screen bg-[#f3f6fd] flex flex-col items-center justify-center py-4 sm:py-12 px-2 sm:px-4">
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
      <div className="flex flex-col md:flex-row gap-4 sm:gap-8 w-full max-w-[98vw] sm:max-w-5xl items-start justify-center">
        {/* Card da esquerda: Informações Básicas */}
        <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] w-full sm:max-w-[420px] p-4 sm:p-8 flex flex-col gap-4 sm:gap-6">
          <div className="flex items-center mb-2">
            <span className="mr-3"><Package className="text-[#0915FF] w-7 h-7" /></span>
            <h2 className="text-black font-extrabold text-lg sm:text-2xl m-0">Informações Básicas</h2>
          </div>
          <form className="w-full flex flex-col gap-3 sm:gap-4" onSubmit={handleSubmit}>
            {/* Código */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Código <span className="text-red-500">*</span></label>
              <input name="codigo" value={formData.codigo} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" placeholder="Digite o código do item" required />
            </div>
            {/* Descrição */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Descrição <span className="text-red-500">*</span></label>
              <textarea name="descricao" value={formData.descricao} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base min-h-[80px] resize-vertical w-full" placeholder="Descreva o item em detalhes" required />
            </div>
            {/* Família e Subfamília */}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Família</label>
                <select name="familia" value={formData.familia} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full" required>
                  <option value="">Selecione a família</option>
                  {familias.map(fam => (
                    <option key={fam} value={fam}>{fam}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Subfamília</label>
                <select name="subfamilia" value={formData.subfamilia} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full" required>
                  <option value="">Selecione a subfamília</option>
                  {subfamilias.map(sub => (
                    <option key={sub} value={sub}>{sub}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* Setor */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Setor</label>
              <input name="setor" value={formData.setor} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" placeholder="Ex: Fibra, Móvel, cliente e etc." maxLength={20} />
            </div>
            {/* Dimensões */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Dimensões</label>
              <div className="flex gap-2">
                <input type="number" name="comprimento" value={formData.comprimento || ''} onChange={handleInputChange} placeholder="Comprimento" className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
                <input type="number" name="largura" value={formData.largura || ''} onChange={handleInputChange} placeholder="Largura" className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
                <input type="number" name="altura" value={formData.altura || ''} onChange={handleInputChange} placeholder="Altura" className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
                <select name="unidade" value={formData.unidade} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-white w-full">
                  <option value="">Uni</option>
                  <option value="cm">cm</option>
                  <option value="mm">mm</option>
                  <option value="m">m</option>
                  <option value="pol">pol</option>
                </select>
              </div>
            </div>
            {/* Peso */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Peso</label>
              <div className="flex gap-2">
                <input type="number" name="peso" value={formData.peso || ''} onChange={handleInputChange} placeholder="Peso" className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
                <select name="unidadePeso" value={formData.unidadePeso} onChange={handleInputChange} className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-white w-full">
                  <option value="">Selecione</option>
                  <option value="g">g</option>
                  <option value="kg">kg</option>
                  <option value="lb">lb</option>
                  <option value="oz">oz</option>
                </select>
              </div>
            </div>
            {/* Observações */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Observações</label>
              <textarea name="observacoes" value={formData.observacoes} onChange={handleInputChange} placeholder="Observações adicionais sobre o item" className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base min-h-[80px] resize-vertical w-full" maxLength={70} />
              <div className="text-xs text-gray-500 mt-1 text-right">{formData.observacoes.length}/70</div>
            </div>
            {/* Unidade base */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Unidade base *</label>
              <select name="unidadearmazenamento" value={formData.unidadearmazenamento} onChange={handleInputChange} required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full">
                <option value="">Selecione</option>
                <option value="KG">KG</option>
                <option value="MT">MT</option>
                <option value="UN">UN</option>
                <option value="LT">LT</option>
              </select>
            </div>
            {/* Tipo de controlo */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Tipo de controlo *</label>
              <select name="tipocontrolo" value={formData.tipocontrolo || ''} onChange={handleInputChange} required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full">
                <option value="">Selecione</option>
                <option value="S/N">S/N</option>
                <option value="LOTE">LOTE</option>
                <option value="Quantidade">Quantidade</option>
              </select>
            </div>
          </form>
        </div>
        {/* Card da direita: Imagens e Especificações */}
        <div className="flex flex-col items-center w-full sm:max-w-[520px]">
          <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] w-full p-4 sm:p-8 flex flex-col gap-4 sm:gap-6 relative">
            <div className="flex items-center mb-2">
              <span className="mr-3"><Package className="text-[#0915FF] w-7 h-7" /></span>
              <h2 className="text-black font-extrabold text-lg sm:text-2xl m-0">Imagens do Item</h2>
              <span className="absolute right-8 top-8 bg-[#0915FF] text-white text-xs sm:text-sm font-semibold rounded-full px-4 py-1">{selectedFiles.length + imagensExistentes.length}/5 imagens</span>
            </div>
            <div className="w-full">
              <label className="block text-gray-700 font-semibold mb-2 text-sm sm:text-base">Imagens (máx. 5)</label>
              <input type="file" accept="image/*" multiple onChange={handleFileSelect} className="mb-2" />
              
              {/* Opção para substituir imagens existentes */}
              {imagensExistentes.length > 0 && (
                <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <label className="flex items-center gap-2 text-sm text-yellow-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={substituirImagens}
                      onChange={(e) => setSubstituirImagens(e.target.checked)}
                      className="rounded border-yellow-300 text-yellow-600 focus:ring-yellow-500"
                    />
                    <span className="font-medium">Substituir imagens existentes</span>
                  </label>
                  <p className="text-xs text-yellow-700 mt-1 ml-6">
                    Quando ativado, as novas imagens substituirão todas as imagens existentes
                  </p>
                </div>
              )}
              {selectedFiles.length > 0 && (
                <div className="flex gap-2 flex-wrap my-2">
                  {selectedFiles.map((file, idx) => (
                    <div key={idx} className="relative w-[80px] h-[80px]">
                      <img src={URL.createObjectURL(file)} alt={`preview-${idx}`} className="w-[80px] h-[80px] object-cover rounded-lg border border-[#d1d5db]" />
                      <button type="button" onClick={() => removeFile(idx)} className="absolute -top-2 -right-2 bg-[#ef4444] text-white border-none rounded-full w-6 h-6 flex items-center justify-center font-bold text-xs shadow-md" aria-label="Remover imagem">×</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Imagens já cadastradas */}
              {imagensExistentes.length > 0 && (
                <div className="flex gap-2 flex-wrap my-2">
                  {imagensExistentes.map((img, idx) => (
                    <div key={idx} className="relative w-[80px] h-[80px]">
                      <img
                        src={img.caminho || img.url || img}
                        alt={`imagem-existente-${idx}`}
                        className="w-[80px] h-[80px] object-cover rounded-lg border border-[#d1d5db]"
                        onError={(e) => {
                          console.error('Erro ao carregar imagem:', img.caminho || img.url || img);
                          e.target.style.display = 'none';
                          const placeholder = document.createElement('div');
                          placeholder.className = 'w-full h-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs';
                          placeholder.textContent = 'Erro';
                          e.target.parentNode.appendChild(placeholder);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const imagemRemovida = imagensExistentes[idx];
                          setImagensExistentes(prev => prev.filter((_, i) => i !== idx));
                          setImagensRemovidas(prev => [...prev, imagemRemovida]);
                        }}
                        className="absolute -top-2 -right-2 bg-[#ef4444] text-white border-none rounded-full w-6 h-6 flex items-center justify-center font-bold text-xs shadow-md"
                        aria-label="Remover imagem existente"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
                        {/* Itens Compostos */}
            <ItensCompostos
              itemId={id}
              isEditing={true}
              onImagemCompletaChange={setImagemCompleta}
              imagensCompostas={item?.imagensCompostas || []}
            />
          </div>
          {/* Linha de ações logo abaixo do card de imagens */}
          <div className="flex w-full justify-between items-center mt-4 px-1">
            <a href="/listar" className="text-[#0915FF] font-semibold flex items-center gap-2 hover:underline text-sm sm:text-base">
              <ArrowLeft className="w-5 h-5" /> Voltar ao Catálogo
            </a>
            <button type="button" onClick={handleSubmit} disabled={loading} className="bg-[#0915FF] text-white font-bold rounded-lg py-2 sm:py-3 px-4 sm:px-8 text-sm sm:text-lg border-none shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <Save className="w-5 h-5" /> Gravar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EditarItem; 