import React, { useState } from 'react';
import { Upload, FileText, CheckCircle, XCircle } from 'react-feather';

const ImportarExcel = () => {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

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
      if (response.ok) {
        setStatus('sucesso');
        setMessage(data.message || 'Importação realizada com sucesso!');
        setFile(null);
      } else {
        setStatus('erro');
        setMessage(data.error || 'Erro ao importar arquivo.');
      }
    } catch (error) {
      setStatus('erro');
      setMessage('Erro de conexão.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-12 px-4">
      <div style={{
        background: '#fff',
        borderRadius: 20,
        boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
        border: '1.5px solid #d1d5db',
        maxWidth: 480,
        width: '100%',
        padding: 40,
        margin: '40px 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 28
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ background: '#0915FF', borderRadius: '50%', padding: 14, marginBottom: 8 }}>
            <FileText style={{ color: '#fff', width: 32, height: 32 }} />
          </div>
          <h1 style={{ color: '#0915FF', fontWeight: 800, fontSize: 26, textAlign: 'center', margin: 0 }}>
            Importar Itens via Excel
          </h1>
          <p style={{ color: '#444', fontSize: 16, textAlign: 'center', margin: 0, maxWidth: 340 }}>
            Faça upload de um arquivo Excel (.xlsx ou .csv) para cadastrar ou atualizar itens em massa.
          </p>
        </div>
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <label htmlFor="excel-upload" style={{
            border: '2px dashed #d1d5db',
            borderRadius: 12,
            padding: 24,
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
              padding: '14px 0',
              fontSize: 17,
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
          <div style={{ color: '#22c55e', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <CheckCircle style={{ width: 20, height: 20 }} /> {message}
          </div>
        )}
        {status === 'erro' && (
          <div style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <XCircle style={{ width: 20, height: 20 }} /> {message}
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportarExcel; 