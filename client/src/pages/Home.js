import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Database, Search, Shield, UserPlus } from 'react-feather';
import { useAuth } from '../contexts/AuthContext';

const Home = () => {
  const { isAuthenticated } = useAuth();
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-6 px-4 sm:py-12 sm:px-4">
      <div className="Home-card" style={{
        background: '#fff',
        borderRadius: isMobile ? 16 : 20,
        boxShadow: '0 8px 32px rgba(9,21,255,0.08)',
        border: '1.5px solid #d1d5db',
        maxWidth: isMobile ? '100%' : 540,
        width: '100%',
        padding: isMobile ? 24 : 40,
        margin: isMobile ? '20px 0' : '40px 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: isMobile ? 24 : 32
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: isMobile ? 8 : 12 }}>
          <div style={{ 
            background: '#0915FF', 
            borderRadius: '50%', 
            padding: isMobile ? 12 : 16, 
            marginBottom: isMobile ? 4 : 8 
          }}>
            <Database style={{ 
              color: '#fff', 
              width: isMobile ? 32 : 40, 
              height: isMobile ? 32 : 40 
            }} />
          </div>
          <h1 className="Home-title" style={{ 
            color: '#0915FF', 
            fontWeight: 800, 
            fontSize: isMobile ? 24 : 32, 
            textAlign: 'center', 
            margin: 0,
            lineHeight: 1.2
          }}>
            Catálogo Inteligente
          </h1>
          <p className="Home-desc" style={{ 
            color: '#444', 
            fontSize: isMobile ? 16 : 18, 
            textAlign: 'center', 
            margin: 0, 
            maxWidth: 400,
            lineHeight: 1.5
          }}>
            Sistema moderno para catalogação, identificação visual e gestão de itens.
          </p>
        </div>
        
        <div style={{ 
          width: '100%', 
          display: 'flex', 
          flexDirection: 'column', 
          gap: isMobile ? 16 : 20 
        }}>
          {!isAuthenticated && (
            <>
              <Link to="/login" className="Home-link" style={{
                background: '#0915FF',
                border: '1.5px solid #0915FF',
                color: '#fff',
                fontWeight: 700,
                borderRadius: isMobile ? 10 : 12,
                padding: isMobile ? '14px 0' : '18px 0',
                fontSize: isMobile ? 16 : 18,
                textAlign: 'center',
                textDecoration: 'none',
                boxShadow: '0 4px 12px rgba(9,21,255,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                transition: 'all 0.2s ease',
                width: '100%',
                minHeight: isMobile ? 48 : 56
              }}>
                <Shield style={{ width: isMobile ? 20 : 22, height: isMobile ? 20 : 22 }} />
                Login
              </Link>
              
              <Link to="/cadastro" className="Home-link" style={{
                background: '#fff',
                border: '1.5px solid #22c55e',
                color: '#22c55e',
                fontWeight: 700,
                borderRadius: isMobile ? 10 : 12,
                padding: isMobile ? '14px 0' : '18px 0',
                fontSize: isMobile ? 16 : 18,
                textAlign: 'center',
                textDecoration: 'none',
                boxShadow: '0 2px 8px rgba(34,197,94,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                transition: 'all 0.2s ease',
                width: '100%',
                minHeight: isMobile ? 48 : 56
              }}>
                <UserPlus style={{ width: isMobile ? 20 : 22, height: isMobile ? 20 : 22 }} />
                Criar Conta
              </Link>
            </>
          )}
          {isAuthenticated && (
            <Link to="/listar" className="Home-link" style={{
              background: '#fff',
              border: '1.5px solid #0915FF',
              color: '#0915FF',
              fontWeight: 700,
              borderRadius: isMobile ? 10 : 12,
              padding: isMobile ? '14px 0' : '18px 0',
              fontSize: isMobile ? 16 : 18,
              textAlign: 'center',
              textDecoration: 'none',
              boxShadow: '0 2px 8px rgba(9,21,255,0.06)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              transition: 'all 0.2s ease',
              minHeight: isMobile ? 48 : 56
            }}>
              <Search style={{ width: isMobile ? 20 : 22, height: isMobile ? 20 : 22 }} />
              Consultar Catálogo
            </Link>
          )}
        </div>
        
        <div style={{ 
          color: '#888', 
          fontSize: isMobile ? 13 : 15, 
          textAlign: 'center', 
          marginTop: isMobile ? 8 : 12,
          lineHeight: 1.4,
          padding: isMobile ? '0 8px' : 0
        }}>
          <Shield style={{ 
            width: isMobile ? 16 : 18, 
            height: isMobile ? 16 : 18, 
            color: '#0915FF', 
            marginRight: 6, 
            verticalAlign: 'middle' 
          }} />
          Acesso seguro e controle de permissões para administradores
        </div>
      </div>
    </div>
  );
};

export default Home; 