import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText } from 'react-feather';
import Toast from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';
import { getRequisicoesArmazemOrigemIds } from '../utils/requisicoesArmazemOrigem';
import { filtrarArmazensOrigemRequisicao } from '../utils/armazensRequisicaoOrigem';

const ImportarRequisicao = () => {
  const [files, setFiles] = useState([]);
  const [armazens, setArmazens] = useState([]);
  const [armazemOrigemId, setArmazemOrigemId] = useState('');
  const [loading, setLoading] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [toast, setToast] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const navigate = useNavigate();
  const { user } = useAuth();

  const armazensLista = useMemo(() => {
    const allowed = getRequisicoesArmazemOrigemIds(user);
    if (allowed.length === 0 || user?.role === 'admin') return armazens;
    const set = new Set(allowed);
    return armazens.filter((a) => set.has(a.id));
  }, [armazens, user]);

  useEffect(() => {
    const allowed = getRequisicoesArmazemOrigemIds(user);
    if (allowed.length !== 1 || user?.role === 'admin') return;
    setArmazemOrigemId(String(allowed[0]));
  }, [user]);

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
          setArmazens(filtrarArmazensOrigemRequisicao(data));
        }
      } catch (err) {
        console.error('Erro ao carregar armazéns:', err);
      }
    };
    fetchArmazens();
  }, []);

  const handleFileChange = (e) => {
    setFiles(Array.from(e.target.files || []));
    setToast(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!files.length) {
      setToast({ type: 'error', message: 'Selecione pelo menos um arquivo Excel de requisição (.xlsx).' });
      return;
    }
    if (!armazemOrigemId) {
      setToast({ type: 'error', message: 'Selecione o armazém de origem (central, viatura, APEADO ou EPI).' });
      return;
    }
    setLoading(true);
    setImportProgress({ current: 0, total: files.length });
    try {
      const token = localStorage.getItem('token');
      let okCount = 0;
      let erroCount = 0;
      const erros = [];

      for (let i = 0; i < files.length; i += 1) {
        const currentFile = files[i];
        setImportProgress({ current: i + 1, total: files.length });

        const formData = new FormData();
        formData.append('arquivo', currentFile);
        formData.append('armazem_origem_id', armazemOrigemId);

        // eslint-disable-next-line no-await-in-loop
        const res = await fetch('/api/requisicoes/importar-excel', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        });
        // eslint-disable-next-line no-await-in-loop
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          okCount += 1;
        } else {
          erroCount += 1;
          erros.push(`${currentFile?.name || `Arquivo ${i + 1}`}: ${data.error || 'Erro ao importar.'}`);
        }
      }

      if (okCount === files.length) {
        setToast({
          type: 'success',
          message: okCount === 1
            ? 'Requisição importada com sucesso!'
            : `${okCount} arquivo(s) importado(s) com sucesso!`
        });
        setTimeout(() => {
          navigate('/requisicoes');
        }, 1200);
      } else if (okCount > 0) {
        setToast({
          type: 'success',
          message: `${okCount} arquivo(s) importado(s) e ${erroCount} com erro. ${erros[0] || ''}`.trim()
        });
      } else {
        setToast({
          type: 'error',
          message: `Falha ao importar ${erroCount} arquivo(s). ${erros[0] || ''}`.trim()
        });
      }
    } catch (err) {
      console.error('Erro ao importar requisição:', err);
      setToast({ type: 'error', message: 'Erro de conexão ao importar requisição.' });
    } finally {
      setLoading(false);
      setImportProgress({ current: 0, total: 0 });
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
              {files.length === 0
                ? 'Clique ou arraste para selecionar um ou mais arquivos'
                : files.length === 1
                  ? files[0].name
                  : `${files.length} arquivos selecionados`}
            </span>
            <input
              id="requisicao-excel-upload"
              type="file"
              accept=".xlsx,.xls"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Armazém de origem (central, viatura, APEADO ou EPI) *
            </label>
            <select
              value={armazemOrigemId}
              onChange={(e) => setArmazemOrigemId(e.target.value)}
              disabled={
                armazensLista.length === 1 &&
                getRequisicoesArmazemOrigemIds(user).length >= 1 &&
                user?.role !== 'admin'
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent text-sm"
            >
              <option value="">Selecione o armazém origem</option>
              {armazensLista.map((a) => (
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
            {loading
              ? `Importando ${importProgress.current}/${importProgress.total}...`
              : files.length > 1
                ? 'Importar requisições'
                : 'Importar requisição'}
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

