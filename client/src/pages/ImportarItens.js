import React, { useState } from 'react';
import Toast from '../components/Toast';
import ImportProgressBar from '../components/ImportProgressBar';
import { useImportProgress } from '../contexts/ImportProgressContext';

const ImportarItens = () => {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [toast, setToast] = useState(null);
  const { startImport } = useImportProgress();

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setToast({ type: 'error', message: 'Selecione um arquivo Excel (.xlsx)' });
      return;
    }
    setLoading(true);
    setResultado(null);
    setToast(null);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      const response = await fetch('/api/importar-itens', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: formData
      });
      const data = await response.json();
      if (response.ok && data.importId) {
        startImport(data.importId);
        setResultado(null);
        setToast({ type: 'success', message: 'Importação iniciada!' });
        setFile(null);
      } else if (response.ok) {
        setResultado(data);
        setToast({ type: 'success', message: 'Importação concluída!' });
      } else {
        setToast({ type: 'error', message: data.error || data.message || 'Erro ao importar.' });
      }
    } catch (err) {
      setToast({ type: 'error', message: 'Erro de conexão.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#e0e7ff] via-[#f5f6fa] to-[#e5e5e5] py-0 px-2 sm:px-4">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="backdrop-blur-md bg-white/80 rounded-2xl shadow-2xl border border-[#d1d5db] w-full max-w-[95vw] sm:max-w-[420px] p-4 sm:p-6 flex flex-col items-center gap-4 sm:gap-6">
        <div className="bg-[#0915FF] rounded-full p-3 sm:p-4 mb-2 flex items-center justify-center">
          <svg xmlns='http://www.w3.org/2000/svg' className='text-white' width='24' height='24' fill='none' viewBox='0 0 24 24' stroke='currentColor'><path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M12 4v16m8-8H4'/></svg>
        </div>
        <h2 className="text-[#0915FF] font-extrabold text-[18px] sm:text-[22px] mb-1 text-center">Importar Itens em Lote</h2>
        <p className="text-[#444] text-[13px] sm:text-[14px] mb-2 text-center">
          Faça upload de um arquivo Excel (.xlsx) para cadastrar novos itens no sistema.<br/>
          <b>Atenção:</b> Apenas itens <b>novos</b> serão cadastrados. Itens já existentes (mesmo código) serão ignorados.
        </p>
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
      <ImportProgressBar />
    </div>
  );
};

export default ImportarItens; 