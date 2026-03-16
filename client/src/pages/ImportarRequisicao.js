import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText } from 'react-feather';
import Toast from '../components/Toast';

const ImportarRequisicao = () => {
  const [file, setFile] = useState(null);
  const [armazens, setArmazens] = useState([]);
  const [armazemOrigemId, setArmazemOrigemId] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const navigate = useNavigate();

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 600);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const fetchArmazens = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/armazens?ativo=true', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          // apenas armazéns centrais
          setArmazens(data.filter(a => (a.tipo || '').toLowerCase() === 'central'));
        }
      } catch (err) {
        console.error('Erro ao carregar armazéns:', err);
      }
    };
    fetchArmazens();
  }, []);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setToast(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setToast({ type: 'error', message: 'Selecione um arquivo Excel de requisição (.xlsx).' });
      return;
    }
    if (!armazemOrigemId) {
      setToast({ type: 'error', message: 'Selecione o armazém origem (apenas armazéns centrais).' });
      return;
    }
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      formData.append('armazem_origem_id', armazemOrigemId);
      const token = localStorage.getItem('token');
      const res = await fetch('/api/requisicoes/importar-excel', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ type: 'error', message: data.error || 'Erro ao importar requisição.' });
        setLoading(false);
        return;
      }
      setToast({ type: 'success', message: 'Requisição importada com sucesso!' });
      const reqId = data.requisicao_id;
      setTimeout(() => {
        if (reqId) navigate(`/requisicoes/preparar/${reqId}`);
        else navigate('/requisicoes');
      }, 1200);
    } catch (err) {
      console.error('Erro ao importar requisição:', err);
      setToast({ type: 'error', message: 'Erro de conexão ao importar requisição.' });
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-12 px-4">
      <div
        style={{
          background: '#fff',
          borderRadius: 20,
          boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
          border: '1.5px solid #d1d5db',
          maxWidth: isMobile ? '100%' : '800px',
          width: '100%',
          padding: isMobile ? 18 : 32,
          margin: isMobile ? '16px 0' : '40px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: isMobile ? 16 : 24
        }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-[#0915FF] rounded-full p-3 mb-1">
            <FileText className="text-white" size={28} />
          </div>
          <h1 className="text-[#0915FF] font-extrabold text-xl sm:text-2xl m-0">
            Importar Requisição via Excel
          </h1>
          <p className="text-gray-600 text-sm sm:text-base m-0 max-w-md">
            Selecione o ficheiro de requisição no modelo TRFL/TRA e escolha o armazém de origem.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label
            htmlFor="requisicao-excel-upload"
            className="border-2 border-dashed border-gray-300 rounded-xl p-4 text-center cursor-pointer bg-[#f7faff] flex flex-col items-center gap-2"
          >
            <Upload className="text-[#0915FF]" size={32} />
            <span className="text-[#0915FF] font-semibold text-sm sm:text-base">
              {file ? file.name : 'Clique ou arraste para selecionar o arquivo'}
            </span>
            <input
              id="requisicao-excel-upload"
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Armazém Origem (apenas centrais) *
            </label>
            <select
              value={armazemOrigemId}
              onChange={(e) => setArmazemOrigemId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent text-sm"
            >
              <option value="">Selecione o armazém origem</option>
              {armazens.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.codigo ? `${a.codigo} - ${a.descricao}` : a.descricao}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full bg-[#0915FF] text-white font-bold rounded-lg py-2.5 sm:py-3 text-sm sm:text-base flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Importando...' : 'Importar requisição'}
          </button>
        </form>

        {toast && (
          <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
        )}
      </div>
    </div>
  );
};

export default ImportarRequisicao;

