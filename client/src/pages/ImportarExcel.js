import React, { useState } from 'react';
import { Upload, FileText, CheckCircle, XCircle } from 'react-feather';
import { useImportProgress } from '../contexts/ImportProgressContext';

const ImportarExcel = () => {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const { startImport } = useImportProgress();

  React.useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setStatus('');
    setMessage('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setStatus('erro');
      setMessage('Selecione um arquivo Excel (.xlsx ou .csv)');
      return;
    }
    setLoading(true);
    setStatus('');
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
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
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-12 px-4">
      {/* Removida a barra de progresso local, agora é global */}
      <div style={{
        background: '#fff',
        borderRadius: 20,
        boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
        border: '1.5px solid #d1d5db',
        maxWidth: isMobile ? '100%' : '1200px',
        width: '100%',
        padding: isMobile ? 18 : 40,
        margin: isMobile ? '16px 0' : '40px 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: isMobile ? 16 : 28
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ background: '#0915FF', borderRadius: '50%', padding: 14, marginBottom: 8 }}>
            <FileText style={{ color: '#fff', width: 32, height: 32 }} />
          </div>
          <h1 style={{ color: '#0915FF', fontWeight: 800, fontSize: isMobile ? 20 : 26, textAlign: 'center', margin: 0 }}>
            Importar Itens via Excel
          </h1>
          <p style={{ color: '#444', fontSize: isMobile ? 14 : 16, textAlign: 'center', margin: 0, maxWidth: 340 }}>
            Faça upload de um arquivo Excel (.xlsx ou .csv) para cadastrar ou atualizar itens em massa.
          </p>
        </div>
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 18 }}>
          <label htmlFor="excel-upload" style={{
            border: '2px dashed #d1d5db',
            borderRadius: 12,
            padding: isMobile ? 14 : 24,
            textAlign: 'center',
            cursor: 'pointer',
            background: '#f7faff',
            marginBottom: 8,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10
          }}>
            <Upload style={{ width: 36, height: 36, color: '#0915FF', marginBottom: 6 }} />
            <span style={{ color: '#0915FF', fontWeight: 600, fontSize: 16 }}>
              {file ? file.name : 'Clique ou arraste para selecionar o arquivo'}
            </span>
            <input
              id="excel-upload"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            style={{
              background: '#0915FF',
              color: '#fff',
              fontWeight: 700,
              borderRadius: 10,
              padding: isMobile ? '10px 0' : '14px 0',
              fontSize: isMobile ? 15 : 17,
              textAlign: 'center',
              border: 'none',
              boxShadow: '0 2px 8px rgba(9,21,255,0.10)',
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              transition: 'background 0.2s, color 0.2s'
            }}
          >
            {loading ? 'Importando...' : 'Importar Arquivo'}
          </button>
        </form>
        {status === 'sucesso' && (
          <div style={{ color: '#22c55e', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: isMobile ? 14 : 16 }}>
            <CheckCircle style={{ width: 20, height: 20 }} /> {message}
          </div>
        )}
        {status === 'erro' && (
          <div style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: isMobile ? 14 : 16 }}>
            <XCircle style={{ width: 20, height: 20 }} /> {message}
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportarExcel; 