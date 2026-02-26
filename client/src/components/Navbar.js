import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ChevronDown, Settings, Database, Users, FileText, Download, Plus, Trash2, Image, RefreshCw, Menu, X, AlertTriangle, Package, ShoppingCart, Archive } from 'react-feather';

const Navbar = () => {
  const { isAuthenticated, logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [gerirOpen, setGerirOpen] = useState(false);
  const [dadosOpen, setDadosOpen] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isAdmin = user && user.role === 'admin';
  const isController = user && (user.role === 'admin' || user.role === 'controller');

  // Fechar menu mobile ao navegar
  const handleNavigation = () => {
    setMobileOpen(false);
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
    setDadosOpen(false);
    setGerirOpen(false);
    
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
      
      // Verificar se o clique foi em um link ou botão dentro do dropdown
      const isDropdownLink = event.target.closest('a') || event.target.closest('button');
      
      if (gerirOpen && gerirDropdown && !gerirDropdown.contains(event.target) && !isDropdownLink) {
        setTimeout(() => {
          setGerirOpen(false);
        }, 100);
      }
      
      if (dadosOpen && dadosDropdown && !dadosDropdown.contains(event.target) && !isDropdownLink) {
        setTimeout(() => {
          setDadosOpen(false);
        }, 100);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [gerirOpen, dadosOpen]);

  // Fechar dropdowns quando o mouse sai deles (com delay)
  useEffect(() => {
    let gerirTimeout;
    let dadosTimeout;

    const handleMouseLeave = (event) => {
      const gerirDropdown = document.querySelector('.gerir-dropdown');
      const dadosDropdown = document.querySelector('.dados-dropdown');
      
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
    };

    const handleMouseEnter = () => {
      // Cancelar timeout se o mouse voltar
      if (gerirTimeout) {
        clearTimeout(gerirTimeout);
      }
      if (dadosTimeout) {
        clearTimeout(dadosTimeout);
      }
    };

    const gerirDropdown = document.querySelector('.gerir-dropdown');
    const dadosDropdown = document.querySelector('.dados-dropdown');
    
    if (gerirDropdown) {
      gerirDropdown.addEventListener('mouseleave', handleMouseLeave);
      gerirDropdown.addEventListener('mouseenter', handleMouseEnter);
    }
    
    if (dadosDropdown) {
      dadosDropdown.addEventListener('mouseleave', handleMouseLeave);
      dadosDropdown.addEventListener('mouseenter', handleMouseEnter);
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
      if (gerirTimeout) clearTimeout(gerirTimeout);
      if (dadosTimeout) clearTimeout(dadosTimeout);
    };
  }, [gerirOpen, dadosOpen, isInteracting]);

  return (
    <header className="w-full bg-[#0915FF] text-white fixed top-0 left-0 z-50 shadow-lg h-14 flex items-center">
      <div className="w-full max-w-7xl mx-auto flex items-center justify-between h-14 px-4 sm:px-6">
        <div className="text-lg sm:text-xl md:text-2xl font-black tracking-wider text-white mr-2 sm:mr-4 md:mr-8 flex-shrink-0">CATÁLOGO</div>
        
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
              {(isAdmin || isController) && (
                <div className="relative font-medium text-sm lg:text-base uppercase tracking-wider text-white cursor-pointer flex items-center px-2 lg:px-3 xl:px-4 h-12 min-w-12 lg:min-w-14 xl:min-w-16 rounded-lg transition-all duration-200 hover:bg-white/10 hover:text-yellow-400">
                  <Link to="/requisicoes" className="text-inherit no-underline px-0.5 font-semibold w-full h-full flex items-center justify-center">
                    Requisições
                  </Link>
                </div>
              )}
            </>
          )}
          {isAdmin && (
            <div 
              className="relative inline-block gerir-dropdown"
              onMouseEnter={() => setIsInteracting(true)}
              onMouseLeave={() => setIsInteracting(false)}
            >
              <button 
                className="bg-transparent border-none text-white font-semibold text-sm lg:text-base py-3 px-2 lg:px-3 xl:px-4 cursor-pointer flex items-center gap-1 lg:gap-2 transition-colors duration-200 rounded-lg hover:bg-white/10"
                onClick={() => setGerirOpen(!gerirOpen)}
              >
                <Settings size={14} className="lg:w-4 lg:h-4" />
                <span className="hidden lg:inline">Gerir</span>
                <ChevronDown size={14} className={`ml-1 text-white transition-transform duration-200 lg:w-4 lg:h-4 ${gerirOpen ? 'rotate-180' : ''}`} />
              </button>
              {gerirOpen && (
                <div className="absolute top-full left-0 bg-[#0915FF] border border-gray-200 rounded-lg shadow-lg min-w-48 lg:min-w-56 xl:min-w-64 z-50 p-2 -mt-1 pt-2">
                  {/* Seção: Gestão de Artigos */}
                  <div className="mb-3">
                    <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Gestão de Artigos</div>
                    <div className="flex flex-col gap-1">
                      <Link 
                        to="/cadastrar" 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setGerirOpen(false);
                          setTimeout(() => {
                            navigate('/cadastrar');
                          }, 100);
                        }} 
                        className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <Plus size={14} className="lg:w-4 lg:h-4" />
                        Criar Artigo
                      </Link>
                      <Link 
                        to="/excluir-artigo" 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setGerirOpen(false);
                          setTimeout(() => {
                            navigate('/excluir-artigo');
                          }, 100);
                        }} 
                        className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <Trash2 size={14} className="lg:w-4 lg:h-4" />
                        Excluir Artigo
                      </Link>
                      {(isAdmin || isController) && (
                        <Link 
                          to="/itens-nao-cadastrados" 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setGerirOpen(false);
                            setTimeout(() => {
                              navigate('/itens-nao-cadastrados');
                            }, 100);
                          }} 
                          className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                        >
                          <AlertTriangle size={14} className="lg:w-4 lg:h-4" />
                          Itens Não Cadastrados
                        </Link>
                      )}
                    </div>
                  </div>
                  
                  {/* Seção: Gestão de Armazéns */}
                  <div className="border-t border-white/10 pt-3">
                    <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Armazéns</div>
                    <div className="flex flex-col gap-1">
                      <Link 
                        to="/armazens" 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setGerirOpen(false);
                          setTimeout(() => {
                            navigate('/armazens');
                          }, 100);
                        }} 
                        className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <Archive size={14} className="lg:w-4 lg:h-4" />
                        Armazéns
                      </Link>
                    </div>
                  </div>
                  {/* Seção: Gestão de Usuários */}
                  <div className="border-t border-white/10 pt-3">
                    <div className="text-xs text-white/70 font-medium px-3 py-1 uppercase tracking-wider">Gestão de Usuários</div>
                    <div className="flex flex-col gap-1">
                      <Link 
                        to="/admin-usuarios" 
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setGerirOpen(false);
                          setTimeout(() => {
                            navigate('/admin-usuarios');
                          }, 100);
                        }} 
                        className="flex items-center gap-2 lg:gap-3 py-2 lg:py-3 px-3 lg:px-4 text-white no-underline font-medium text-xs lg:text-sm transition-colors duration-200 hover:bg-white/10 rounded"
                      >
                        <Users size={14} className="lg:w-4 lg:h-4" />
                        Usuários
                      </Link>
                    </div>
                  </div>
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
                onClick={() => setDadosOpen(!dadosOpen)}
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
        <div className="hidden md:flex items-center gap-2 lg:gap-3">
          {isAuthenticated ? (
            <>
              <span className="text-white font-semibold text-sm lg:text-base hidden xl:inline">{user?.nome || user?.username}</span>
              <button 
                className="bg-white text-[#0915FF] font-bold border-none rounded py-2 px-3 lg:px-4 xl:px-7 ml-2 lg:ml-4 xl:ml-8 text-sm lg:text-base cursor-pointer transition-all duration-200 shadow-lg hover:bg-gray-100" 
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
              {(isAdmin || isController) && (
                <div className="w-[85vw] sm:w-[90vw] py-3 sm:py-4.5 px-0 h-auto rounded-xl text-center text-base sm:text-lg font-semibold bg-white/8 m-0 mb-1 sm:mb-0.5 transition-all duration-200">
                  <Link to="/requisicoes" onClick={(e) => handleMobileNavigation('/requisicoes', e)} className="text-white no-underline font-semibold w-full h-full flex items-center justify-center">
                    <ShoppingCart size={16} className="inline mr-2 sm:mr-3" />
                    Requisições
                  </Link>
                </div>
              )}
            </>
          )}
          {isAdmin && (
            <div className="relative w-full gerir-dropdown">
              <button 
                className="w-full justify-between py-3 sm:py-4 px-4 sm:px-5 bg-transparent border-none text-white font-semibold text-sm sm:text-base cursor-pointer flex items-center gap-2 transition-colors duration-200 rounded-lg"
                onClick={() => {
                  setGerirOpen(!gerirOpen);
                }}
              >
                <div className="flex items-center gap-2">
                  <Settings size={14} className="sm:w-4 sm:h-4" />
                  Gerir
                </div>
                <ChevronDown size={14} className={`text-white transition-transform duration-200 sm:w-4 sm:h-4 ${gerirOpen ? 'rotate-180' : ''}`} />
              </button>
              {gerirOpen && (
                <div className="static shadow-none border-none bg-white/5 m-0 p-0 rounded-none">
                  {/* Seção: Gestão de Artigos */}
                  <div className="border-b border-white/10 pb-3 mb-3">
                    <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Gestão de Artigos</div>
                    <div className="flex flex-col">
                      <Link to="/cadastrar" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                        <Plus size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                        Criar Artigo
                      </Link>
                      <Link to="/excluir-artigo" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                        <Trash2 size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                        Excluir Artigo
                      </Link>
                      {(isAdmin || isController) && (
                        <Link to="/itens-nao-cadastrados" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                          <AlertTriangle size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                          Itens Não Cadastrados
                        </Link>
                      )}
                    </div>
                  </div>
                  
                  {/* Seção: Armazéns */}
                  <div className="border-t border-white/10 pt-3">
                    <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Armazéns</div>
                    <div className="flex flex-col">
                      <Link to="/armazens" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                        <Archive size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                        Armazéns
                      </Link>
                    </div>
                  </div>
                  
                  {/* Seção: Gestão de Usuários */}
                  <div>
                    <div className="text-xs text-white/70 font-medium px-4 sm:px-5 py-2 uppercase tracking-wider">Gestão de Usuários</div>
                    <div className="flex flex-col">
                      <Link to="/admin-usuarios" onClick={handleNavigation} className="text-white py-2.5 sm:py-3 px-4 sm:px-5 pl-8 sm:pl-10 border-b border-white/5 text-xs sm:text-sm transition-colors duration-200 hover:bg-white/10">
                        <Users size={14} className="inline mr-2 sm:mr-3 sm:w-4 sm:h-4" />
                        Usuários
                      </Link>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {isAuthenticated && (
            <div className="relative w-full dados-dropdown">
              <button 
                className="w-full justify-between py-3 sm:py-4 px-4 sm:px-5 bg-transparent border-none text-white font-semibold text-sm sm:text-base cursor-pointer flex items-center gap-2 transition-colors duration-200 rounded-lg"
                onClick={() => {
                  setDadosOpen(!dadosOpen);
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
          <div className="flex-col gap-2 items-start py-2 sm:py-3 px-4 sm:px-5 border-t border-white/10 mt-1 sm:mt-2 w-full">
            {isAuthenticated ? (
              <>
                <span className="text-white font-semibold text-xs sm:text-sm opacity-90">{user?.nome || user?.username}</span>
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