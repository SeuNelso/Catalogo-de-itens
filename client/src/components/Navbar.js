import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './NavbarCustom.css';

const menuItems = [
  { label: 'INÍCIO', path: '/' },
  { label: 'CATÁLOGO', path: '/listar' },
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
        <nav className={`navbar-digi-menu ${mobileOpen ? 'open' : ''}`}>
          {menuItems.map((item) => (
            <div
              key={item.label}
              className="navbar-digi-menu-item"
              tabIndex={0}
              role="button"
              onClick={() => navigate(item.path)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') navigate(item.path); }}
              style={{ cursor: 'pointer' }}
            >
              <span style={{ width: '100%', textAlign: 'center' }}>{item.label}</span>
            </div>
          ))}
          {isAuthenticated && (
            <div className="navbar-digi-menu-item">
              <Link to="/cadastrar">CRIAR ARTIGO</Link>
            </div>
          )}
          {isAuthenticated && user && (user.role === 'admin' || user.role === 'controller') && (
            <div className="navbar-digi-menu-item">
              <Link to="/excluir-artigo">EXCLUIR ARTIGO</Link>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/importar-excel">IMPORTAR EXCEL</Link>
            </div>
          )}
          {isAuthenticated && user && (user.role === 'admin' || user.role === 'controller') && (
            <div
              className="navbar-digi-menu-item"
              tabIndex={0}
              role="button"
              onClick={() => navigate('/importar-stock-nacional')}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') navigate('/importar-stock-nacional'); }}
              style={{ cursor: 'pointer' }}
            >
              <span style={{ width: '100%', textAlign: 'center' }}>IMPORTAR STOCK NACIONAL</span>
            </div>
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