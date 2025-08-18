import React, { useState } from 'react';
import { Save, CheckCircle, XCircle } from 'react-feather';

const ExportarDados = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');

  React.useEffect(() => {
    function handleResize() {
      // setIsMobile(window.innerWidth <= 600); // This line was removed
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const exportarExcel = async () => {
    setLoading(true);
    setStatus('');
    setMessage('');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/exportar-itens', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) {
        throw new Error('Erro ao exportar dados.');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'catalogo_itens.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setStatus('sucesso');
      setMessage('Exportação concluída!');
    } catch (err) {
      setStatus('erro');
      setMessage(err.message || 'Erro ao exportar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#e0e7ff] via-[#f5f6fa] to-[#e5eefe] py-0 px-2 sm:px-4">
      <div className="backdrop-blur-md bg-white/80 rounded-2xl shadow-2xl border border-[#d1d5db] w-full max-w-[95vw] sm:max-w-[420px] p-4 sm:p-6 flex flex-col items-center gap-4 sm:gap-6">
        <div className="bg-[#0915FF] rounded-full p-3 sm:p-4 mb-2 flex items-center justify-center">
          <Save className="text-white" style={{ width: 24, height: 24 }} />
        </div>
        <h1 className="text-[#0915FF] font-extrabold text-[18px] sm:text-[22px] text-center m-0 tracking-wide">Exportar Catálogo</h1>
        <p className="text-[#333] text-[13px] sm:text-[14px] text-center m-0 max-w-[95vw] sm:max-w-[420px] font-medium">
          Baixe todos os itens do catálogo em Excel (.xlsx), incluindo itens ativos e inativos, com todos os setores de cada item.<br/>
          Apenas usuários autenticados podem exportar.
        </p>
        <div className="w-full flex flex-col gap-2 sm:gap-3 bg-[#e6fafd] rounded-[10px] p-2 sm:p-3 mt-2">
          <button
            onClick={exportarExcel}
            disabled={loading}
            className={`rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[13px] sm:text-[15px] flex items-center justify-center gap-2 focus:outline-none focus:ring-2 transition-colors duration-200 shadow-md ${!loading ? 'bg-[#0915FF] hover:bg-[#060bcc] text-white cursor-pointer' : 'bg-[#e5e7eb] text-[#9ca3af] cursor-not-allowed'}`}
          >
            <Save className="w-[18px] h-[18px] text-white mr-1" />
            {loading ? 'Exportando...' : 'Exportar Catálogo'}
          </button>
          {loading && (
            <div className="text-center mt-2 flex items-center justify-center gap-2">
              <span className="inline-block w-5 h-5 border-2 border-transparent border-t-[#0915FF] rounded-full animate-spin"></span>
              <span className="text-[#0915FF] font-semibold text-[13px] sm:text-[14px]">Gerando arquivo, aguarde...</span>
            </div>
          )}
        </div>
        {status === 'sucesso' && (
          <div className="text-[#22c55e] flex items-center gap-2 font-semibold text-[13px] sm:text-[14px]">
            <CheckCircle className="w-[16px] h-[16px]" /> {message}
          </div>
        )}
        {status === 'erro' && (
          <div className="text-[#ef4444] flex items-center gap-2 font-semibold text-[13px] sm:text-[14px]">
            <XCircle className="w-[16px] h-[16px]" /> {message}
          </div>
        )}
      </div>
    </div>
  );
};

export default ExportarDados; 