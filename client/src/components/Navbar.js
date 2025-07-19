import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './NavbarCustom.css';

const menuItems = [
  { label: 'INÍCIO', path: '/' },
  // { label: 'CATÁLOGO', path: '/listar' }, // Removido daqui
  // { label: 'RECONHECER', path: '/reconhecimento' }, // Removido
];

const Navbar = () => {
  const { isAuthenticated, logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="navbar-digi">
      <div className="navbar-digi-content">
        <div className="navbar-digi-logo">DIGI</div>
        <nav className={`navbar-digi-menu ${mobileOpen ? 'open' : ''}`} style={{ overflowX: 'auto', whiteSpace: 'nowrap', maxWidth: '100vw' }}>
          {menuItems.map((item) => (
            <div
              key={item.label}
              className="navbar-digi-menu-item"
              tabIndex={0}
              role="button"
              onClick={() => {
                navigate(item.path);
                setMobileOpen(false);
              }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { navigate(item.path); setMobileOpen(false); } }}
              style={{ cursor: 'pointer' }}
            >
              <span style={{ width: '100%', textAlign: 'center' }}>{item.label}</span>
            </div>
          ))}
          {/* Renderiza o botão CATÁLOGO apenas se autenticado */}
          {isAuthenticated && (
            <div
              className="navbar-digi-menu-item"
              tabIndex={0}
              role="button"
              onClick={() => {
                navigate('/listar');
                setMobileOpen(false);
              }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { navigate('/listar'); setMobileOpen(false); } }}
              style={{ cursor: 'pointer' }}
            >
              <span style={{ width: '100%', textAlign: 'center' }}>CATÁLOGO</span>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/cadastrar" onClick={() => setMobileOpen(false)}>CRIAR ARTIGO</Link>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/excluir-artigo" onClick={() => setMobileOpen(false)}>EXCLUIR ARTIGO</Link>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/importar-itens" onClick={() => setMobileOpen(false)}>IMPORTAR ITENS</Link>
            </div>
          )}
          {isAuthenticated && user && (user.role === 'admin' || user.role === 'controller') && (
            <div
              className="navbar-digi-menu-item"
              tabIndex={0}
              role="button"
              onClick={() => {
                navigate('/importar-stock-nacional');
                setMobileOpen(false);
              }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { navigate('/importar-stock-nacional'); setMobileOpen(false); } }}
              style={{ cursor: 'pointer' }}
            >
              <span style={{ width: '100%', textAlign: 'center' }}>IMPORTAR STOCK NACIONAL</span>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/admin-usuarios" onClick={() => setMobileOpen(false)}>USUÁRIOS</Link>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/exportar" onClick={() => setMobileOpen(false)}>EXPORTAR DADOS</Link>
            </div>
          )}
          {isAuthenticated && mobileOpen && (
            null
          )}
        </nav>
        {isAuthenticated ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#fff', fontWeight: 600, fontSize: 16 }}>
              {user?.nome || user?.username}
            </span>
            <button className="navbar-digi-logout" onClick={handleLogout}>SAIR</button>
          </div>
        ) : (
          <Link to="/login" className="navbar-digi-logout">ENTRAR</Link>
        )}
        <button className="navbar-digi-mobile-toggle" aria-label="Abrir menu" tabIndex={0} onClick={() => setMobileOpen(!mobileOpen)}>
          <span className="navbar-digi-mobile-bar"></span>
          <span className="navbar-digi-mobile-bar"></span>
          <span className="navbar-digi-mobile-bar"></span>
        </button>
      </div>
    </header>
  );
};

export default Navbar; 