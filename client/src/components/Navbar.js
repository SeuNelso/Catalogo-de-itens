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
            <div key={item.label} className="navbar-digi-menu-item">
              <Link to={item.path}>{item.label}</Link>
            </div>
          ))}
          {isAuthenticated && (
            <div className="navbar-digi-menu-item">
              <Link to="/cadastrar">CRIAR ARTIGO</Link>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/excluir-artigo">EXCLUIR ARTIGO</Link>
            </div>
          )}
          {isAuthenticated && user && user.role === 'admin' && (
            <div className="navbar-digi-menu-item">
              <Link to="/importar-excel">IMPORTAR EXCEL</Link>
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
        <button className="navbar-digi-mobile-toggle" onClick={() => setMobileOpen(!mobileOpen)}>
          <span className="navbar-digi-mobile-bar"></span>
          <span className="navbar-digi-mobile-bar"></span>
          <span className="navbar-digi-mobile-bar"></span>
        </button>
      </div>
    </header>
  );
};

export default Navbar; 