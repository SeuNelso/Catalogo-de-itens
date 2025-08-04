import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ChevronDown, Settings, Database, Users, FileText, Download, Plus, Trash2, Image, RefreshCw } from 'react-feather';
import './NavbarCustom.css';

const Navbar = () => {
  const { isAuthenticated, logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [gerirOpen, setGerirOpen] = useState(false);
  const [dadosOpen, setDadosOpen] = useState(false);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isAdmin = user && user.role === 'admin';
  const isController = user && (user.role === 'admin' || user.role === 'controller');

  // Debug logs
  console.log('Navbar - User:', user);
  console.log('Navbar - isAdmin:', isAdmin);
  console.log('Navbar - isController:', isController);
  console.log('Navbar - User role:', user?.role);

  // Fechar menus quando clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (mobileOpen && !event.target.closest('.navbar-digi')) {
        setMobileOpen(false);
      }
      if (gerirOpen && !event.target.closest('.gerir-dropdown')) {
        setGerirOpen(false);
      }
      if (dadosOpen && !event.target.closest('.dados-dropdown')) {
        setDadosOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [mobileOpen, gerirOpen, dadosOpen]);

  // Fechar menu mobile ao navegar
  const handleNavigation = () => {
    setMobileOpen(false);
  };

  return (
    <header className="navbar-digi">
      <div className="navbar-digi-content">
        <div className="navbar-digi-logo">CATÁLOGO</div>
        
        {/* Desktop Menu */}
        <nav className="navbar-digi-menu desktop-only">
          <div className="navbar-digi-menu-item">
            <Link to="/">Início</Link>
          </div>
          {isAuthenticated && (
            <div className="navbar-digi-menu-item">
              <Link to="/listar">Catálogo</Link>
            </div>
          )}
          {isAdmin && (
            <div className="navbar-digi-dropdown">
              <button 
                className="navbar-digi-dropdown-toggle"
                onClick={() => setGerirOpen(!gerirOpen)}
              >
                <Settings size={16} />
                Gerir
                <ChevronDown size={16} className={`navbar-digi-chevron ${gerirOpen ? 'rotate-180' : ''}`} />
              </button>
              {gerirOpen && (
                <div className="navbar-digi-dropdown-menu">
                  <Link to="/cadastrar" onClick={() => setGerirOpen(false)}><Plus size={16}/>Criar Artigo</Link>
                  <Link to="/excluir-artigo" onClick={() => setGerirOpen(false)}><Trash2 size={16}/>Excluir Artigo</Link>
                  <Link to="/admin-usuarios" onClick={() => setGerirOpen(false)}><Users size={16}/>Usuários</Link>
                </div>
              )}
            </div>
          )}
          {isAuthenticated && (
            <div className="navbar-digi-dropdown">
              <button 
                className="navbar-digi-dropdown-toggle"
                onClick={() => setDadosOpen(!dadosOpen)}
              >
                <Database size={16} />
                Dados
                <ChevronDown size={16} className={`navbar-digi-chevron ${dadosOpen ? 'rotate-180' : ''}`} />
              </button>
              {dadosOpen && (
                <div className="navbar-digi-dropdown-menu">
                  {isAdmin && <Link to="/importar-itens" onClick={() => setDadosOpen(false)}><FileText size={16}/>Importar Itens</Link>}
                  {isController && <Link to="/importar-stock-nacional" onClick={() => setDadosOpen(false)}><FileText size={16}/>Importar Stock</Link>}
                  {(isAdmin || isController) && <Link to="/importar-dados-itens" onClick={() => setDadosOpen(false)}><FileText size={16}/>Importar Dados</Link>}
                  {(isAdmin || isController) && <Link to="/importar-imagens-automaticas" onClick={() => setDadosOpen(false)}><Image size={16}/>Importar Imagens</Link>}
                  {(isAdmin || isController) && <Link to="/detectar-imagens-automaticas" onClick={() => setDadosOpen(false)}><RefreshCw size={16}/>Detecção Automática</Link>}
                  <Link to="/exportar" onClick={() => setDadosOpen(false)}><Download size={16}/>Exportar Dados</Link>
                </div>
              )}
            </div>
          )}
        </nav>
        
        {/* Usuário Desktop */}
        <div className="navbar-digi-user desktop-only">
          {isAuthenticated ? (
            <>
              <span className="navbar-digi-username">{user?.nome || user?.username}</span>
              <button className="navbar-digi-logout" onClick={handleLogout}>SAIR</button>
            </>
          ) : (
            <Link to="/login" className="navbar-digi-logout">ENTRAR</Link>
          )}
        </div>
        
        {/* Botão Hamburguer Mobile */}
        <button 
          className="navbar-digi-mobile-toggle mobile-only" 
          onClick={() => setMobileOpen(!mobileOpen)} 
          aria-label="Abrir menu"
        >
          <span className={`navbar-digi-mobile-bar ${mobileOpen ? 'rotate-45 translate-y-2' : ''}`}></span>
          <span className={`navbar-digi-mobile-bar ${mobileOpen ? 'opacity-0' : ''}`}></span>
          <span className={`navbar-digi-mobile-bar ${mobileOpen ? '-rotate-45 -translate-y-2' : ''}`}></span>
        </button>
      </div>
      
      {/* Menu Mobile */}
      <nav className={`navbar-digi-menu mobile-only ${mobileOpen ? 'open' : ''}`}>
        <div className="navbar-digi-menu-item">
          <Link to="/" onClick={handleNavigation}>Início</Link>
        </div>
        {isAuthenticated && (
          <div className="navbar-digi-menu-item">
            <Link to="/listar" onClick={handleNavigation}>Catálogo</Link>
          </div>
        )}
        {isAdmin && (
          <div className="navbar-digi-dropdown">
            <button 
              className="navbar-digi-dropdown-toggle"
              onClick={() => setGerirOpen(!gerirOpen)}
            >
              <Settings size={16} />
              Gerir
              <ChevronDown size={16} className={`navbar-digi-chevron ${gerirOpen ? 'rotate-180' : ''}`} />
            </button>
            {gerirOpen && (
              <div className="navbar-digi-dropdown-menu">
                <Link to="/cadastrar" onClick={handleNavigation}><Plus size={16}/>Criar Artigo</Link>
                <Link to="/excluir-artigo" onClick={handleNavigation}><Trash2 size={16}/>Excluir Artigo</Link>
                <Link to="/admin-usuarios" onClick={handleNavigation}><Users size={16}/>Usuários</Link>
              </div>
            )}
          </div>
        )}
        {isAuthenticated && (
          <div className="navbar-digi-dropdown">
            <button 
              className="navbar-digi-dropdown-toggle"
              onClick={() => setDadosOpen(!dadosOpen)}
            >
              <Database size={16} />
              Dados
              <ChevronDown size={16} className={`navbar-digi-chevron ${dadosOpen ? 'rotate-180' : ''}`} />
            </button>
            {dadosOpen && (
              <div className="navbar-digi-dropdown-menu">
                {isAdmin && <Link to="/importar-itens" onClick={handleNavigation}><FileText size={16}/>Importar Itens</Link>}
                {isController && <Link to="/importar-stock-nacional" onClick={handleNavigation}><FileText size={16}/>Importar Stock</Link>}
                {(isAdmin || isController) && <Link to="/importar-dados-itens" onClick={handleNavigation}><FileText size={16}/>Importar Dados</Link>}
                {(isAdmin || isController) && <Link to="/importar-imagens-automaticas" onClick={handleNavigation}><Image size={16}/>Importar Imagens</Link>}
                {(isAdmin || isController) && <Link to="/detectar-imagens-automaticas" onClick={handleNavigation}><RefreshCw size={16}/>Detecção Automática</Link>}
                <Link to="/exportar" onClick={handleNavigation}><Download size={16}/>Exportar Dados</Link>
              </div>
            )}
          </div>
        )}
        <div className="navbar-digi-user">
          {isAuthenticated ? (
            <>
              <span className="navbar-digi-username">{user?.nome || user?.username}</span>
              <button className="navbar-digi-logout" onClick={handleLogout}>SAIR</button>
            </>
          ) : (
            <Link to="/login" className="navbar-digi-logout">ENTRAR</Link>
          )}
        </div>
      </nav>
    </header>
  );
};

export default Navbar; 