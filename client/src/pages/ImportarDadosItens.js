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
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // Verificar permissões
  const canImport = user && (user.role === 'admin' || user.role === 'controller');

  useEffect(() => {
    if (!canImport) {
      navigate('/');
      return;
    }

    const handleResize = () => setIsMobile(window.innerWidth <= 768);
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
    <div className={`min-h-screen bg-[#e5e5e5] flex flex-col items-center py-6${isMobile ? ' px-4' : ' px-8'}`}>
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
      
      <div style={{
        background: '#fff',
        borderRadius: isMobile ? 16 : 20,
        boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
        border: '1.5px solid #d1d5db',
        maxWidth: isMobile ? '100%' : 800,
        width: '100%',
        padding: isMobile ? 20 : 40,
        margin: isMobile ? '20px 0' : '40px 0'
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: isMobile ? 24 : 32 }}>
          <div style={{
            background: '#0915FF',
            borderRadius: '50%',
            padding: isMobile ? 12 : 16,
            margin: '0 auto',
            width: 'fit-content',
            marginBottom: isMobile ? 12 : 16
          }}>
            <FileText style={{
              color: '#fff',
              width: isMobile ? 32 : 40,
              height: isMobile ? 32 : 40
            }} />
          </div>
          <h1 style={{
            color: '#0915FF',
            fontWeight: 800,
            fontSize: isMobile ? 24 : 32,
            margin: 0,
            marginBottom: isMobile ? 8 : 12
          }}>
            Importar Dados dos Itens
          </h1>
          <p style={{
            color: '#666',
            fontSize: isMobile ? 16 : 18,
            margin: 0,
            lineHeight: 1.5
          }}>
            Adicione ou atualize informações detalhadas dos itens existentes
          </p>
        </div>

        {/* Instruções */}
        <div style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          padding: isMobile ? 16 : 20,
          marginBottom: isMobile ? 24 : 32
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
            <AlertCircle style={{ color: '#f59e0b', width: 20, height: 20, marginTop: 2 }} />
            <div>
              <h3 style={{ color: '#1f2937', fontWeight: 600, margin: '0 0 8px 0', fontSize: 16 }}>
                Instruções de Importação
              </h3>
              <ul style={{ color: '#6b7280', margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
                <li>O arquivo deve conter uma coluna <strong>"Código"</strong> para identificar os itens</li>
                <li>Os itens que não existirem no sistema serão ignorados</li>
                <li>Campos vazios não serão alterados nos itens existentes</li>
                <li>Formatos suportados: .xlsx, .xls e .csv</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Download Template */}
        <div style={{
          background: '#e6f7ff',
          border: '1px solid #91d5ff',
          borderRadius: 12,
          padding: isMobile ? 16 : 20,
          marginBottom: isMobile ? 24 : 32
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <Download style={{ color: '#1890ff', width: 20, height: 20 }} />
            <h3 style={{ color: '#1890ff', fontWeight: 600, margin: 0, fontSize: 16 }}>
              Template de Importação
            </h3>
          </div>
          <p style={{ color: '#666', margin: '0 0 16px 0', fontSize: 14 }}>
            Baixe o template Excel para ver o formato correto dos dados
          </p>
          <button
            onClick={downloadTemplate}
            style={{
              background: '#1890ff',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <Download size={16} />
            Baixar Template Excel
          </button>
        </div>

        {/* Upload de Arquivo */}
        <div style={{ marginBottom: isMobile ? 24 : 32 }}>
          <h3 style={{ color: '#1f2937', fontWeight: 600, margin: '0 0 16px 0', fontSize: 18 }}>
            Selecionar Arquivo
          </h3>
          
          <div style={{
            border: '2px dashed #d1d5db',
            borderRadius: 12,
            padding: isMobile ? 24 : 32,
            textAlign: 'center',
            background: selectedFile ? '#f0f9ff' : '#fafafa',
            borderColor: selectedFile ? '#3b82f6' : '#d1d5db',
            transition: 'all 0.2s'
          }}>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              id="file-upload"
            />
            
            {!selectedFile ? (
              <label htmlFor="file-upload" style={{ cursor: 'pointer' }}>
                <Upload style={{
                  color: '#6b7280',
                  width: isMobile ? 48 : 64,
                  height: isMobile ? 48 : 64,
                  margin: '0 auto 16px auto',
                  display: 'block'
                }} />
                <p style={{ color: '#6b7280', margin: '0 0 8px 0', fontSize: 16 }}>
                  Clique para selecionar um arquivo Excel ou CSV
                </p>
                <p style={{ color: '#9ca3af', margin: 0, fontSize: 14 }}>
                  ou arraste e solte aqui
                </p>
              </label>
            ) : (
              <div>
                <CheckCircle style={{
                  color: '#10b981',
                  width: isMobile ? 48 : 64,
                  height: isMobile ? 48 : 64,
                  margin: '0 auto 16px auto',
                  display: 'block'
                }} />
                <p style={{ color: '#10b981', fontWeight: 600, margin: '0 0 8px 0', fontSize: 16 }}>
                  Arquivo selecionado
                </p>
                <p style={{ color: '#6b7280', margin: '0 0 16px 0', fontSize: 14 }}>
                  {selectedFile.name}
                </p>
                <button
                  onClick={() => setSelectedFile(null)}
                  style={{
                    background: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    margin: '0 auto'
                  }}
                >
                  <X size={14} />
                  Remover
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Status da Importação */}
        {importStatus && (
          <div style={{
            background: importStatus.success ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${importStatus.success ? '#bbf7d0' : '#fecaca'}`,
            borderRadius: 12,
            padding: isMobile ? 16 : 20,
            marginBottom: isMobile ? 24 : 32
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              {importStatus.success ? (
                <CheckCircle style={{ color: '#10b981', width: 20, height: 20, marginTop: 2 }} />
              ) : (
                <X style={{ color: '#ef4444', width: 20, height: 20, marginTop: 2 }} />
              )}
              <div>
                <h4 style={{
                  color: importStatus.success ? '#10b981' : '#ef4444',
                  fontWeight: 600,
                  margin: '0 0 8px 0',
                  fontSize: 16
                }}>
                  {importStatus.success ? 'Importação Iniciada' : 'Erro na Importação'}
                </h4>
                <p style={{ color: '#6b7280', margin: 0, fontSize: 14 }}>
                  {importStatus.message}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Botões de Ação */}
        <div style={{
          display: 'flex',
          gap: 12,
          justifyContent: 'center',
          flexWrap: 'wrap'
        }}>
          <button
            onClick={() => navigate('/listar')}
            style={{
              background: '#fff',
              color: '#6b7280',
              border: '1.5px solid #d1d5db',
              borderRadius: 8,
              padding: isMobile ? '12px 24px' : '14px 28px',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: isMobile ? 14 : 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <ArrowLeft size={16} />
            Voltar
          </button>
          
          <button
            onClick={handleImport}
            disabled={!selectedFile || loading}
            style={{
              background: selectedFile && !loading ? '#0915FF' : '#e5e7eb',
              color: selectedFile && !loading ? '#fff' : '#9ca3af',
              border: 'none',
              borderRadius: 8,
              padding: isMobile ? '12px 24px' : '14px 28px',
              fontWeight: 600,
              cursor: selectedFile && !loading ? 'pointer' : 'not-allowed',
              fontSize: isMobile ? 14 : 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'all 0.2s'
            }}
          >
            {loading ? (
              <>
                <div style={{
                  width: 16,
                  height: 16,
                  border: '2px solid transparent',
                  borderTop: '2px solid currentColor',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
                Processando...
              </>
            ) : (
              <>
                <Upload size={16} />
                Importar Dados
              </>
            )}
          </button>
        </div>
      </div>

      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default ImportarDadosItens; 