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
    <div className="min-h-screen bg-[#e5e5e5] flex flex-col items-center py-12 px-4">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 8px 32px rgba(9,21,255,0.08)', padding: 32, maxWidth: 420, width: '100%', marginTop: 40 }}>
        <h2 style={{ color: '#0915FF', fontWeight: 700, fontSize: 22, marginBottom: 18 }}>Importar Itens em Lote</h2>
        <p style={{ color: '#444', fontSize: 15, marginBottom: 18 }}>
          Faça upload de um arquivo Excel (.xlsx) para cadastrar novos itens no sistema.<br/>
          <b>Atenção:</b> Apenas itens <b>novos</b> serão cadastrados. Itens já existentes (mesmo código) serão ignorados.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileChange}
            disabled={loading}
            style={{ marginBottom: 8 }}
          />
          <button
            type="submit"
            disabled={loading || !file}
            style={{
              background: '#0915FF', color: '#fff', border: 'none', borderRadius: 8, padding: '12px 0', fontWeight: 600, fontSize: 16, cursor: loading ? 'not-allowed' : 'pointer', marginBottom: 8
            }}
          >
            {loading ? 'Importando...' : 'Importar'}
          </button>
        </form>
        {resultado && (
          <div style={{ marginTop: 24 }}>
            <h4 style={{ color: '#0915FF', fontWeight: 600, fontSize: 17 }}>Resultado:</h4>
            <ul style={{ fontSize: 15, color: '#333', margin: '10px 0 0 0', padding: 0, listStyle: 'none' }}>
              <li><b>Itens cadastrados:</b> {resultado.cadastrados}</li>
              <li><b>Itens ignorados (já existiam):</b> {resultado.ignorados}</li>
              {resultado.erros && resultado.erros.length > 0 && (
                <li style={{ color: '#ef4444', marginTop: 8 }}>
                  <b>Erros:</b>
                  <ul style={{ fontSize: 14, color: '#ef4444', margin: 0, paddingLeft: 16 }}>
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