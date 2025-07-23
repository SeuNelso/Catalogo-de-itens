import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ChevronDown, Settings, Database, Users, FileText, Download, Plus, Trash2 } from 'react-feather';
import './NavbarCustom.css';

const Navbar = () => {
  const { isAuthenticated, logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
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

  // Fechar menu mobile quando clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (mobileOpen && !event.target.closest('.navbar-digi')) {
        setMobileOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mobileOpen]);

  // Fechar menu mobile ao navegar
  const handleNavigation = () => {
    setMobileOpen(false);
  };

  return (
    <header className="w-full bg-[#0915FF] text-white shadow-md fixed top-0 left-0 z-50">
      <div className="max-w-7xl mx-auto flex items-center justify-between h-14 px-4">
        <div className="font-extrabold text-xl tracking-widest select-none">CATÁLOGO</div>
        {/* Desktop Menu */}
        <nav className="hidden md:flex items-center gap-6 flex-1 justify-center">
          <Link to="/" className="font-semibold uppercase tracking-wide hover:text-yellow-400 transition">Início</Link>
          {isAuthenticated && (
            <Link to="/listar" className="font-semibold uppercase tracking-wide hover:text-yellow-400 transition">Catálogo</Link>
          )}
          {isAdmin && (
            <div className="relative group">
              <button className="flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-yellow-400 transition focus:outline-none">
                <Settings size={16} /> Gerir <ChevronDown size={16} className="transition-transform group-hover:rotate-180" />
              </button>
              <div className="absolute left-0 mt-2 bg-white text-[#0915FF] rounded-lg shadow-lg py-2 px-2 min-w-[180px] opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition z-50">
                <Link to="/cadastrar" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><Plus size={16}/>Criar Artigo</Link>
                <Link to="/excluir-artigo" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><Trash2 size={16}/>Excluir Artigo</Link>
                <Link to="/admin-usuarios" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><Users size={16}/>Usuários</Link>
              </div>
            </div>
          )}
          {isAuthenticated && (
            <div className="relative group">
              <button className="flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-yellow-400 transition focus:outline-none">
                <Database size={16} /> Dados <ChevronDown size={16} className="transition-transform group-hover:rotate-180" />
              </button>
              <div className="absolute left-0 mt-2 bg-white text-[#0915FF] rounded-lg shadow-lg py-2 px-2 min-w-[200px] opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition z-50">
                {isAdmin && <Link to="/importar-itens" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><FileText size={16}/>Importar Itens</Link>}
                {isController && <Link to="/importar-stock-nacional" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><FileText size={16}/>Importar Stock</Link>}
                {(isAdmin || isController) && <Link to="/importar-dados-itens" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><FileText size={16}/>Importar Dados</Link>}
                <Link to="/exportar" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium"><Download size={16}/>Exportar Dados</Link>
              </div>
            </div>
          )}
        </nav>
        {/* Usuário Desktop */}
        <div className="hidden md:flex items-center gap-4">
          {isAuthenticated ? (
            <>
              <span className="font-semibold text-base">{user?.nome || user?.username}</span>
              <button className="bg-white text-[#0915FF] font-bold rounded px-5 py-2 shadow hover:bg-[#e8edff] transition" onClick={handleLogout}>SAIR</button>
            </>
          ) : (
            <Link to="/login" className="bg-white text-[#0915FF] font-bold rounded px-5 py-2 shadow hover:bg-[#e8edff] transition">ENTRAR</Link>
          )}
        </div>
        {/* Botão Hamburguer Mobile */}
        <button className="md:hidden flex flex-col justify-center items-center w-10 h-10 rounded hover:bg-white/10 transition ml-2" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Abrir menu">
          <span className={`block w-7 h-1 bg-white rounded transition-all duration-300 ${mobileOpen ? 'rotate-45 translate-y-2' : ''}`}></span>
          <span className={`block w-7 h-1 bg-white rounded my-1 transition-all duration-300 ${mobileOpen ? 'opacity-0' : ''}`}></span>
          <span className={`block w-7 h-1 bg-white rounded transition-all duration-300 ${mobileOpen ? '-rotate-45 -translate-y-2' : ''}`}></span>
        </button>
      </div>
      {/* Menu Mobile */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 bg-[#0915FF]/95 z-40 flex flex-col pt-20 px-6 gap-6 animate-fade-in">
          <Link to="/" className="font-semibold uppercase tracking-wide text-lg hover:text-yellow-400 transition" onClick={handleNavigation}>Início</Link>
          {isAuthenticated && <Link to="/listar" className="font-semibold uppercase tracking-wide text-lg hover:text-yellow-400 transition" onClick={handleNavigation}>Catálogo</Link>}
          {isAdmin && (
            <div className="flex flex-col gap-1">
              <span className="font-bold text-base mb-1">Gerir</span>
              <Link to="/cadastrar" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><Plus size={16}/>Criar Artigo</Link>
              <Link to="/excluir-artigo" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><Trash2 size={16}/>Excluir Artigo</Link>
              <Link to="/admin-usuarios" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><Users size={16}/>Usuários</Link>
            </div>
          )}
          {isAuthenticated && (
            <div className="flex flex-col gap-1">
              <span className="font-bold text-base mb-1">Dados</span>
              {isAdmin && <Link to="/importar-itens" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><FileText size={16}/>Importar Itens</Link>}
              {isController && <Link to="/importar-stock-nacional" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><FileText size={16}/>Importar Stock</Link>}
              {(isAdmin || isController) && <Link to="/importar-dados-itens" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><FileText size={16}/>Importar Dados</Link>}
              <Link to="/exportar" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-[#e8edff] font-medium" onClick={handleNavigation}><Download size={16}/>Exportar Dados</Link>
            </div>
          )}
          <div className="flex flex-col gap-2 mt-6">
            {isAuthenticated ? (
              <>
                <span className="font-semibold text-base">{user?.nome || user?.username}</span>
                <button className="bg-white text-[#0915FF] font-bold rounded px-5 py-2 shadow hover:bg-[#e8edff] transition" onClick={handleLogout}>SAIR</button>
              </>
            ) : (
              <Link to="/login" className="bg-white text-[#0915FF] font-bold rounded px-5 py-2 shadow hover:bg-[#e8edff] transition">ENTRAR</Link>
            )}
          </div>
        </div>
      )}
    </header>
  );
};

export default Navbar; 