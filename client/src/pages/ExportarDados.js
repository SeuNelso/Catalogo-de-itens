import React, { useState } from 'react';
import { Save, CheckCircle, XCircle } from 'react-feather';

const ExportarDados = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);

  React.useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
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
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-12 px-4">
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
            <Save style={{ color: '#fff', stroke: '#fff', width: 32, height: 32 }} />
          </div>
          <h1 style={{ color: '#0915FF', fontWeight: 900, fontSize: isMobile ? 22 : 30, textAlign: 'center', margin: 0, letterSpacing: 1 }}>
            Exportar Catálogo
          </h1>
          <p style={{ color: '#333', fontSize: isMobile ? 15 : 18, textAlign: 'center', margin: 0, maxWidth: 420, fontWeight: 500 }}>
            Baixe todos os itens do catálogo em Excel (.xlsx), exceto as fotos.<br/>
            Apenas usuários autenticados podem exportar.
          </p>
        </div>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 18, background: '#e6fafd', borderRadius: 12, padding: isMobile ? 14 : 24, marginTop: 18 }}>
          <button
            onClick={exportarExcel}
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
            <Save style={{ width: 22, height: 22, color: '#fff', stroke: '#fff' }} />
            {loading ? 'Exportando...' : 'Exportar Catálogo'}
          </button>
          {loading && (
            <div style={{ textAlign: 'center', margin: '18px 0 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <svg style={{ width: 28, height: 28 }} viewBox="0 0 50 50">
                <circle cx="25" cy="25" r="20" fill="none" stroke="#0915FF" strokeWidth="5" strokeDasharray="31.4 31.4" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite" />
                </circle>
              </svg>
              <span style={{ color: '#0915FF', fontWeight: 600, fontSize: 16 }}>Gerando arquivo, aguarde...</span>
            </div>
          )}
        </div>
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

export default ExportarDados; 