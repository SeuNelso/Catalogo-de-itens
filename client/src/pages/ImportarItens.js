import React, { useState } from 'react';
import { Box, CheckCircle, XCircle } from 'react-feather';
import Toast from '../components/Toast';
import ImportProgressBar from '../components/ImportProgressBar';
import { useImportProgress } from '../contexts/ImportProgressContext';

const ImportarItens = () => {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [toast, setToast] = useState(null);
  const { startImport, status: contextStatus, progress } = useImportProgress();

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setStatus('');
    setMessage('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setStatus('erro');
      setMessage('Selecione um arquivo Excel (.xlsx)');
      return;
    }
    setLoading(true);
    setStatus('');
    setMessage('');
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      const token = localStorage.getItem('token');
      const response = await fetch('/api/importar-itens', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });
      const data = await response.json();
      if (response.ok && data.importId) {
        startImport(data.importId, `/api/importar-itens-status/${data.importId}`);
        setStatus('progresso');
        setMessage('Importação iniciada.');
        setFile(null);
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
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <ImportProgressBar />
      <div className="backdrop-blur-md bg-white/80 rounded-2xl shadow-2xl border border-[#d1d5db] w-full max-w-[95vw] sm:max-w-[420px] p-4 sm:p-6 flex flex-col items-center gap-4 sm:gap-6">
        <div className="bg-[#0915FF] rounded-full p-3 sm:p-4 mb-2 flex items-center justify-center">
          <svg xmlns='http://www.w3.org/2000/svg' className='text-white' width='24' height='24' fill='none' viewBox='0 0 24 24' stroke='currentColor'><path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M12 4v16m8-8H4'/></svg>
        </div>
        <h2 className="text-[#0915FF] font-extrabold text-[18px] sm:text-[22px] mb-1 text-center">Importar Itens em Lote</h2>
        <p className="text-[#444] text-[13px] sm:text-[14px] mb-2 text-center">
          Faça upload de um arquivo Excel (.xlsx) para cadastrar novos itens no sistema.<br/>
          <b>Atenção:</b> Apenas itens <b>novos</b> serão cadastrados. Itens já existentes (mesmo código) serão ignorados.
        </p>
        
        {/* Botão para download do template */}
        <div className="w-full mb-4">
          <button
            type="button"
            onClick={async () => {
              try {
                const response = await fetch('/api/download-template', {
                  headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                  }
                });
                if (response.ok) {
                  const blob = await response.blob();
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'template_importacao_itens.xlsx';
                  document.body.appendChild(a);
                  a.click();
                  window.URL.revokeObjectURL(url);
                  document.body.removeChild(a);
                  setToast({ type: 'success', message: 'Template baixado com sucesso!' });
                } else {
                  setToast({ type: 'error', message: 'Erro ao baixar template.' });
                }
              } catch (error) {
                setToast({ type: 'error', message: 'Erro ao baixar template.' });
              }
            }}
            className="w-full rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[14px] sm:text-[15px] bg-green-600 hover:bg-green-700 text-white flex items-center justify-center gap-1.5 focus:outline-none focus:ring-2 transition-colors duration-200 shadow-md"
          >
            📥 Baixar Template Excel
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:gap-3 w-full">
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileChange}
            disabled={loading}
            className="mb-1 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-[#0915FF] file:text-white file:font-semibold file:text-[13px] file:cursor-pointer file:hover:bg-[#060bcc] file:transition-colors file:duration-200"
          />
          <button
            type="submit"
            disabled={loading || !file}
            className={`rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[14px] sm:text-[15px] flex items-center justify-center gap-1.5 focus:outline-none focus:ring-2 transition-colors duration-200 shadow-md ${file && !loading ? 'bg-[#0915FF] hover:bg-[#060bcc] text-white cursor-pointer' : 'bg-[#e5e7eb] text-[#9ca3af] cursor-not-allowed'}`}
          >
            {loading ? 'Importando...' : 'Importar'}
          </button>
        </form>

        {/* Botão de teste temporário */}
        <button
          type="button"
          onClick={() => {
            console.log('Testando barra de progresso...');
            startImport('test-id', '/api/importar-itens-status/test-id');
          }}
          className="w-full rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[14px] sm:text-[15px] bg-yellow-600 hover:bg-yellow-700 text-white flex items-center justify-center gap-1.5 focus:outline-none focus:ring-2 transition-colors duration-200 shadow-md"
        >
          🧪 Testar Barra de Progresso
        </button>
        
        {/* Status da importação */}
        {(status || contextStatus) && (
          <div className={`w-full p-4 rounded-lg border-2 ${
            (status === 'sucesso' || contextStatus === 'sucesso') ? 'bg-green-50 border-green-200' :
            (status === 'erro' || contextStatus === 'erro') ? 'bg-red-50 border-red-200' :
            'bg-blue-50 border-blue-200'
          }`}>
            <div className="flex items-center gap-3">
              {(status === 'sucesso' || contextStatus === 'sucesso') ? (
                <CheckCircle className="text-green-600" size={24} />
              ) : (status === 'erro' || contextStatus === 'erro') ? (
                <XCircle className="text-red-600" size={24} />
              ) : (
                <Box className="text-blue-600" size={24} />
              )}
              <div>
                <p className={`font-semibold ${
                  (status === 'sucesso' || contextStatus === 'sucesso') ? 'text-green-800' :
                  (status === 'erro' || contextStatus === 'erro') ? 'text-red-800' :
                  'text-blue-800'
                }`}>
                  {(status === 'sucesso' || contextStatus === 'sucesso') ? 'Importação Concluída!' :
                   (status === 'erro' || contextStatus === 'erro') ? 'Erro na Importação' :
                   'Importando...'}
                </p>
                <p className={`text-sm ${
                  (status === 'sucesso' || contextStatus === 'sucesso') ? 'text-green-600' :
                  (status === 'erro' || contextStatus === 'erro') ? 'text-red-600' :
                  'text-blue-600'
                }`}>
                  {message || (progress && `${progress.processados} de ${progress.total} processados`)}
                </p>
              </div>
            </div>
          </div>
        )}
        {resultado && (
          <div className="mt-3 w-full">
            <h4 className="text-[#0915FF] font-semibold text-[14px] sm:text-[15px] mb-1">Resultado:</h4>
            <ul className="text-[12px] sm:text-[13px] text-[#333] m-0 p-0 list-none">
              <li><b>Itens cadastrados:</b> {resultado.cadastrados}</li>
              <li><b>Itens ignorados (já existiam):</b> {resultado.ignorados}</li>
              {resultado.erros && resultado.erros.length > 0 && (
                <li className="text-[#ef4444] mt-2">
                  <b>Erros:</b>
                  <ul className="text-[11px] sm:text-[12px] text-[#ef4444] m-0 pl-4">
                    {resultado.erros.map((erro, i) => (
                      <li key={i}>{erro.linha ? `Linha ${erro.linha}: ` : ''}{erro.motivo}{erro.codigo ? ` (Código: ${erro.codigo})` : ''}</li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportarItens; 