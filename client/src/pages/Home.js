import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Database, Search, Shield } from 'react-feather';
import { useAuth } from '../contexts/AuthContext';


const Home = () => {
  const { isAuthenticated, loading } = useAuth();
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="min-h-screen bg-[#f5f6fa] flex items-center justify-center px-2 sm:px-4">
      <div className="bg-white rounded-[20px] shadow-[0_8px_32px_rgba(9,21,255,0.08)] border border-[#d1d5db] w-full max-w-[95vw] sm:max-w-[540px] p-4 sm:p-8 my-0 flex flex-col items-center gap-6 sm:gap-[32px]">
        <div className="flex flex-col items-center gap-2 sm:gap-3">
          <div className="bg-[#0915FF] rounded-full p-4 sm:p-5 mb-2 flex items-center justify-center">
            <Database className="text-white" size={40} />
          </div>
          <h1 className="text-[#0915FF] font-extrabold text-[22px] sm:text-[32px] text-center m-0 leading-[1.2]">Catálogo Inteligente</h1>
          <p className="text-[#444] text-[15px] sm:text-[18px] text-center m-0 max-w-[90vw] sm:max-w-[400px] leading-[1.5]">
            Sistema moderno para catalogação, identificação visual e gestão de itens.
          </p>
        </div>
        <div className="w-full flex flex-col gap-3 sm:gap-4">
          {!isAuthenticated && !loading && (
            <>
              <Link to="/login" className="Home-link bg-[#0915FF] border-none text-white font-bold rounded-[14px] py-3 sm:py-4 text-base sm:text-lg text-center no-underline shadow-md flex items-center justify-center gap-2 transition-all w-full min-h-[44px] sm:min-h-[52px] hover:bg-[#060bcc] focus:bg-[#060bcc]">
                <Shield size={20} />
                Login
              </Link>
              {/* <Link to="/cadastro" className="Home-link bg-[#0915FF] border-none text-white font-bold rounded-[14px] py-4 text-lg text-center no-underline shadow-md flex items-center justify-center gap-2 transition-all w-full min-h-[52px] hover:bg-[#060bcc] focus:bg-[#060bcc]">
                <UserPlus size={22} className="text-white" />
                Criar Conta
              </Link> */}
            </>
          )}
          {isAuthenticated && (
            <Link to="/listar" className="Home-link bg-white border border-[#0915FF] text-[#0915FF] font-bold rounded-[14px] py-3 sm:py-4 text-base sm:text-lg text-center no-underline shadow flex items-center justify-center gap-2 transition-all min-h-[44px] sm:min-h-[52px]">
              <Search size={20} />
              Consultar Catálogo
            </Link>
          )}
        </div>
        <div className="text-[#444] text-xs sm:text-sm text-center mt-2 leading-snug px-2 flex items-center justify-center gap-2">
          <Shield size={16} className="text-[#0915FF] inline align-middle" />
          Acesso seguro e controle de permissões para administradores
        </div>
      </div>
    </div>
  );
};

export default Home;