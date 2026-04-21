import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ChevronDown, Settings, Database, Users, User, FileText, Download, Plus, Trash2, Image, RefreshCw, Menu, X, AlertTriangle, Package, ShoppingCart, Archive, RotateCcw, Truck, MapPin, Share2 } from 'react-feather';
import { podeAcederInventario, podeAcederRequisicoes } from '../utils/roles';
import { podeUsarConsultaMovimentos, podeUsarControloStock } from '../utils/controloStock';

const Navbar = () => {
  const { isAuthenticated, logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [gerirOpen, setGerirOpen] = useState(false);
  const [dadosOpen, setDadosOpen] = useState(false);
  const [clogOpen, setClogOpen] = useState(false);
  const [consultaOpen, setConsultaOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const closeAllDropdowns = () => {
    setGerirOpen(false);
    setDadosOpen(false);
    setClogOpen(false);
    setConsultaOpen(false);
    setUserMenuOpen(false);
  };

  const toggleDropdown = (menu) => {
    setGerirOpen((prev) => (menu === 'gerir' ? !prev : false));
    setDadosOpen((prev) => (menu === 'dados' ? !prev : false));
    setClogOpen((prev) => (menu === 'clog' ? !prev : false));
    setConsultaOpen((prev) => (menu === 'consulta' ? !prev : false));
    setUserMenuOpen((prev) => (menu === 'user' ? !prev : false));
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isAdmin = user && user.role === 'admin';
  const isController = user && (user.role === 'admin' || user.role === 'controller');
  const canSeeDashboardCliente = user && user.role === 'analista';
  const canSeeRequisicoes = user && podeAcederRequisicoes(user.role);
  const isArmazemLogistica = user && ['backoffice_armazem', 'supervisor_armazem'].includes(user.role);
  /** Admin: menu completo; backoffice/supervisor armazém: secção Armazém (links não ficam só dentro do bloco admin) */
  const showGerirMenu = isAdmin || isArmazemLogistica;
  /** Conta autenticada que não é admin: acede a /admin-usuarios só para o próprio perfil */
  const showMeuPerfil = isAuthenticated && !isAdmin;
  const podeStockMenu = user && podeUsarControloStock(user);
  const canSeeConsultaLocalizacoes = Boolean(podeStockMenu);
  const canSeeConsultaMenu =
    user &&
    (isAdmin || podeStockMenu || ['supervisor_armazem', 'backoffice_armazem', 'operador'].includes(user.role));
  const podeMovimentosMenu = user && podeUsarConsultaMovimentos(user);
  const podeInventarioMenu = user && podeAcederInventario(user.role) && podeUsarControloStock(user);
  const podeContagemSemanalMenu = user && podeAcederInventario(user.role);
  const canSeeClogMenu = Boolean(canSeeRequisicoes || podeContagemSemanalMenu || podeMovimentosMenu || podeStockMenu);
  const normalizeName = (v) =>
    String(v || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  const nome = String(user?.nome || '').trim();
  const sobrenome = String(user?.sobrenome || '').trim();
  const nomeNormalizado = normalizeName(nome);
  const sobrenomeNormalizado = normalizeName(sobrenome);
  const nomeCompleto =
    nome && sobrenome && nomeNormalizado.includes(sobrenomeNormalizado)
      ? nome
      : [nome, sobrenome].filter(Boolean).join(' ').trim();
  const displayName = nomeCompleto || user?.username || user?.email || '';

  // Fechar menu mobile ao navegar
  const handleNavigation = () => {
    setMobileOpen(false);
    closeAllDropdowns();
  };

  // Função específica para navegação mobile
  const handleMobileNavigation = (path, event) => {
    // Feedback visual - adicionar classe de loading temporariamente
    const button = event?.target?.closest('button');
    if (button) {
      button.style.backgroundColor = 'rgba(255, 255, 255, 0.3)';
      button.style.transform = 'scale(0.98)';
    }
    
    // Fechar menus primeiro
    setMobileOpen(false);
    closeAllDropdowns();
    
    // Navegar após um pequeno delay
    setTimeout(() => {
      navigate(path);
    }, 150);
  };



  // Fechar dropdowns quando clica fora deles
  useEffect(() => {
    const handleClickOutside = (event) => {
      const gerirDropdown = document.querySelector('.gerir-dropdown');
      const dadosDropdown = document.querySelector('.dados-dropdown');
      const clogDropdown = document.querySelector('.clog-dropdown');
      const consultaDropdown = document.querySelector('.consulta-dropdown');
      if (userMenuOpen) {
        const userDropDesk = document.querySelector('.user-menu-dropdown-desktop');
        const userDropMob = document.querySelector('.user-menu-dropdown-mobile');
        const insideUser =
          (userDropDesk && userDropDesk.contains(event.target)) ||
          (userDropMob && userDropMob.contains(event.target));
        if (!insideUser) {
          setTimeout(() => {
            setUserMenuOpen(false);
          }, 100);
        }
      }

      if (gerirOpen && gerirDropdown && !gerirDropdown.contains(event.target)) {
        setTimeout(() => {
          setGerirOpen(false);
        }, 100);
      }
      
      if (dadosOpen && dadosDropdown && !dadosDropdown.contains(event.target)) {
        setTimeout(() => {
          setDadosOpen(false);
        }, 100);
      }

      if (clogOpen && clogDropdown && !clogDropdown.contains(event.target)) {
        setTimeout(() => {
          setClogOpen(false);
        }, 100);
      }

      if (consultaOpen && consultaDropdown && !consultaDropdown.contains(event.target)) {
        setTimeout(() => {
          setConsultaOpen(false);
        }, 100);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [gerirOpen, dadosOpen, clogOpen, consultaOpen, userMenuOpen]);

  // Fechar dropdowns quando o mouse sai deles (com delay)
  useEffect(() => {
    let gerirTimeout;
    let dadosTimeout;
    let clogTimeout;
    let consultaTimeout;

    const handleMouseLeave = (event) => {
      const gerirDropdown = document.querySelector('.gerir-dropdown');
      const dadosDropdown = document.querySelector('.dados-dropdown');
      const clogDropdown = document.querySelector('.clog-dropdown');
      const consultaDropdown = document.querySelector('.consulta-dropdown');
      
      // Não fechar se o usuário está interagindo
      if (isInteracting) return;
      
      // Verificar se o mouse realmente saiu do dropdown
      if (gerirOpen && gerirDropdown && !gerirDropdown.contains(event.relatedTarget)) {
        gerirTimeout = setTimeout(() => {
          if (!isInteracting) {
            setGerirOpen(false);
          }
        }, 300); // Aumentado para 300ms delay
      }
      
      if (dadosOpen && dadosDropdown && !dadosDropdown.contains(event.relatedTarget)) {
        dadosTimeout = setTimeout(() => {
          if (!isInteracting) {
            setDadosOpen(false);
          }
        }, 300); // Aumentado para 300ms delay
      }

      if (clogOpen && clogDropdown && !clogDropdown.contains(event.relatedTarget)) {
        clogTimeout = setTimeout(() => {
          if (!isInteracting) {
            setClogOpen(false);
          }
        }, 300);
      }

      if (consultaOpen && consultaDropdown && !consultaDropdown.contains(event.relatedTarget)) {
        consultaTimeout = setTimeout(() => {
          if (!isInteracting) {
            setConsultaOpen(false);
          }
        }, 300);
      }
    };

    const handleMouseEnter = () => {
      // Cancelar timeout se o mouse voltar
      if (gerirTimeout) {
        clearTimeout(gerirTimeout);
      }
      if (dadosTimeout) {
        clearTimeout(dadosTimeout);
      }
      if (clogTimeout) {
        clearTimeout(clogTimeout);
      }
      if (consultaTimeout) {
        clearTimeout(consultaTimeout);
      }
    };

    const gerirDropdown = document.querySelector('.gerir-dropdown');
    const dadosDropdown = document.querySelector('.dados-dropdown');
    const clogDropdown = document.querySelector('.clog-dropdown');
    const consultaDropdown = document.querySelector('.consulta-dropdown');
    
    if (gerirDropdown) {
      gerirDropdown.addEventListener('mouseleave', handleMouseLeave);
      gerirDropdown.addEventListener('mouseenter', handleMouseEnter);
    }
    
    if (dadosDropdown) {
      dadosDropdown.addEventListener('mouseleave', handleMouseLeave);
      dadosDropdown.addEventListener('mouseenter', handleMouseEnter);
    }

    if (clogDropdown) {
      clogDropdown.addEventListener('mouseleave', handleMouseLeave);
      clogDropdown.addEventListener('mouseenter', handleMouseEnter);
    }
    if (consultaDropdown) {
      consultaDropdown.addEventListener('mouseleave', handleMouseLeave);
      consultaDropdown.addEventListener('mouseenter', handleMouseEnter);
    }

    return () => {
      if (gerirDropdown) {
        gerirDropdown.removeEventListener('mouseleave', handleMouseLeave);
        gerirDropdown.removeEventListener('mouseenter', handleMouseEnter);
      }
      if (dadosDropdown) {
        dadosDropdown.removeEventListener('mouseleave', handleMouseLeave);
        dadosDropdown.removeEventListener('mouseenter', handleMouseEnter);
      }
      if (clogDropdown) {
        clogDropdown.removeEventListener('mouseleave', handleMouseLeave);
        clogDropdown.removeEventListener('mouseenter', handleMouseEnter);
      }
      if (consultaDropdown) {
        consultaDropdown.removeEventListener('mouseleave', handleMouseLeave);
        consultaDropdown.removeEventListener('mouseenter', handleMouseEnter);
      }
      if (gerirTimeout) clearTimeout(gerirTimeout);
      if (dadosTimeout) clearTimeout(dadosTimeout);
      if (clogTimeout) clearTimeout(clogTimeout);
      if (consultaTimeout) clearTimeout(consultaTimeout);
    };
  }, [gerirOpen, dadosOpen, clogOpen, consultaOpen, isInteracting]);

  // Garantir UI limpa quando a rota muda.
  useEffect(() => {
    closeAllDropdowns();
  }, [location.pathname]);

  return (
    <header className="w-full bg-[#0915FF] text-white fixed top-0 left-0 z-50 shadow-lg h-14 flex items-center">
      <div className="w-full max-w-7xl mx-auto flex items-center justify-between h-14 px-4 sm:px-6">
        <div className="text-lg sm:text-xl md:text-2xl font-black tracking-wider text-white mr-2 sm:mr-4 md:mr-8 flex-shrink-0">Clog</div>
        
        {/* Desktop Menu - Visível apenas em telas médias e grandes */}
        <nav className="hidden md:flex items-center gap-2 lg:gap-4 xl:gap-6 flex-1 justify-center transition-all duration-200">
          <div className="relative font-medium text-sm lg:text-base uppercase tracking-wider text-white cursor-pointer flex items-center px-2 lg:px-3 xl:px-4 h-12 min-w-12 lg:min-w-14 xl:min-w-16 rounded-lg transition-all duration-200 hover:bg-white/10 hover:text-yellow-400">
            <Link to="/" className="text-inherit no-underline px-0.5 font-semibold w-full h-full flex items-center justify-center">
              Início
            </Link>
          </div>
          {isAuthenticated && (
            <>
              <div className="relative font-medium text-sm lg:text-base uppercase tracking-wider text-white cursor-pointer flex items-center px-2 lg:px-3 xl:px-4 h-12 min-w-12 lg:min-w-14 xl:min-w-16 rounded-lg transition-all duration-200 hover:bg-white/10 hover:text-yellow-400">
                <Link to="/listar" className="text-inherit no-underline px-0.5 font-semibold w-full h-full flex items-center justify-center">
                  Catálogo
                </Link>
              </div>
              {canSeeDashboardCliente && (
                <div className="relative font-medium text-sm lg:text-base uppercase tracking-wider text-white cursor-pointer flex items-center px-2 lg:px-3 xl:px-4 h-12 min-w-12 lg:min-w-14 xl:min-w-16 rounded-lg transition-all duration-200 hover:bg-white/10 hover:text-yellow-400">
                  <Link to="/dashboard-cliente-compostos" className="text-inherit no-underline px-0.5 font-semibold w-full h-full flex items-center justify-center">
                    Dashboard CLIENTE
                  </Link>
                </div>
              )}
              {canSeeClogMenu && (
                <div className="flex items-center gap-1 lg:gap-2">
                  <div
                    className="relative inline-block clog-dropdown"
                    onMouseEnter={() => setIsInteracting(true)}
                    onMouseLeave={() => setIsInteracting(false)}
                  >
                    <button
                      className="bg-transparent border-none text-white font-semibold text-sm lg:text-base py-3 px-2 lg:px-3 xl:px-4 cursor-pointer flex items-center gap-1 lg:gap-2 transition-colors duration-200 rounded-lg hover:bg-white/10"
                      onClick={() => toggleDropdown('clog')}
                    >
                      <Truck size={14} className="lg:w-4 lg:h-4" />
                      <span>Clog</span>
                      <ChevronDown size={14} className={`ml-1 text-white transition-transform duration-200 lg:w-4 lg:h-4 ${clogOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {clogOpen && (
                      <div className="absolute top-full left-0 bg-[#0915FF] border border-gray-200 rounded-lg shadow-lg min-w-48 lg:min-w-56 z-50 p-2 -mt-1 pt-2">
                        <div className="flex flex-col gap-1">
                          {canSeeRequisicoes && (
                            <Link
                              to="/requisicoes"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setClogOpen(false); setTimeout(() => navigate('/requisicoes'), 100); }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <ShoppingCart size={14} className="lg:w-4 lg:h-4" />
                              Requisições
                            </Link>
                          )}
                          {canSeeRequisicoes && (
                            <Link
                              to="/devolucoes"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setClogOpen(false); setTimeout(() => navigate('/devolucoes'), 100); }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <RotateCcw size={14} className="lg:w-4 lg:h-4" />
                              Devoluções
                            </Link>
                          )}
                          {canSeeRequisicoes && (
                            <Link
                              to="/transferencias"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setClogOpen(false); setTimeout(() => navigate('/transferencias'), 100); }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <Truck size={14} className="lg:w-4 lg:h-4" />
                              Transferências
                            </Link>
                          )}
                          {podeInventarioMenu && (
                            <Link
                              to="/inventario"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setClogOpen(false); setTimeout(() => navigate('/inventario'), 100); }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <FileText size={14} className="lg:w-4 lg:h-4" />
                              Inventário
                            </Link>
                          )}
                          {podeContagemSemanalMenu && (
                            <Link
                              to="/inventario/contagem-semanal"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setClogOpen(false); setTimeout(() => navigate('/inventario/contagem-semanal'), 100); }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <FileText size={14} className="lg:w-4 lg:h-4" />
                              Contagem semanal
                            </Link>
                          )}
                          {podeMovimentosMenu && (
                            <Link
                              to="/movimentos"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setClogOpen(false); setTimeout(() => navigate('/movimentos'), 100); }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <FileText size={14} className="lg:w-4 lg:h-4" />
                              Movimentos
                            </Link>
                          )}
                          {podeStockMenu && (
                            <Link
                              to="/transferencias/localizacao"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setClogOpen(false);
                                setTimeout(() => navigate('/transferencias/localizacao'), 100);
                              }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <Share2 size={14} className="lg:w-4 lg:h-4" />
                              Transf. localização
                            </Link>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {canSeeConsultaMenu && (
                    <div
                      className="relative inline-block consulta-dropdown"
                      onMouseEnter={() => setIsInteracting(true)}
                      onMouseLeave={() => setIsInteracting(false)}
                    >
                      <button
                        className="bg-transparent border-none text-white font-semibold text-sm lg:text-base py-3 px-2 lg:px-3 xl:px-4 cursor-pointer flex items-center gap-1 lg:gap-2 transition-colors duration-200 rounded-lg hover:bg-white/10"
                        onClick={() => toggleDropdown('consulta')}
                        title="Consultas"
                      >
                        <MapPin size={14} className="lg:w-4 lg:h-4" />
                        <span>Consulta</span>
                        <ChevronDown size={14} className={`ml-1 text-white transition-transform duration-200 lg:w-4 lg:h-4 ${consultaOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {consultaOpen && (
                        <div className="absolute top-full left-0 bg-[#0915FF] border border-gray-200 rounded-lg shadow-lg min-w-56 z-50 p-2 -mt-1 pt-2">
                          <div className="flex flex-col gap-1">
                            {canSeeConsultaLocalizacoes && (
                              <Link
                                to="/consulta-estoque-localizacoes"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setConsultaOpen(false);
                                  setTimeout(() => navigate('/consulta-estoque-localizacoes'), 100);
                                }}
                                className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                                title="Consulta: localizações e stock (centrais)"
                              >
                                <MapPin size={14} className="lg:w-4 lg:h-4" />
                                Consulta Localizações
                              </Link>
                            )}
                            <Link
                              to="/stock-rastreavel/consulta"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setConsultaOpen(false);
                                setTimeout(() => navigate('/stock-rastreavel/consulta'), 100);
                              }}
                              className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                            >
                              <Database size={14} className="lg:w-4 lg:h-4" />
                              Consulta Seriais/Lotes
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {showGerirMenu && (
            <div 
              className="relative inline-block gerir-dropdown"
              onMouseEnter={() => setIsInteracting(true)}
              onMouseLeave={() => setIsInteracting(false)}
            >
              <button 
                className="bg-transparent border-none text-white font-semibold text-sm lg:text-base py-3 px-2 lg:px-3 xl:px-4 cursor-pointer flex items-center gap-1 lg:gap-2 transition-colors duration-200 rounded-lg hover:bg-white/10"
                onClick={() => toggleDropdown('gerir')}
              >
                <Settings size={14} className="lg:w-4 lg:h-4" />
                <span className="hidden lg:inline">Gerir</span>
                <ChevronDown size={14} className={`ml-1 text-white transition-transform duration-200 lg:w-4 lg:h-4 ${gerirOpen ? 'rotate-180' : ''}`} />
              </button>
              {gerirOpen && (
                <div className="absolute top-full left-0 bg-[#0915FF] border border-gray-200 rounded-lg shadow-lg min-w-48 lg:min-w-56 xl:min-w-64 z-50 p-2 -mt-1 pt-2">
                  {isAdmin && (
                    <>
                      <div className="mb-3">
                        <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Gestão de Artigos</div>
                        <div className="flex flex-col gap-1">
                          <Link to="/cadastrar" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/cadastrar'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                            <Plus size={14} className="lg:w-4 lg:h-4" /> Criar Artigo
                          </Link>
                          <Link to="/excluir-artigo" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/excluir-artigo'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                            <Trash2 size={14} className="lg:w-4 lg:h-4" /> Excluir Artigo
                          </Link>
                          <Link to="/itens-nao-cadastrados" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/itens-nao-cadastrados'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                            <AlertTriangle size={14} className="lg:w-4 lg:h-4" /> Itens Não Cadastrados
                          </Link>
                        </div>
                      </div>
                      <div className="border-t border-white/10 pt-3">
                        <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Armazéns</div>
                        <div className="flex flex-col gap-1">
                          <Link to="/armazens" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/armazens'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                            <Archive size={14} className="lg:w-4 lg:h-4" /> Armazéns
                          </Link>
                        </div>
                      </div>
                      <div className="border-t border-white/10 pt-3">
                        <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Gestão de Usuários</div>
                        <div className="flex flex-col gap-1">
                          <Link to="/admin-usuarios" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/admin-usuarios'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                            <Users size={14} className="lg:w-4 lg:h-4" /> Usuários
                          </Link>
                        </div>
                      </div>
                    </>
                  )}
                  {isArmazemLogistica && (
                    <div className="mb-3">
                      <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Armazém</div>
                      <div className="flex flex-col gap-1">
                        <Link to="/itens-nao-cadastrados" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/itens-nao-cadastrados'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                          <AlertTriangle size={14} className="lg:w-4 lg:h-4" /> Itens Não Cadastrados
                        </Link>
                        <Link to="/armazens" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setGerirOpen(false); setTimeout(() => navigate('/armazens'), 100); }} className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded">
                          <Archive size={14} className="lg:w-4 lg:h-4" /> Armazéns
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {isAuthenticated && (
            <div 
              className="relative inline-block dados-dropdown"
              onMouseEnter={() => setIsInteracting(true)}
              onMouseLeave={() => setIsInteracting(false)}
            >
              <button 
                className="bg-transparent border-none text-white font-semibold text-sm lg:text-base py-3 px-2 lg:px-3 xl:px-4 cursor-pointer flex items-center gap-1 lg:gap-2 transition-colors duration-200 rounded-lg hover:bg-white/10"
                onClick={() => toggleDropdown('dados')}
              >
                <Database size={14} className="lg:w-4 lg:h-4" />
                <span className="hidden lg:inline">Dados</span>
                <ChevronDown size={14} className={`ml-1 text-white transition-transform duration-200 lg:w-4 lg:h-4 ${dadosOpen ? 'rotate-180' : ''}`} />
              </button>
              {dadosOpen && (
                <div className="absolute top-full left-0 bg-[#0915FF] border border-gray-200 rounded-lg shadow-lg min-w-48 lg:min-w-56 xl:min-w-64 z-50 p-2 -mt-1 pt-2">
                  {/* Seção: Importação de Dados */}
                  <div className="mb-3">
                    <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Importação</div>
                    <div className="flex flex-col gap-1">
                      {isAdmin && (
                                              <Link 
                        to="/importar-itens" 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDadosOpen(false);
                          setTimeout(() => {
                            navigate('/importar-itens');
                          }, 100);
                        }} 
                        className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <FileText size={14} className="lg:w-4 lg:h-4" />
                        Importar Itens
                      </Link>
                      )}
                      {isController && (
                        <Link 
                          to="/importar-stock-nacional" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/importar-stock-nacional');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <FileText size={14} className="lg:w-4 lg:h-4" />
                          Importar Stock
                        </Link>
                      )}
                      {(isAdmin || isController) && (
                        <Link 
                          to="/importar-dados-itens" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/importar-dados-itens');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <FileText size={14} className="lg:w-4 lg:h-4" />
                          Importar Dados
                        </Link>
                      )}
                      {(isAdmin || isController) && (
                        <Link 
                          to="/importar-setores" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/importar-setores');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <Settings size={14} className="lg:w-4 lg:h-4" />
                          Importar Setores
                        </Link>
                      )}
                      {(isAdmin || isController) && (
                        <Link 
                          to="/importar-unidades" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/importar-unidades');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <Package size={14} className="lg:w-4 lg:h-4" />
                          Importar Unidades
                        </Link>
                      )}
                      {isAdmin && (
                        <Link 
                          to="/stock-rastreavel/importacao" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/stock-rastreavel/importacao');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <Package size={14} className="lg:w-4 lg:h-4" />
                          Importar Seriais/Lotes
                        </Link>
                      )}
                      {isAdmin && (
                        <Link
                          to="/stock-rastreavel/cadastro-manual"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/stock-rastreavel/cadastro-manual');
                            }, 100);
                          }}
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <Package size={14} className="lg:w-4 lg:h-4" />
                          Cadastrar Serial Manual
                        </Link>
                      )}
                      {podeStockMenu && (
                        <Link 
                          to="/stock-rastreavel/consulta" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/stock-rastreavel/consulta');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <Database size={14} className="lg:w-4 lg:h-4" />
                          Consultar Seriais/Lotes
                        </Link>
                      )}
                    </div>
                  </div>
                  
                  {/* Seção: Gestão de Imagens */}
                  {(isAdmin || isController) && (
                    <div className="border-t border-white/10 pt-3 mb-3">
                      <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Imagens</div>
                      <div className="flex flex-col gap-1">
                        <Link 
                          to="/importar-imagens-automaticas" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/importar-imagens-automaticas');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <Image size={14} className="lg:w-4 lg:h-4" />
                          Importar Imagens
                        </Link>
                        <Link 
                          to="/detectar-imagens-automaticas" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDadosOpen(false);
                            setTimeout(() => {
                              navigate('/detectar-imagens-automaticas');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <RefreshCw size={14} className="lg:w-4 lg:h-4" />
                          Detecção Automática
                        </Link>
                      </div>
                    </div>
                  )}
                  
                  {/* Seção: Exportação */}
                  <div className="border-t border-white/10 pt-3">
                    <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Exportação</div>
                    <div className="flex flex-col gap-1">
                      <Link 
                        to="/exportar" 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDadosOpen(false);
                          setTimeout(() => {
                            navigate('/exportar');
                          }, 100);
                        }} 
                        className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <Download size={14} className="lg:w-4 lg:h-4" />
                        Exportar Dados
                      </Link>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </nav>
        
        {/* Usuário Desktop - Visível apenas em telas médias e grandes */}
        <div className="hidden md:flex items-center gap-2 lg:gap-3 flex-shrink-0">
          {isAuthenticated ? (
            <>
              {showMeuPerfil ? (
                <div
                  className="relative user-menu-dropdown-desktop"
                  onMouseEnter={() => setIsInteracting(true)}
                  onMouseLeave={() => setIsInteracting(false)}
                >
                  <button
                    type="button"
                    className="bg-transparent border-none text-white font-semibold text-sm lg:text-base py-2 pl-2 pr-1 lg:pl-3 cursor-pointer flex items-center gap-1 max-w-[11rem] lg:max-w-[15rem] rounded-lg transition-colors duration-200 hover:bg-white/10 text-left"
                    onClick={() => toggleDropdown('user')}
                    aria-expanded={userMenuOpen}
                    aria-haspopup="true"
                  >
                    <span className="truncate whitespace-nowrap" title={displayName}>
                      {displayName || 'Conta'}
                    </span>
                    <ChevronDown
                      size={16}
                      className={`shrink-0 text-white transition-transform duration-200 ${userMenuOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {userMenuOpen && (
                    <div className="absolute top-full right-0 bg-[#0915FF] border border-gray-200 rounded-lg shadow-lg min-w-52 z-50 p-2 -mt-0.5 pt-2">
                      <Link
                        to="/admin-usuarios"
                        onClick={(e) => {
                          e.preventDefault();
                          closeAllDropdowns();
                          setTimeout(() => navigate('/admin-usuarios'), 100);
                        }}
                        className="flex items-center gap-2 py-2.5 px-3 text-white no-underline font-medium text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <User size={16} />
                        Meu perfil
                      </Link>
                    </div>
                  )}
                </div>
              ) : (
                <span
                  className="text-white font-semibold text-sm lg:text-base truncate whitespace-nowrap max-w-[11rem] lg:max-w-[15rem]"
                  title={displayName}
                >
                  {displayName || user?.username || '—'}
                </span>
              )}
              <button
                className="bg-white text-[#0915FF] font-bold border-none rounded py-2 px-3 lg:px-4 xl:px-6 ml-1 lg:ml-2 text-sm lg:text-base cursor-pointer transition-all duration-200 shadow-lg hover:bg-gray-100 shrink-0"
                onClick={handleLogout}
              >
                SAIR
              </button>
            </>
          ) : (
            <Link to="/login" className="bg-white text-[#0915FF] font-bold border-none rounded py-2 px-3 lg:px-4 xl:px-7 ml-2 lg:ml-4 xl:ml-8 text-sm lg:text-base cursor-pointer transition-all duration-200 shadow-lg hover:bg-gray-100 no-underline">
              ENTRAR
            </Link>
          )}
        </div>
        
        {/* Botão Hamburguer Mobile - Visível apenas em telas pequenas */}
        <div className="md:hidden flex items-center">
          <button 
            className="bg-transparent border-none flex items-center justify-center h-10 w-10 sm:h-11 sm:w-11 ml-2 sm:ml-4 cursor-pointer rounded-lg transition-all duration-200 hover:bg-white/10 active:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/50 relative z-50" 
            onClick={() => {
              setMobileOpen(!mobileOpen);
            }} 
            aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
            type="button"
          >
            {mobileOpen ? (
              <X size={20} className="text-white" />
            ) : (
              <Menu size={20} className="text-white" />
            )}
          </button>
          
          {/* Texto indicativo (opcional) */}
          <span className="text-white text-xs ml-2 hidden sm:block">
            {mobileOpen ? 'Fechar' : 'Menu'}
          </span>
        </div>
      </div>
      
      {/* Menu Mobile - Visível apenas em telas pequenas */}
      {mobileOpen && (
        <nav 
          id="mobile-menu"
          className="md:hidden fixed top-14 left-0 w-full bg-[#0915FF] flex flex-col items-center gap-2 sm:gap-3 py-4 sm:py-6 px-0 z-[9999] rounded-b-[22px] shadow-lg max-h-[calc(100vh-56px)] overflow-y-auto"
          aria-hidden={!mobileOpen}
          style={{ pointerEvents: 'auto' }}
        >
                      <div className="w-[85vw] sm:w-[90vw] py-3 sm:py-4.5 px-0 h-auto rounded-xl text-center text-base sm:text-lg font-semibold bg-white/8 m-0 mb-1 sm:mb-0.5 transition-all duration-200">
              <Link to="/" onClick={(e) => handleMobileNavigation('/', e)} className="text-white no-underline font-semibold w-full h-full flex items-center justify-center">
                Início
              </Link>
            </div>
          {isAuthenticated && (
            <>
              <div className="w-[85vw] sm:w-[90vw] py-3 sm:py-4.5 px-0 h-auto rounded-xl text-center text-base sm:text-lg font-semibold bg-white/8 m-0 mb-1 sm:mb-0.5 transition-all duration-200">
                <Link to="/listar" onClick={(e) => handleMobileNavigation('/listar', e)} className="text-white no-underline font-semibold w-full h-full flex items-center justify-center">
                  Catálogo
                </Link>
              </div>
              {canSeeDashboardCliente && (
                <div className="w-[85vw] sm:w-[90vw] py-3 sm:py-4.5 px-0 h-auto rounded-xl text-center text-base sm:text-lg font-semibold bg-white/8 m-0 mb-1 sm:mb-0.5 transition-all duration-200">
                  <Link to="/dashboard-cliente-compostos" onClick={(e) => handleMobileNavigation('/dashboard-cliente-compostos', e)} className="text-white no-underline font-semibold w-full h-full flex items-center justify-center">
                    Dashboard CLIENTE
                  </Link>
                </div>
              )}
              {canSeeClogMenu && (
                <>
                  <div className="relative w-full clog-dropdown">
                    <button
                      className="w-full justify-between py-3 sm:py-4 px-4 sm:px-5 bg-transparent border-none text-white font-semibold text-sm sm:text-base cursor-pointer flex items-center gap-2 transition-colors duration-200 rounded-lg"
                      onClick={() => toggleDropdown('clog')}
                    >
                      <div className="flex items-center gap-2">
                        <Truck size={14} className="sm:w-4 sm:h-4" />
                        Clog
                      </div>
                      <ChevronDown size={14} className={`text-white transition-transform duration-200 sm:w-4 sm:h-4 ${clogOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {clogOpen && (
                      <div className="static shadow-none border-none bg-white/5 m-0 p-0 rounded-none">
                        <div className="flex flex-col">
                          {canSeeRequisicoes && (
                            <Link to="/requisicoes" onClick={(e) => handleMobileNavigation('/requisicoes', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                              <ShoppingCart size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Requisições
                            </Link>
                          )}
                          {canSeeRequisicoes && (
                            <Link to="/devolucoes" onClick={(e) => handleMobileNavigation('/devolucoes', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                              <RotateCcw size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Devoluções
                            </Link>
                          )}
                          {canSeeRequisicoes && (
                            <Link to="/transferencias" onClick={(e) => handleMobileNavigation('/transferencias', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                              <Truck size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Transferências
                            </Link>
                          )}
                          {podeInventarioMenu && (
                            <Link to="/inventario" onClick={(e) => handleMobileNavigation('/inventario', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                              <FileText size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Inventário
                            </Link>
                          )}
                          {podeContagemSemanalMenu && (
                            <Link to="/inventario/contagem-semanal" onClick={(e) => handleMobileNavigation('/inventario/contagem-semanal', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                              <FileText size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Contagem semanal
                            </Link>
                          )}
                          {podeMovimentosMenu && (
                            <Link to="/movimentos" onClick={(e) => handleMobileNavigation('/movimentos', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                              <FileText size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Movimentos
                            </Link>
                          )}
                          {podeStockMenu && (
                            <Link
                              to="/transferencias/localizacao"
                              onClick={(e) => handleMobileNavigation('/transferencias/localizacao', e)}
                              className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10"
                            >
                              <Share2 size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Transf. localização
                            </Link>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {canSeeConsultaMenu && (
                    <div className="relative w-full consulta-dropdown">
                      <button
                        className="w-full justify-between py-3 sm:py-4 px-4 sm:px-5 bg-transparent border-none text-white font-semibold text-sm sm:text-base cursor-pointer flex items-center gap-2 transition-colors duration-200 rounded-lg"
                        onClick={() => toggleDropdown('consulta')}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin size={14} className="sm:w-4 sm:h-4" />
                          Consulta
                        </div>
                        <ChevronDown size={14} className={`text-white transition-transform duration-200 sm:w-4 sm:h-4 ${consultaOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {consultaOpen && (
                        <div className="static shadow-none border-none bg-white/5 m-0 p-0 rounded-none">
                          <div className="flex flex-col">
                            {canSeeConsultaLocalizacoes && (
                              <Link
                                to="/consulta-estoque-localizacoes"
                                onClick={(e) => handleMobileNavigation('/consulta-estoque-localizacoes', e)}
                                className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10"
                                title="Consulta: localizações e stock (centrais)"
                              >
                                <MapPin size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                                Consulta Localizações
                              </Link>
                            )}
                            <Link
                              to="/stock-rastreavel/consulta"
                              onClick={(e) => handleMobileNavigation('/stock-rastreavel/consulta', e)}
                              className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10"
                            >
                              <Database size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                              Consulta Seriais/Lotes
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {showGerirMenu && (
            <div className="relative w-full gerir-dropdown">
              <button 
                className="w-full justify-between py-3 sm:py-4 px-4 sm:px-5 bg-transparent border-none text-white font-semibold text-sm sm:text-base cursor-pointer flex items-center gap-2 transition-colors duration-200 rounded-lg"
                onClick={() => toggleDropdown('gerir')}
              >
                <div className="flex items-center gap-2">
                  <Settings size={14} className="sm:w-4 sm:h-4" />
                  Gerir
                </div>
                <ChevronDown size={14} className={`text-white transition-transform duration-200 sm:w-4 sm:h-4 ${gerirOpen ? 'rotate-180' : ''}`} />
              </button>
              {gerirOpen && (
                <div className="static shadow-none border-none bg-white/5 m-0 p-0 rounded-none">
                  {isAdmin && (
                    <>
                      <div className="border-b border-white/10 pb-3 mb-3">
                        <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Gestão de Artigos</div>
                        <div className="flex flex-col">
                          <Link to="/cadastrar" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                            <Plus size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Criar Artigo
                          </Link>
                          <Link to="/excluir-artigo" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                            <Trash2 size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Excluir Artigo
                          </Link>
                          <Link to="/itens-nao-cadastrados" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                            <AlertTriangle size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Itens Não Cadastrados
                          </Link>
                        </div>
                      </div>
                      <div className="border-t border-white/10 pt-3">
                        <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Armazéns</div>
                        <div className="flex flex-col">
                          <Link to="/armazens" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                            <Archive size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Armazéns
                          </Link>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Gestão de Usuários</div>
                        <div className="flex flex-col">
                          <Link to="/admin-usuarios" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                            <Users size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Usuários
                          </Link>
                        </div>
                      </div>
                    </>
                  )}
                  {isArmazemLogistica && (
                    <div>
                      <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Armazém</div>
                      <div className="flex flex-col">
                        <Link to="/itens-nao-cadastrados" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <AlertTriangle size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Itens Não Cadastrados
                        </Link>
                        <Link to="/armazens" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Archive size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" /> Armazéns
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {isAuthenticated && (
            <div className="relative w-full dados-dropdown">
              <button 
                className="w-full justify-between py-3 sm:py-4 px-4 sm:px-5 bg-transparent border-none text-white font-semibold text-sm sm:text-base cursor-pointer flex items-center gap-2 transition-colors duration-200 rounded-lg"
                onClick={() => {
                  toggleDropdown('dados');
                }}
              >
                <div className="flex items-center gap-2">
                  <Database size={14} className="sm:w-4 sm:h-4" />
                  Dados
                </div>
                <ChevronDown size={14} className={`text-white transition-transform duration-200 sm:w-4 sm:h-4 ${dadosOpen ? 'rotate-180' : ''}`} />
              </button>
              {dadosOpen && (
                <div className="static shadow-none border-none bg-white/5 m-0 p-0 rounded-none">
                  {/* Seção: Importação */}
                  <div className="border-b border-white/10 pb-3 mb-3">
                    <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Importação</div>
                    <div className="flex flex-col">
                      {isAdmin && (
                        <Link to="/importar-itens" onClick={(e) => handleMobileNavigation('/importar-itens', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <FileText size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Itens
                        </Link>
                      )}
                      {isController && (
                        <Link to="/importar-stock-nacional" onClick={(e) => handleMobileNavigation('/importar-stock-nacional', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <FileText size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Stock
                        </Link>
                      )}
                      {(isAdmin || isController) && (
                        <Link to="/importar-dados-itens" onClick={(e) => handleMobileNavigation('/importar-dados-itens', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <FileText size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Dados
                        </Link>
                      )}
                      {(isAdmin || isController) && (
                        <Link to="/importar-setores" onClick={(e) => handleMobileNavigation('/importar-setores', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Settings size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Setores
                        </Link>
                      )}
                      {(isAdmin || isController) && (
                        <Link to="/importar-unidades" onClick={(e) => handleMobileNavigation('/importar-unidades', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Package size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Unidades
                        </Link>
                      )}
                      {isAdmin && (
                        <Link to="/stock-rastreavel/importacao" onClick={(e) => handleMobileNavigation('/stock-rastreavel/importacao', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Package size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Seriais/Lotes
                        </Link>
                      )}
                      {isAdmin && (
                        <Link to="/stock-rastreavel/cadastro-manual" onClick={(e) => handleMobileNavigation('/stock-rastreavel/cadastro-manual', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Package size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Cadastrar Serial Manual
                        </Link>
                      )}
                      {podeStockMenu && (
                        <Link to="/stock-rastreavel/consulta" onClick={(e) => handleMobileNavigation('/stock-rastreavel/consulta', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Database size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Consultar Seriais/Lotes
                        </Link>
                      )}
                    </div>
                  </div>
                  
                  {/* Seção: Imagens */}
                  {(isAdmin || isController) && (
                    <div className="border-b border-white/10 pb-3 mb-3">
                      <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Imagens</div>
                      <div className="flex flex-col">
                        <Link to="/importar-imagens-automaticas" onClick={(e) => handleMobileNavigation('/importar-imagens-automaticas', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <Image size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Importar Imagens
                        </Link>
                        <Link to="/detectar-imagens-automaticas" onClick={(e) => handleMobileNavigation('/detectar-imagens-automaticas', e)} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <RefreshCw size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Detecção Automática
                        </Link>
                      </div>
                    </div>
                  )}
                  
                  {/* Seção: Exportação */}
                  <div>
                    <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Exportação</div>
                    <div className="flex flex-col">
                      <button 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDadosOpen(false);
                          setMobileOpen(false);
                          setTimeout(() => {
                            navigate('/exportar');
                          }, 150);
                        }} 
                        className="w-full text-left text-white py-3 sm:py-4 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10 active:bg-white/20"
                        style={{ 
                          cursor: 'pointer', 
                          pointerEvents: 'auto', 
                          background: 'transparent', 
                          border: 'none',
                          minHeight: '44px', // Área mínima de toque para mobile
                          touchAction: 'manipulation' // Melhora resposta ao toque
                        }}
                      >
                        <Download size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                        Exportar Dados
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex-col gap-2 items-stretch py-2 sm:py-3 px-4 sm:px-5 border-t border-white/10 mt-1 sm:mt-2 w-full user-menu-dropdown-mobile">
            {isAuthenticated ? (
              <>
                {showMeuPerfil ? (
                  <>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 py-2 px-1 text-white font-semibold text-sm sm:text-base bg-transparent border-none rounded-lg hover:bg-white/10 text-left"
                      onClick={() => toggleDropdown('user')}
                      aria-expanded={userMenuOpen}
                    >
                      <span className="truncate whitespace-nowrap min-w-0 flex-1" title={displayName}>
                        {displayName || 'Conta'}
                      </span>
                      <ChevronDown
                        size={18}
                        className={`shrink-0 transition-transform duration-200 ${userMenuOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {userMenuOpen && (
                      <Link
                        to="/admin-usuarios"
                        onClick={(e) => handleMobileNavigation('/admin-usuarios', e)}
                        className="flex items-center gap-2 py-2.5 px-3 pl-6 text-white no-underline text-sm font-medium rounded-lg bg-white/5 hover:bg-white/10"
                      >
                        <User size={16} />
                        Meu perfil
                      </Link>
                    )}
                  </>
                ) : (
                  <span
                    className="text-white font-semibold text-sm sm:text-base truncate whitespace-nowrap px-1"
                    title={displayName}
                  >
                    {displayName || user?.username || '—'}
                  </span>
                )}
                <button
                  className="w-full text-center py-2.5 sm:py-3 text-sm sm:text-base font-bold m-0 rounded-lg bg-white text-[#0915FF] transition-all duration-200 hover:bg-gray-100"
                  onClick={handleLogout}
                >
                  SAIR
                </button>
              </>
            ) : (
              <Link to="/login" className="w-full text-center py-2.5 sm:py-3 text-sm sm:text-base font-bold m-0 rounded-lg bg-white text-[#0915FF] transition-all duration-200 hover:bg-gray-100 no-underline">
                ENTRAR
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  );
};

export default Navbar; 