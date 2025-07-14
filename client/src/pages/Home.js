import React from 'react';
import { Link } from 'react-router-dom';
import { Database, Plus, Search, Users, Shield, Download, UserPlus } from 'react-feather';
import { useAuth } from '../contexts/AuthContext';

const Home = () => {
  const { isAuthenticated, user } = useAuth();
  const isAdmin = isAuthenticated && user && user.role === 'admin';

  // Função para exportar JSON
  const handleExportJson = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/exportar-json', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        alert('Erro ao exportar dados.');
        return;
      }
      const data = await response.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'exportacao_catalogo.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('Erro de conexão ao exportar dados.');
    }
  };

  return (
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-12 px-4 Home-main">
      <div className="Home-card" style={{
        background: '#fff',
        borderRadius: 20,
        boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
        border: '1.5px solid #d1d5db',
        maxWidth: 540,
        width: '100%',
        padding: 40,
        margin: '40px 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 32
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ background: '#0915FF', borderRadius: '50%', padding: 16, marginBottom: 8 }}>
            <Database style={{ color: '#fff', width: 40, height: 40 }} />
          </div>
          <h1 className="Home-title" style={{ color: '#0915FF', fontWeight: 800, fontSize: 32, textAlign: 'center', margin: 0 }}>
            Catálogo Inteligente
          </h1>
          <p className="Home-desc" style={{ color: '#444', fontSize: 18, textAlign: 'center', margin: 0, maxWidth: 400 }}>
            Sistema moderno para catalogação, identificação visual e gestão de itens.
          </p>
        </div>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Link to="/listar" className="Home-link" style={{
            background: '#fff',
            border: '1.5px solid #0915FF',
            color: '#0915FF',
            fontWeight: 700,
            borderRadius: 12,
            padding: '18px 0',
            fontSize: 18,
            textAlign: 'center',
            textDecoration: 'none',
            boxShadow: '0 2px 8px rgba(9,21,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            transition: 'background 0.2s, color 0.2s'
          }}>
            <Search style={{ width: 22, height: 22 }} />
            Consultar Catálogo
          </Link>
          {isAdmin && (
            <>
              <Link to="/cadastrar" className="Home-link" style={{
                background: '#0915FF',
                color: '#fff',
                fontWeight: 700,
                borderRadius: 12,
                padding: '18px 0',
                fontSize: 18,
                textAlign: 'center',
                textDecoration: 'none',
                boxShadow: '0 2px 8px rgba(9,21,255,0.10)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                transition: 'background 0.2s, color 0.2s'
              }}>
                <Plus style={{ width: 22, height: 22 }} />
                Cadastrar Novo Item
              </Link>
              <button
                onClick={handleExportJson}
                style={{
                  background: '#22c55e',
                  color: '#fff',
                  fontWeight: 700,
                  borderRadius: 12,
                  padding: '18px 0',
                  fontSize: 18,
                  textAlign: 'center',
                  border: 'none',
                  boxShadow: '0 2px 8px rgba(34,197,94,0.10)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  marginTop: 10,
                  cursor: 'pointer',
                  transition: 'background 0.2s, color 0.2s',
                  width: '100%'
                }}
              >
                <Download style={{ width: 22, height: 22 }} />
                Exportar Dados (JSON)
              </button>
              <Link to="/cadastrar-usuario" className="Home-link" style={{
                background: '#fff',
                border: '1.5px solid #22c55e',
                color: '#22c55e',
                fontWeight: 700,
                borderRadius: 12,
                padding: '18px 0',
                fontSize: 18,
                textAlign: 'center',
                textDecoration: 'none',
                boxShadow: '0 2px 8px rgba(34,197,94,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                marginTop: 10,
                transition: 'background 0.2s, color 0.2s',
                width: '100%'
              }}>
                <UserPlus style={{ width: 22, height: 22 }} />
                Cadastrar Usuário
              </Link>
            </>
          )}
          <Link to="/login" className="Home-link" style={{
            background: '#fff',
            border: '1.5px solid #d1d5db',
            color: '#444',
            fontWeight: 700,
            borderRadius: 12,
            padding: '18px 0',
            fontSize: 18,
            textAlign: 'center',
            textDecoration: 'none',
            boxShadow: '0 2px 8px rgba(9,21,255,0.04)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            transition: 'background 0.2s, color 0.2s'
          }}>
            <Users style={{ width: 22, height: 22 }} />
            Área Administrativa
          </Link>
        </div>
        <div style={{ color: '#888', fontSize: 15, textAlign: 'center', marginTop: 12 }}>
          <Shield style={{ width: 18, height: 18, color: '#0915FF', marginRight: 6, verticalAlign: 'middle' }} />
          Acesso seguro e controle de permissões para administradores
        </div>
      </div>
    </div>
  );
};

export default Home; 