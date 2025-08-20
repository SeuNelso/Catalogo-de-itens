import React, { useState } from 'react';
import { Upload, Box, CheckCircle, XCircle, Link as LinkIcon } from 'react-feather';
import { useImportProgress } from '../contexts/ImportProgressContext';
import { useNavigate } from 'react-router-dom';

const ImportarStockNacional = () => {
  const [file, setFile] = useState(null);
  const [googleSheetsUrl, setGoogleSheetsUrl] = useState('');
  const [importMethod, setImportMethod] = useState('file'); // 'file' ou 'sheets'
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const { startImport } = useImportProgress();
  const [importId, setImportId] = useState(null);
  const [naoCadastrados, setNaoCadastrados] = useState([]);
  const navigate = useNavigate();

  React.useEffect(() => {
    function handleResize() {
      // setIsMobile(window.innerWidth <= 600); // This line is removed
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Buscar status da importação quando importId mudar
  React.useEffect(() => {
    if (!importId) return;
    const token = localStorage.getItem('token');
    const interval = setInterval(async () => {
      const res = await fetch(`/api/importar-excel-status/${importId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'concluido' || data.status === 'erro') {
          clearInterval(interval);
          setLoading(false);
          setStatus(data.status === 'concluido' ? 'sucesso' : 'erro');
          setMessage(data.status === 'concluido' ? 'Importação concluída!' : 'Erro na importação.');
          // Filtrar artigos não cadastrados
          const naoCad = (data.erros || []).filter(e => e.motivo === 'Artigo não cadastrado');
          console.log('Erros da importação:', data.erros); // <-- Adicionado para depuração
          setNaoCadastrados(naoCad);
          
          // Salvar no servidor para sincronização entre dispositivos
          if (naoCad.length > 0) {
            try {
              const token = localStorage.getItem('token');
              const response = await fetch('/api/itens-nao-cadastrados', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ itens: naoCad })
              });
              
              if (response.ok) {
                console.log('Itens não cadastrados sincronizados com sucesso');
              } else {
                console.error('Erro ao sincronizar itens não cadastrados:', response.statusText);
              }
            } catch (error) {
              console.error('Erro ao sincronizar itens não cadastrados:', error);
            }
          }
        }
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [importId]);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setStatus('');
    setMessage('');
  };

  const handleGoogleSheetsUrlChange = (e) => {
    setGoogleSheetsUrl(e.target.value);
    setStatus('');
    setMessage('');
  };

  const validateGoogleSheetsUrl = (url) => {
    // Verificar se é uma URL válida do Google Sheets
    const sheetsRegex = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
    return sheetsRegex.test(url);
  };



  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (importMethod === 'file') {
      if (!file) {
        setStatus('erro');
        setMessage('Selecione um arquivo Excel (.xlsx ou .csv)');
        return;
      }
    } else {
      if (!googleSheetsUrl.trim()) {
        setStatus('erro');
        setMessage('Digite a URL do Google Sheets');
        return;
      }
      if (!validateGoogleSheetsUrl(googleSheetsUrl)) {
        setStatus('erro');
        setMessage('URL do Google Sheets inválida. Use uma URL que comece com https://docs.google.com/spreadsheets/d/');
        return;
      }
    }

    setLoading(true);
    setStatus('');
    setMessage('');

    try {
      const formData = new FormData();
      
      if (importMethod === 'file') {
        formData.append('arquivo', file);
      } else {
        // Para Google Sheets, enviar a URL
        formData.append('googleSheetsUrl', googleSheetsUrl);
      }

      const token = localStorage.getItem('token');
      const response = await fetch('/api/importar-excel', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });
      const data = await response.json();
      if (response.ok && data.importId) {
        startImport(data.importId);
        setImportId(data.importId);
        setStatus('progresso');
        setMessage('Importação iniciada.');
        setFile(null);
        setGoogleSheetsUrl('');
      } else {
        setStatus('erro');
        setMessage(data.error || 'Erro ao importar arquivo.');
        setLoading(false);
      }
    } catch (error) {
      setStatus('erro');
      setMessage('Erro de conexão.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#e0e7ff] via-[#f5f6fa] to-[#e5eefe] flex flex-col items-center justify-center py-4 px-2 sm:px-4">
      <div className="backdrop-blur-md bg-white/80 rounded-2xl shadow-xl border border-[#d1d5db] w-full max-w-[98vw] sm:max-w-[1000px] p-3 sm:p-5 flex flex-col items-center gap-4 sm:gap-6">
        <div className="flex flex-col items-center gap-2 sm:gap-3">
          <div className="bg-[#0A7B83] rounded-full p-3 sm:p-4 mb-2 flex items-center justify-center">
            <Box className="text-white" style={{ width: 24, height: 24 }} />
          </div>
          <h1 className="text-[#0A7B83] font-black text-[18px] sm:text-[28px] text-center m-0 tracking-wide">Importar Stock Nacional</h1>
          <p className="text-[#333] text-[13px] sm:text-[16px] text-center m-0 max-w-[95vw] sm:max-w-[420px] font-medium">
            Faça upload de um arquivo Excel (.xlsx ou .csv) ou use uma URL do Google Sheets no formato de <span className="text-[#0A7B83] font-bold">Stock Nacional</span> para atualizar as quantidades dos itens em cada armazém.<br/>
            <span className="text-[#0A7B83] font-bold">Atenção:</span> O arquivo deve conter as colunas <span className="text-[#0A7B83] font-bold">Artigo, Descrição</span> e pelo menos um armazém (ex: WH1, WH2, ...).
          </p>
          <a href="/exemplo_stock_nacional.xlsx" download className="text-[#0A7B83] font-bold text-[12px] sm:text-[14px] mt-2 underline">Baixar exemplo de arquivo</a>
        </div>

        {/* Seletor de método de importação */}
        <div className="w-full flex flex-col gap-2 sm:gap-3 bg-[#f7faff] rounded-[10px] p-3 sm:p-4">
          <h3 className="text-[#0A7B83] font-bold text-[14px] sm:text-[16px] mb-2">Método de Importação:</h3>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="importMethod"
                value="file"
                checked={importMethod === 'file'}
                onChange={(e) => setImportMethod(e.target.value)}
                className="text-[#0A7B83]"
              />
              <span className="text-[#333] font-medium text-[13px] sm:text-[14px]">Arquivo Excel/CSV</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="importMethod"
                value="sheets"
                checked={importMethod === 'sheets'}
                onChange={(e) => setImportMethod(e.target.value)}
                className="text-[#0A7B83]"
              />
              <span className="text-[#333] font-medium text-[13px] sm:text-[14px]">Google Sheets</span>
            </label>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-2 sm:gap-3 bg-[#e6fafd] rounded-[10px] p-2 sm:p-3">
          {importMethod === 'file' ? (
            <label htmlFor="stock-upload" className="border-2 border-dashed border-[#d1d5db] rounded-[10px] p-3 sm:p-4 text-center cursor-pointer bg-[#f7faff] mb-2 flex flex-col items-center gap-2 sm:gap-3">
              <Upload className="text-[#0915FF] mb-1" style={{ width: 22, height: 22 }} />
              <span className="text-[#0915FF] font-semibold text-[13px] sm:text-[14px]">
                {file ? file.name : 'Clique ou arraste para selecionar o arquivo'}
              </span>
              <input
                id="stock-upload"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          ) : (
            <div className="border-2 border-dashed border-[#d1d5db] rounded-[10px] p-3 sm:p-4 bg-[#f7faff] mb-2">
              <div className="flex items-center gap-2 mb-2">
                <LinkIcon className="text-[#0915FF]" style={{ width: 20, height: 20 }} />
                <span className="text-[#0915FF] font-semibold text-[13px] sm:text-[14px]">URL do Google Sheets</span>
              </div>
              <input
                type="url"
                value={googleSheetsUrl}
                onChange={handleGoogleSheetsUrlChange}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="w-full px-3 py-2 border border-[#d1d5db] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0A7B83]"
              />
              <p className="text-xs text-gray-600 mt-2">
                Cole aqui a URL do seu Google Sheets. Certifique-se de que o arquivo está configurado como "Qualquer pessoa com o link pode visualizar".
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={`rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[13px] sm:text-[15px] flex items-center justify-center gap-2 focus:outline-none focus:ring-2 transition-colors duration-200 shadow-md ${!loading ? 'bg-[#0A7B83] hover:bg-[#065a60] text-white cursor-pointer' : 'bg-[#e5e7eb] text-[#9ca3af] cursor-not-allowed'}`}
          >
            <Upload size={14} />
            {loading ? 'Importando...' : 'Importar Arquivo'}
          </button>
          {loading && (
            <div className="text-center mt-2 flex items-center justify-center gap-2">
              <span className="inline-block w-5 h-5 border-2 border-transparent border-t-[#0A7B83] rounded-full animate-spin"></span>
              <span className="text-[#0A7B83] font-semibold text-[13px] sm:text-[14px]">Processando arquivo, aguarde...</span>
            </div>
          )}
        </form>
        {status === 'sucesso' && (
          <div className="text-[#22c55e] flex items-center gap-2 font-semibold text-[13px] sm:text-[14px]">
            <CheckCircle style={{ width: 16, height: 16 }} /> {message}
          </div>
        )}
        {status === 'erro' && (
          <div className="text-[#ef4444] flex items-center gap-2 font-semibold text-[13px] sm:text-[14px]">
            <XCircle style={{ width: 16, height: 16 }} /> {message}
          </div>
        )}
        {naoCadastrados.length > 0 && (
          <div className="mt-3 sm:mt-4 w-full max-w-[95vw] sm:max-w-[600px] bg-[#fffbe6] border border-[#ffe58f] rounded-[10px] p-3 sm:p-4">
            <h3 className="text-[#b45309] font-bold text-[13px] sm:text-[15px] mb-2">Artigos não cadastrados encontrados:</h3>
            <ul className="list-none p-0 m-0">
              {naoCadastrados.map((art, idx) => (
                <li key={idx} className="flex items-center gap-2 mb-2">
                  <span className="font-semibold">{art.codigo}</span> - <span>{art.descricao}</span>
                  <button
                    className="ml-auto bg-[#0A7B83] hover:bg-[#065a60] text-white rounded-[7px] px-3 py-1 font-semibold text-[12px] sm:text-[13px] transition-colors duration-200"
                    onClick={() => navigate(`/cadastrar?codigo=${encodeURIComponent(art.codigo)}&descricao=${encodeURIComponent(art.descricao)}`)}
                  >Cadastrar artigo</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportarStockNacional; 