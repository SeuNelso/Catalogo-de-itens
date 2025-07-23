import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, Download, AlertCircle, CheckCircle, X, ArrowLeft } from 'react-feather';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';

const ImportarDadosItens = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selectedFile, setSelectedFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [toast, setToast] = useState(null);
  // const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);

  // Verificar permissões
  const canImport = user && (user.role === 'admin' || user.role === 'controller');

  useEffect(() => {
    if (!canImport) {
      navigate('/');
      return;
    }

    const handleResize = () => {
      // setIsMobile(window.innerWidth <= 768); // This line was removed as per the edit hint
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [canImport, navigate]);

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      const validTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
        'application/csv'
      ];
      
      if (!validTypes.includes(file.type) && !file.name.endsWith('.csv')) {
        setToast({ type: 'error', message: 'Por favor, selecione um arquivo Excel (.xlsx, .xls) ou CSV (.csv)' });
        return;
      }
      setSelectedFile(file);
      setImportStatus(null);
    }
  };

  const handleImport = async () => {
    if (!selectedFile) {
      setToast({ type: 'error', message: 'Por favor, selecione um arquivo' });
      return;
    }

    setLoading(true);
    setImportStatus(null);

    const formData = new FormData();
    formData.append('arquivo', selectedFile);

    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/importar-dados-itens', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      if (response.ok) {
        const data = await response.json();
        setImportStatus({
          success: true,
          message: 'Importação iniciada com sucesso!',
          importId: data.importId,
          details: data
        });
        setToast({ type: 'success', message: 'Importação iniciada com sucesso!' });
      } else {
        const error = await response.json();
        setImportStatus({
          success: false,
          message: error.error || 'Erro ao iniciar importação'
        });
        setToast({ type: 'error', message: error.error || 'Erro ao iniciar importação' });
      }
    } catch (error) {
      setImportStatus({
        success: false,
        message: 'Erro de conexão'
      });
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      // Importar xlsx dinamicamente
      const XLSX = await import('xlsx');
      
      // Dados de exemplo
      const templateData = [
        {
          'Código': '3000001',
          'Família': 'Equipamentos',
          'Subfamília': 'Informático',
          'Setor': 'TI',
          'Comprimento': '10.5',
          'Largura': '5.2',
          'Altura': '2.1',
          'Unidade': 'cm',
          'Peso': '500',
          'Unidade Peso': 'g',
          'Unidade Armazenamento': 'Caixa',
          'Observações': 'Item de teste'
        },
        {
          'Código': '3000002',
          'Família': 'Consumível',
          'Subfamília': 'Acessórios',
          'Setor': 'Administração',
          'Comprimento': '15.0',
          'Largura': '8.0',
          'Altura': '3.0',
          'Unidade': 'cm',
          'Peso': '250',
          'Unidade Peso': 'g',
          'Unidade Armazenamento': 'Pacote',
          'Observações': 'Item de exemplo'
        }
      ];

      // Criar workbook e worksheet
      const ws = XLSX.utils.json_to_sheet(templateData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Template');

      // Gerar arquivo Excel
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      
      // Download do arquivo
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'template_importacao_dados_itens.xlsx';
      link.click();
      window.URL.revokeObjectURL(url);
      
    } catch (error) {
      console.error('Erro ao gerar template Excel:', error);
      setToast({ type: 'error', message: 'Erro ao gerar template Excel' });
    }
  };

  if (!canImport) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#e0e7ff] via-[#f5f6fa] to-[#e0e7ff] flex flex-col items-center justify-center py-4 px-2 sm:px-4">
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
      <div className="backdrop-blur-md bg-white/80 rounded-2xl shadow-xl border border-[#d1d5db] w-full max-w-[98vw] sm:max-w-[800px] p-3 sm:p-5 flex flex-col items-center gap-4 sm:gap-6">
        {/* Header */}
        <div className="text-center mb-3 sm:mb-4">
          <div className="bg-[#0915FF] rounded-full p-3 sm:p-4 mx-auto w-fit mb-2 flex items-center justify-center">
            <FileText className="text-white" style={{ width: 24, height: 24 }} />
          </div>
          <h1 className="text-[#0915FF] font-extrabold text-[18px] sm:text-[28px] m-0 mb-1 sm:mb-2">Importar Dados dos Itens</h1>
          <p className="text-[#666] text-[13px] sm:text-[16px] m-0 leading-snug">Adicione ou atualize informações detalhadas dos itens existentes</p>
        </div>
        {/* Instruções */}
        <div className="bg-[#f8fafc] border border-[#e2e8f0] rounded-[10px] p-2 sm:p-3 mb-2 sm:mb-3 w-full">
          <div className="flex items-start gap-2 sm:gap-3 mb-2">
            <AlertCircle className="text-[#f59e0b]" style={{ width: 16, height: 16, marginTop: 2 }} />
            <div>
              <h3 className="text-[#1f2937] font-semibold m-0 mb-1 text-[13px] sm:text-[15px]">Instruções de Importação</h3>
              <ul className="text-[#6b7280] m-0 pl-4 leading-tight text-[12px] sm:text-[13px]">
                <li>O arquivo deve conter uma coluna <strong>"Código"</strong> para identificar os itens</li>
                <li>Os itens que não existirem no sistema serão ignorados</li>
                <li>Campos vazios não serão alterados nos itens existentes</li>
                <li>Formatos suportados: .xlsx, .xls e .csv</li>
              </ul>
            </div>
          </div>
        </div>
        {/* Download Template */}
        <div className="bg-[#e6f7ff] border border-[#91d5ff] rounded-[10px] p-2 sm:p-3 mb-2 sm:mb-3 w-full">
          <div className="flex items-center gap-2 sm:gap-3 mb-2">
            <Download className="text-[#1890ff]" style={{ width: 16, height: 16 }} />
            <h3 className="text-[#1890ff] font-semibold m-0 text-[13px] sm:text-[15px]">Template de Importação</h3>
          </div>
          <p className="text-[#666] mb-2 text-[12px] sm:text-[13px]">Baixe o template Excel para ver o formato correto dos dados</p>
          <button
            onClick={downloadTemplate}
            className="bg-[#1890ff] hover:bg-[#1769c7] transition-colors duration-200 text-white rounded-[7px] px-3 sm:px-4 py-1.5 font-semibold text-[12px] sm:text-[13px] flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-[#1890ff]"
            type="button"
          >
            <Download size={14} />
            Baixar Template Excel
          </button>
        </div>
        {/* Upload de Arquivo */}
        <div className="mb-2 sm:mb-3 w-full">
          <h3 className="text-[#1f2937] font-semibold m-0 mb-2 text-[14px] sm:text-[15px]">Selecionar Arquivo</h3>
          <div className={`border-2 border-dashed ${selectedFile ? 'bg-[#f0f9ff] border-[#3b82f6]' : 'bg-[#fafafa] border-[#d1d5db]'} rounded-[10px] p-4 sm:p-5 text-center transition-all duration-200`}>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileSelect}
              className="hidden"
              id="file-upload"
            />
            {!selectedFile ? (
              <label htmlFor="file-upload" className="cursor-pointer block">
                <Upload className="text-[#6b7280] mx-auto mb-2" style={{ width: 28, height: 28 }} />
                <p className="text-[#6b7280] mb-1 text-[13px]">Clique para selecionar um arquivo Excel ou CSV</p>
                <p className="text-[#9ca3af] m-0 text-[11px]">ou arraste e solte aqui</p>
              </label>
            ) : (
              <div>
                <CheckCircle className="text-[#10b981] mx-auto mb-2" style={{ width: 28, height: 28 }} />
                <p className="text-[#10b981] font-semibold mb-1 text-[13px]">Arquivo selecionado</p>
                <p className="text-[#6b7280] mb-2 text-[11px]">{selectedFile.name}</p>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="bg-[#ef4444] hover:bg-[#b91c1c] transition-colors duration-200 text-white rounded-[5px] px-2.5 py-1 font-medium text-[11px] sm:text-[12px] flex items-center gap-1 mx-auto"
                  type="button"
                >
                  <X size={12} />
                  Remover
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Status da Importação */}
        {importStatus && (
          <div className={`${importStatus.success ? 'bg-[#f0fdf4] border-[#bbf7d0]' : 'bg-[#fef2f2] border-[#fecaca]'} border rounded-[10px] p-2 sm:p-3 mb-2 sm:mb-3 w-full`}>
            <div className="flex items-start gap-2 sm:gap-3">
              {importStatus.success ? (
                <CheckCircle className="text-[#10b981]" style={{ width: 14, height: 14, marginTop: 2 }} />
              ) : (
                <X className="text-[#ef4444]" style={{ width: 14, height: 14, marginTop: 2 }} />
              )}
              <div>
                <h4 className={`${importStatus.success ? 'text-[#10b981]' : 'text-[#ef4444]'} font-semibold m-0 mb-1 text-[12px] sm:text-[13px]`}>
                  {importStatus.success ? 'Importação Iniciada' : 'Erro na Importação'}
                </h4>
                <p className="text-[#6b7280] m-0 text-[11px] sm:text-[12px]">{importStatus.message}</p>
              </div>
            </div>
          </div>
        )}
        {/* Botões de Ação */}
        <div className="flex gap-2 justify-center flex-wrap w-full">
          <button
            onClick={() => navigate('/listar')}
            className="bg-white text-[#6b7280] border border-[#d1d5db] rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[13px] sm:text-[14px] flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-[#d1d5db] transition-colors duration-200 hover:bg-[#f3f4f6]"
            type="button"
          >
            <ArrowLeft size={12} />
            Voltar
          </button>
          <button
            onClick={handleImport}
            disabled={(!selectedFile) || loading}
            className={`rounded-[7px] px-3 sm:px-4 py-2 font-semibold text-[13px] sm:text-[14px] flex items-center gap-1.5 focus:outline-none focus:ring-2 transition-colors duration-200 ${selectedFile && !loading ? 'bg-[#0915FF] hover:bg-[#060bcc] text-white cursor-pointer' : 'bg-[#e5e7eb] text-[#9ca3af] cursor-not-allowed'}`}
            type="button"
          >
            {loading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-transparent border-t-current rounded-full animate-spin mr-2"></span>
                Processando...
              </>
            ) : (
              <>
                <Upload size={12} />
                Importar Dados
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportarDadosItens; 