import React, { useState } from 'react';
import { Upload, Box, CheckCircle, XCircle } from 'react-feather';
import { useImportProgress } from '../contexts/ImportProgressContext';
import { useNavigate } from 'react-router-dom';

const ImportarStockNacional = () => {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const { startImport } = useImportProgress();
  const [importId, setImportId] = useState(null);
  const [naoCadastrados, setNaoCadastrados] = useState([]);
  const navigate = useNavigate();

  React.useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
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
          // Salvar no localStorage para ListarItens
          if (naoCad.length > 0) {
            localStorage.setItem('artigos_nao_cadastrados', JSON.stringify(naoCad));
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
        setImportId(data.importId);
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
          <div style={{ background: '#0A7B83', borderRadius: '50%', padding: 14, marginBottom: 8 }}>
            <Box style={{ color: '#fff', width: 32, height: 32 }} />
          </div>
          <h1 style={{ color: '#0A7B83', fontWeight: 900, fontSize: isMobile ? 22 : 30, textAlign: 'center', margin: 0, letterSpacing: 1 }}>
            Importar Stock Nacional
          </h1>
          <p style={{ color: '#333', fontSize: isMobile ? 15 : 18, textAlign: 'center', margin: 0, maxWidth: 420, fontWeight: 500 }}>
            Faça upload de um arquivo Excel (.xlsx ou .csv) no formato de <span style={{ color: '#0A7B83', fontWeight: 700 }}>Stock Nacional</span> para atualizar as quantidades dos itens em cada armazém.<br/>
            <span style={{ color: '#0A7B83', fontWeight: 700 }}>Atenção:</span> O arquivo deve conter as colunas <span style={{ color: '#0A7B83', fontWeight: 700 }}>Artigo, Descrição</span> e pelo menos um armazém (ex: WH1, WH2, ...).
          </p>
          <a href="/exemplo_stock_nacional.xlsx" download style={{ color: '#0A7B83', fontWeight: 700, fontSize: 15, margin: '10px 0 0 0', textDecoration: 'underline' }}>
            Baixar exemplo de arquivo
          </a>
        </div>
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 18, background: '#e6fafd' }}>
          <label htmlFor="stock-upload" style={{
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
              id="stock-upload"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="import-button"
          >
            <Upload size={18} />
            {loading ? 'Importando...' : 'Importar Arquivo'}
          </button>
          {loading && (
            <div style={{ textAlign: 'center', margin: '18px 0 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <svg style={{ width: 28, height: 28 }} viewBox="0 0 50 50">
                <circle cx="25" cy="25" r="20" fill="none" stroke="#0A7B83" strokeWidth="5" strokeDasharray="31.4 31.4" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite" />
                </circle>
              </svg>
              <span style={{ color: '#0A7B83', fontWeight: 600, fontSize: 16 }}>Processando arquivo, aguarde...</span>
            </div>
          )}
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
        {naoCadastrados.length > 0 && (
          <div style={{ marginTop: 24, width: '100%', maxWidth: 600, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 12, padding: 18 }}>
            <h3 style={{ color: '#b45309', fontWeight: 700, fontSize: 18, marginBottom: 10 }}>Artigos não cadastrados encontrados:</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {naoCadastrados.map((art, idx) => (
                <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{art.codigo}</span> - <span>{art.descricao}</span>
                  <button
                    style={{ marginLeft: 'auto', background: '#0A7B83', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontWeight: 600, cursor: 'pointer' }}
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