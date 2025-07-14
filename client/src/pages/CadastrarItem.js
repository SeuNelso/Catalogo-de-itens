import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Upload, X, Plus, Save, ArrowLeft, Package, FileText } from 'react-feather';
import Toast from '../components/Toast';

const CadastrarItem = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [especificacoes, setEspecificacoes] = useState([]);
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
    unidadeArmazenamento: '',
    quantidade: '' // campo adicionado
  });

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    const validFiles = files.filter(file => file.type.startsWith('image/'));
    
    if (validFiles.length !== files.length) {
      setToast({ type: 'error', message: 'Alguns arquivos não são imagens válidas' });
      return;
    }

    // Verificar se já tem 5 imagens
    if (selectedFiles.length + validFiles.length > 5) {
      setToast({ type: 'error', message: 'Máximo de 5 imagens permitidas por item' });
      return;
    }

    setSelectedFiles(prev => [...prev, ...validFiles]);
  };

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const addEspecificacao = () => {
    setEspecificacoes(prev => [...prev, { nome: '', valor: '', obrigatorio: false }]);
  };

  const removeEspecificacao = (index) => {
    setEspecificacoes(prev => prev.filter((_, i) => i !== index));
  };

  const updateEspecificacao = (index, field, value) => {
    setEspecificacoes(prev => prev.map((spec, i) => 
      i === index ? { ...spec, [field]: value } : spec
    ));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.codigo || !formData.descricao) {
      setToast({ type: 'error', message: 'Código e descrição são obrigatórios' });
      return;
    }

    setLoading(true);

    try {
      const submitData = new FormData();
      
      // Adicionar dados do formulário
      Object.keys(formData).forEach(key => {
        if (formData[key]) {
          submitData.append(key, formData[key]);
        }
      });

      // Adicionar imagens
      selectedFiles.forEach(file => {
        submitData.append('imagens', file);
      });

      // Adicionar especificações
      if (especificacoes.length > 0) {
        submitData.append('especificacoes', JSON.stringify(especificacoes));
      }

      const response = await fetch('/api/itens', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: submitData
      });

      if (response.ok) {
        setToast({ type: 'success', message: 'Item cadastrado com sucesso!' });
        
        // Limpar formulário
        setFormData({
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
          unidadeArmazenamento: '',
          quantidade: ''
        });
        setSelectedFiles([]);
        setEspecificacoes([]);

        // Redirecionar após 2 segundos
        setTimeout(() => {
          navigate('/listar');
        }, 2000);
      } else {
        let errorMsg = 'Erro ao cadastrar item';
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

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  React.useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className={`min-h-screen bg-[#e5e5e5] pb-12 flex flex-col items-center${isMobile ? ' cadastro-mobile-stack' : ''}`}>
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
      <div style={{
        display: isMobile ? 'block' : 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        justifyContent: 'center',
        alignItems: isMobile ? 'stretch' : 'flex-start',
        gap: isMobile ? 0 : 48,
        width: '100%',
        maxWidth: 1200,
        marginTop: isMobile ? 0 : 40,
        padding: isMobile ? '0 0 16px 0' : undefined
      }}>
        {/* Card de informações básicas à esquerda */}
        <div style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
          padding: isMobile ? 16 : 32,
          minWidth: isMobile ? 'unset' : 300,
          maxWidth: isMobile ? '100%' : 400,
          flex: isMobile ? 'unset' : '0 0 400px',
          marginTop: isMobile ? 16 : 32,
          marginLeft: 0,
          marginRight: isMobile ? 0 : 'auto',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18
        }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
            <Package style={{ width: 24, height: 24, color: '#0915FF', marginRight: 12 }} />
            <h2 style={{ color: '#0915FF', fontWeight: 700, fontSize: 20, margin: 0 }}>
              Informações Básicas
            </h2>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Código */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Código <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                type="text"
                name="codigo"
                value={formData.codigo}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  border: '1.5px solid #d1d5db',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border 0.2s'
                }}
                placeholder="Digite o código do item"
                required
              />
            </div>

            {/* Descrição */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Descrição <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <textarea
                name="descricao"
                value={formData.descricao}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  border: '1.5px solid #d1d5db',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border 0.2s',
                  resize: 'vertical',
                  minHeight: 80
                }}
                placeholder="Descreva o item em detalhes"
                rows="3"
                required
              />
            </div>

            {/* Família e Subfamília */}
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                  Família
                </label>
                <input
                  type="text"
                  name="familia"
                  value={formData.familia}
                  onChange={handleInputChange}
                  style={{
                    width: '100%',
                    border: '1.5px solid #d1d5db',
                    borderRadius: 8,
                    padding: '12px 16px',
                    fontSize: 14,
                    outline: 'none',
                    transition: 'border 0.2s'
                  }}
                  placeholder="Ex: Eletrônicos, Ferramentas, etc."
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                  Subfamília
                </label>
                <input
                  type="text"
                  name="subfamilia"
                  value={formData.subfamilia}
                  onChange={handleInputChange}
                  style={{
                    width: '100%',
                    border: '1.5px solid #d1d5db',
                    borderRadius: 8,
                    padding: '12px 16px',
                    fontSize: 14,
                    outline: 'none',
                    transition: 'border 0.2s'
                  }}
                  placeholder="Ex: Smartphones, Chaves, etc."
                />
              </div>
            </div>
            {/* Setor */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Setor
              </label>
              <input
                type="text"
                name="setor"
                value={formData.setor}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  border: '1.5px solid #d1d5db',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border 0.2s'
                }}
                placeholder="Ex: Almoxarifado, Produção, Escritório, etc."
              />
            </div>

            {/* Dimensões */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Dimensões
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <input
                    type="number"
                    name="comprimento"
                    value={formData.comprimento}
                    onChange={handleInputChange}
                    style={{
                      width: '100%',
                      border: '1.5px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border 0.2s'
                    }}
                    placeholder="Comprimento"
                    step="0.1"
                    min="0"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <input
                    type="number"
                    name="largura"
                    value={formData.largura}
                    onChange={handleInputChange}
                    style={{
                      width: '100%',
                      border: '1.5px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border 0.2s'
                    }}
                    placeholder="Largura"
                    step="0.1"
                    min="0"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <input
                    type="number"
                    name="altura"
                    value={formData.altura}
                    onChange={handleInputChange}
                    style={{
                      width: '100%',
                      border: '1.5px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border 0.2s'
                    }}
                    placeholder="Altura"
                    step="0.1"
                    min="0"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <select
                    name="unidade"
                    value={formData.unidade}
                    onChange={handleInputChange}
                    style={{
                      width: '100%',
                      border: '1.5px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border 0.2s',
                      background: '#fff'
                    }}
                  >
                    <option value="">Unidade</option>
                    <option value="cm">cm</option>
                    <option value="mm">mm</option>
                    <option value="m">m</option>
                    <option value="pol">pol</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Peso */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Peso
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <input
                    type="number"
                    name="peso"
                    value={formData.peso}
                    onChange={handleInputChange}
                    style={{
                      width: '100%',
                      border: '1.5px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border 0.2s'
                    }}
                    placeholder="Peso"
                    step="0.1"
                    min="0"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <select
                    name="unidadePeso"
                    value={formData.unidadePeso}
                    onChange={handleInputChange}
                    style={{
                      width: '100%',
                      border: '1.5px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border 0.2s',
                      background: '#fff'
                    }}
                  >
                    <option value="">Unidade</option>
                    <option value="g">g</option>
                    <option value="kg">kg</option>
                    <option value="lb">lb</option>
                    <option value="oz">oz</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Observações */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Observações
              </label>
              <textarea
                name="observacoes"
                value={formData.observacoes}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  border: '1.5px solid #d1d5db',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border 0.2s',
                  resize: 'vertical',
                  minHeight: 80
                }}
                placeholder="Observações adicionais sobre o item"
                rows="3"
              />
            </div>

            {/* Unidade de Armazenamento */}
            <div>
              <label style={{ display: 'block', color: '#374151', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                Unidade de Armazenamento <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <select
                name="unidadeArmazenamento"
                value={formData.unidadeArmazenamento}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  border: '1.5px solid #d1d5db',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border 0.2s',
                  background: '#fff'
                }}
                required
              >
                <option value="">Selecione</option>
                <option value="Unidades">Unidades</option>
                <option value="Metros">Metros</option>
              </select>
            </div>
          </form>
        </div>

        {/* Card de imagens e especificações à direita */}
        <div style={{ flex: 1, minWidth: 350, marginTop: 32 }}>
          <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 8px 32px rgba(9,21,255,0.08)', border: '1.5px solid #d1d5db', overflow: 'hidden' }}>
            {/* Seção de Imagens */}
            <div style={{ padding: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <Package style={{ width: 24, height: 24, color: '#0915FF', marginRight: 12 }} />
                  <h2 style={{ color: '#0915FF', fontWeight: 700, fontSize: 20, margin: 0 }}>
                    Imagens do Item
                  </h2>
                </div>
                <div style={{ 
                  background: selectedFiles.length >= 5 ? '#ef4444' : '#0915FF', 
                  color: '#fff', 
                  padding: '4px 12px', 
                  borderRadius: 12, 
                  fontSize: 12, 
                  fontWeight: 600 
                }}>
                  {selectedFiles.length}/5 imagens
                </div>
              </div>
              
              <div style={{ 
                border: '2px dashed #d1d5db', 
                borderRadius: 12, 
                padding: 24, 
                textAlign: 'center', 
                marginBottom: 20,
                opacity: selectedFiles.length >= 5 ? 0.5 : 1,
                pointerEvents: selectedFiles.length >= 5 ? 'none' : 'auto'
              }}>
                <input
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                  id="image-upload"
                  disabled={selectedFiles.length >= 5}
                />
                <label htmlFor="image-upload" style={{ cursor: selectedFiles.length >= 5 ? 'not-allowed' : 'pointer' }}>
                  <Upload style={{ 
                    width: 48, 
                    height: 48, 
                    color: selectedFiles.length >= 5 ? '#d1d5db' : '#9ca3af', 
                    margin: '0 auto 16px auto' 
                  }} />
                  <p style={{ 
                    fontSize: 16, 
                    fontWeight: 600, 
                    color: selectedFiles.length >= 5 ? '#9ca3af' : '#374151', 
                    marginBottom: 8 
                  }}>
                    {selectedFiles.length >= 5 ? 'Limite de imagens atingido' : 'Clique para selecionar imagens'}
                  </p>
                  <p style={{ color: '#6b7280', fontSize: 14 }}>
                    {selectedFiles.length >= 5 
                      ? `Máximo de 5 imagens permitidas (${selectedFiles.length}/5)`
                      : `Arraste e solte ou clique para selecionar arquivos (${selectedFiles.length}/5)`
                    }
                  </p>
                </label>
              </div>

              {selectedFiles.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 16 }}>
                  {selectedFiles.map((file, index) => (
                    <div key={index} style={{ position: 'relative' }}>
                      <img
                        src={URL.createObjectURL(file)}
                        alt={`Preview ${index + 1}`}
                        style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 8 }}
                      />
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          background: '#ef4444',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '50%',
                          width: 24,
                          height: 24,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer'
                        }}
                      >
                        <X style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Seção de Especificações */}
            <div style={{ padding: '0 32px 32px 32px' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
                <FileText style={{ width: 24, height: 24, color: '#0915FF', marginRight: 12 }} />
                <h2 style={{ color: '#0915FF', fontWeight: 700, fontSize: 20, margin: 0 }}>
                  Especificações
                </h2>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {especificacoes.map((spec, index) => (
                  <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 16, background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <input
                        type="text"
                        placeholder="Nome da especificação"
                        value={spec.nome}
                        onChange={(e) => updateEspecificacao(index, 'nome', e.target.value)}
                        style={{
                          width: '100%',
                          border: '1.5px solid #d1d5db',
                          borderRadius: 6,
                          padding: '8px 12px',
                          fontSize: 14,
                          outline: 'none'
                        }}
                      />
                      <input
                        type="text"
                        placeholder="Valor"
                        value={spec.valor}
                        onChange={(e) => updateEspecificacao(index, 'valor', e.target.value)}
                        style={{
                          width: '100%',
                          border: '1.5px solid #d1d5db',
                          borderRadius: 6,
                          padding: '8px 12px',
                          fontSize: 14,
                          outline: 'none'
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeEspecificacao(index)}
                      style={{
                        color: '#ef4444',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 4
                      }}
                    >
                      <X style={{ width: 20, height: 20 }} />
                    </button>
                  </div>
                ))}
                
                <button
                  type="button"
                  onClick={addEspecificacao}
                  style={{
                    background: '#0915FF',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '12px 20px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 14
                  }}
                >
                  <Plus style={{ width: 16, height: 16 }} />
                  Adicionar Especificação
                </button>
              </div>
            </div>
          </div>

          {/* Botão de Cadastrar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
            <Link 
              to="/listar" 
              style={{
                display: 'flex',
                alignItems: 'center',
                color: '#6b7280',
                textDecoration: 'none',
                fontWeight: 500,
                fontSize: 14
              }}
            >
              <ArrowLeft style={{ width: 16, height: 16, marginRight: 8 }} />
              Voltar ao Catálogo
            </Link>
            
            <button
              type="submit"
              disabled={loading}
              onClick={handleSubmit}
              style={{
                background: '#0915FF',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '14px 32px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 16,
                boxShadow: '0 2px 8px rgba(9,21,255,0.2)'
              }}
            >
              {loading ? (
                <>
                  <div style={{ width: 20, height: 20, border: '2px solid #fff', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                  Cadastrando...
                </>
              ) : (
                <>
                  <Save style={{ width: 20, height: 20 }} />
                  Cadastrar Item
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default CadastrarItem; 