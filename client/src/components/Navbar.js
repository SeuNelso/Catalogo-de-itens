import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ChevronDown, Settings, Database, Users, FileText, Download, Plus, Trash2 } from 'react-feather';
import './NavbarCustom.css';

const Navbar = () => {
  const { isAuthenticated, logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [gerirMenuOpen, setGerirMenuOpen] = useState(false);
  const [dadosMenuOpen, setDadosMenuOpen] = useState(false);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isAdmin = user && user.role === 'admin';
  const isController = user && (user.role === 'admin' || user.role === 'controller');

  // Fechar menu mobile quando clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (mobileOpen && !event.target.closest('.navbar-digi')) {
        setMobileOpen(false);
        setGerirMenuOpen(false);
        setDadosMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mobileOpen]);

  // Fechar menu mobile ao navegar
  const handleNavigation = () => {
    setMobileOpen(false);
    setGerirMenuOpen(false);
    setDadosMenuOpen(false);
  };

  return (
    <header className="navbar-digi">
      <div className="navbar-digi-content">
        <div className="navbar-digi-logo">DIGI</div>
        
        <nav className={`navbar-digi-menu ${mobileOpen ? 'open' : ''}`}>
          {/* Menu Principal */}
          <div className="navbar-digi-menu-item">
            <Link to="/" onClick={handleNavigation}>INÍCIO</Link>
          </div>
          
          {isAuthenticated && (
            <div className="navbar-digi-menu-item">
              <Link to="/listar" onClick={handleNavigation}>CATÁLOGO</Link>
            </div>
          )}

          {/* Menu Administrativo Dropdown */}
          {isAdmin && (
            <div className={`navbar-digi-dropdown ${gerirMenuOpen ? 'open' : ''}`}>
              <button 
                className="navbar-digi-dropdown-toggle"
                onClick={() => setGerirMenuOpen(!gerirMenuOpen)}
                onBlur={() => setTimeout(() => setGerirMenuOpen(false), 200)}
              >
                <Settings size={16} />
                <span>GERIR</span>
                <ChevronDown size={16} style={{ transform: gerirMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
              </button>
              
              {gerirMenuOpen && (
                <div className="navbar-digi-dropdown-menu">
                  <Link to="/cadastrar" onClick={handleNavigation}>
                    <Plus size={16} />
                    Criar Artigo
                  </Link>
                  <Link to="/excluir-artigo" onClick={handleNavigation}>
                    <Trash2 size={16} />
                    Excluir Artigo
                  </Link>
                  <Link to="/admin-usuarios" onClick={handleNavigation}>
                    <Users size={16} />
                    Usuários
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* Menu Importação/Exportação */}
          {isAuthenticated && (
            <div className={`navbar-digi-dropdown ${dadosMenuOpen ? 'open' : ''}`}>
              <button 
                className="navbar-digi-dropdown-toggle"
                onClick={() => setDadosMenuOpen(!dadosMenuOpen)}
                onBlur={() => setTimeout(() => setDadosMenuOpen(false), 200)}
              >
                <Database size={16} />
                <span>DADOS</span>
                <ChevronDown size={16} style={{ transform: dadosMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
              </button>
              
              {dadosMenuOpen && (
                <div className="navbar-digi-dropdown-menu">
                  {isAdmin && (
                    <Link to="/importar-itens" onClick={handleNavigation}>
                      <FileText size={16} />
                      Importar Itens
                    </Link>
                  )}
                  {isController && (
                    <Link to="/importar-stock-nacional" onClick={handleNavigation}>
                      <FileText size={16} />
                      Importar Stock
                    </Link>
                  )}
                  <Link to="/exportar" onClick={handleNavigation}>
                    <Download size={16} />
                    Exportar Dados
                  </Link>
                </div>
              )}
            </div>
          )}
          
          {/* Área do Usuário no Menu Mobile */}
          {isAuthenticated && (
            <div className="navbar-digi-user">
              <span className="navbar-digi-username">
                {user?.nome || user?.username}
              </span>
              <button className="navbar-digi-logout" onClick={handleLogout}>SAIR</button>
            </div>
          )}
        </nav>

        {/* Área do Usuário no Desktop */}
        {isAuthenticated ? (
          <div className="navbar-digi-user desktop-only">
            <span className="navbar-digi-username">
              {user?.nome || user?.username}
            </span>
            <button className="navbar-digi-logout" onClick={handleLogout}>SAIR</button>
          </div>
        ) : (
          <Link to="/login" className="navbar-digi-logout desktop-only">ENTRAR</Link>
        )}

        {/* Botão Mobile */}
        <button 
          className={`navbar-digi-mobile-toggle ${mobileOpen ? 'open' : ''}`}
          aria-label="Abrir menu" 
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <span className="navbar-digi-mobile-bar"></span>
          <span className="navbar-digi-mobile-bar"></span>
          <span className="navbar-digi-mobile-bar"></span>
        </button>
      </div>
    </header>
  );
};

export default Navbar; 