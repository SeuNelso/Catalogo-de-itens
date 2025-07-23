import React, { useState } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { X, Plus, Save, ArrowLeft, Package, FileText } from 'react-feather';
import Toast from '../components/Toast';

const CadastrarItem = () => {
  const navigate = useNavigate();
  const location = useLocation();
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
    unidadearmazenamento: '',
    armazens: [], // novo campo
    tipocontrolo: '' // campo adicionado
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
      
      // Log para depuração
      console.log('Valor selecionado para unidadePeso:', formData.unidadePeso);
      Object.keys(formData).forEach(key => {
        if (key === 'unidadePeso') {
          submitData.append('unidadepeso', formData[key] ?? '');
        } else {
          submitData.append(key, formData[key] ?? '');
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
        // Remover do localStorage de não cadastrados
        const artigosNaoCadastrados = JSON.parse(localStorage.getItem('artigos_nao_cadastrados') || '[]');
        const novos = artigosNaoCadastrados.filter(a => a.codigo !== formData.codigo);
        localStorage.setItem('artigos_nao_cadastrados', JSON.stringify(novos));
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
          unidadearmazenamento: '',
          armazens: [],
          tipocontrolo: ''
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

  React.useEffect(() => {
    // Preencher código e descrição se vierem na URL
    const params = new URLSearchParams(location.search);
    const codigo = params.get('codigo');
    const descricao = params.get('descricao');
    let armazens = [];
    let quantidade = '';
    if (codigo) {
      // Buscar no localStorage o item não cadastrado
      const artigosNaoCadastrados = JSON.parse(localStorage.getItem('artigos_nao_cadastrados') || '[]');
      const artigo = artigosNaoCadastrados.find(a => a.codigo === codigo);
      if (artigo && Array.isArray(artigo.armazens)) {
        armazens = artigo.armazens;
        quantidade = armazens.reduce((soma, a) => soma + (parseFloat(a.quantidade) || 0), 0);
      } else if (artigo && artigo.armazens && typeof artigo.armazens === 'object') {
        // Se vier como objeto, converte para array de objetos
        armazens = Object.entries(artigo.armazens).map(([nome, quantidade]) => ({ nome, quantidade }));
        quantidade = armazens.reduce((soma, a) => soma + (parseFloat(a.quantidade) || 0), 0);
      }
    }
    setFormData(prev => ({
      ...prev,
      codigo: codigo || prev.codigo,
      descricao: descricao || prev.descricao,
      armazens: armazens.length > 0 ? armazens : prev.armazens, // novo campo
      quantidade: quantidade !== '' ? quantidade : prev.quantidade // novo campo
      // tipocontrolo permanece inalterado
    }));
  }, [location.search]);

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  React.useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Listas independentes de famílias e subfamílias
  const familias = [
    "Consumível", "EPC", "EPI", "Equipamentos", "Ferramentas", "Materiais", "Imobilizado", "Software", "Serviços", "Licenças", "Impostos", "Donativos", "Despesas", "Juros", "Câmbio", "Penalidades"
  ];
  const subfamilias = [
    "Consumível", "Acessórios", "Altura", "Sinalética", "Calçado", "Roupa", "Informático", "Imobilizado", "Tecnológico", "Veículos", "Economato", "Digi Romania", "Colaboradores", "Combustíveis", "Comunicações", "Conservação de Edifícios", "Honorários", "Limpeza", "Policiamentos", "Quotas", "Rendas", "Seguros", "Serviços Bancários", "Sucata", "Transporte", "Vigilância", "Coimas", "IUC", "Água", "Eletricidade", "Nokia", "Ericsson"
  ];

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
          <form className="w-full flex flex-col gap-3 sm:gap-4">
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Código *</label>
              <input name="codigo" value={formData.codigo} onChange={handleInputChange} placeholder="Digite o código do item" required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
            </div>
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Descrição *</label>
              <textarea name="descricao" value={formData.descricao} onChange={handleInputChange} placeholder="Descreva o item em detalhes" required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base min-h-[80px] resize-vertical w-full" />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Família</label>
                <select name="familia" value={formData.familia} onChange={e => setFormData(prev => ({ ...prev, familia: e.target.value }))} required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full">
                  <option value="">Selecione a família</option>
                  {familias.map(fam => (
                    <option key={fam} value={fam}>{fam}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Subfamília</label>
                <select name="subfamilia" value={formData.subfamilia} onChange={e => setFormData(prev => ({ ...prev, subfamilia: e.target.value }))} required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full">
                  <option value="">Selecione a subfamília</option>
                  {subfamilias.map(sub => (
                    <option key={sub} value={sub}>{sub}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Setor</label>
              <input name="setor" value={formData.setor} onChange={handleInputChange} placeholder="Ex: Fibra, Móvel, cliente e etc." className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" maxLength={20} />
            </div>
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Dimensões</label>
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
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Peso</label>
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
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Observações</label>
              <textarea name="observacoes" value={formData.observacoes} onChange={handleInputChange} placeholder="Observações adicionais sobre o item" className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base min-h-[80px] resize-vertical w-full" maxLength={50} />
              <div className="text-xs text-gray-500 mt-1 text-right">{formData.observacoes.length}/50</div>
            </div>
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Unidade base *</label>
              <select name="unidadearmazenamento" value={formData.unidadearmazenamento} onChange={handleInputChange} required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base bg-[#f7f8fa] w-full">
                <option value="">Selecione</option>
                <option value="KG">KG</option>
                <option value="MT">MT</option>
                <option value="UN">UN</option>
                <option value="LT">LT</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-800 font-semibold mb-1 text-sm sm:text-base">Tipo de controlo *</label>
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
              <span className="absolute right-8 top-8 bg-[#0915FF] text-white text-xs sm:text-sm font-semibold rounded-full px-4 py-1">{selectedFiles.length}/5 imagens</span>
            </div>
            <div className="w-full">
              <label className="block text-gray-700 font-semibold mb-2 text-sm sm:text-base">Imagens (máx. 5)</label>
              <input type="file" accept="image/*" multiple onChange={handleFileSelect} className="mb-2" />
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
            </div>
            <div className="flex items-center mb-2 mt-4">
              <span className="mr-3"><FileText className="text-[#0915FF] w-6 h-6" /></span>
              <h2 className="text-black font-extrabold text-base sm:text-xl m-0">Especificações</h2>
            </div>
            <div className="w-full flex flex-col gap-2 sm:gap-3">
              {especificacoes.map((spec, index) => (
                <div key={index} className="flex items-center gap-2 p-2 bg-[#f9fafb] rounded-lg">
                  <input type="text" placeholder="Nome da especificação" value={spec.nome} onChange={e => updateEspecificacao(index, 'nome', e.target.value)} className="flex-1 border border-[#d1d5db] rounded-md px-2 py-1 text-sm sm:text-base outline-none" />
                  <input type="text" placeholder="Valor" value={spec.valor} onChange={e => updateEspecificacao(index, 'valor', e.target.value)} className="flex-1 border border-[#d1d5db] rounded-md px-2 py-1 text-sm sm:text-base outline-none" />
                  <button type="button" onClick={() => removeEspecificacao(index)} className="text-[#ef4444] bg-none border-none cursor-pointer p-1"><X className="w-5 h-5" /></button>
                </div>
              ))}
              <button type="button" onClick={addEspecificacao} className="flex items-center justify-center gap-2 bg-[#0915FF] text-white font-semibold rounded-lg py-2 sm:py-3 w-full text-sm sm:text-base mt-2"><Plus className="w-4 h-4" />Adicionar Especificação</button>
            </div>
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

export default CadastrarItem; 