import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogIn, Eye, EyeOff, Lock, User, ArrowLeft, Shield } from 'react-feather';
import { useAuth } from '../contexts/AuthContext';

const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [formData, setFormData] = useState({
    username: '',
    password: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [fieldError, setFieldError] = useState('');

  React.useEffect(() => {
    function handleResize() {
      // setIsMobile(window.innerWidth <= 600); // This line was removed
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFieldError('');
    
    if (!formData.username || !formData.password) {
      setFieldError('Por favor, preencha todos os campos');
      return;
    }

    setLoading(true);

    try {
      const result = await login(formData.username, formData.password);
      
      if (result.success) {
        setToast({ type: 'success', message: 'Login realizado com sucesso! Redirecionando...' });
        setTimeout(() => {
          navigate('/');
        }, 1500);
      } else {
        setFieldError(result.message || 'Usuário ou senha inválidos');
      }
    } catch (error) {
      setFieldError('Erro de conexão');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-2 sm:p-4 bg-gradient-to-br from-[#667eea] via-[#764ba2] to-[#ff6cab] transition-all duration-500 relative">
      {toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 min-w-[180px] max-w-xs px-4 py-2 rounded-lg text-center font-semibold text-sm shadow-lg"
          style={{ background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)', color: toast.type === 'success' ? '#15803d' : '#b91c1c' }}>
          {toast.message}
        </div>
      )}
      <div className="w-full max-w-md sm:max-w-lg md:max-w-xl mx-auto border-2 border-white/20 rounded-3xl bg-white/10 backdrop-blur-xl p-4 sm:p-8 flex flex-col items-center gap-4 sm:gap-6">
        {/* Header */}
        <div className="text-center mb-4 sm:mb-6">
          <div className="flex items-center justify-center mb-3 sm:mb-4">
            <Shield className="w-10 h-10 sm:w-12 sm:h-12 text-white mr-3 sm:mr-4 filter drop-shadow-lg" />
            <h1 className="text-2xl sm:text-4xl font-bold text-white text-shadow-lg">ACESSO RESTRITO</h1>
          </div>
          <p className="text-base sm:text-lg text-gray-200 opacity-90">Faça login para acessar o catalogo</p>
        </div>
        {/* Login Form */}
        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-3 sm:gap-4">
          <div className="text-center mb-3 sm:mb-4">
            <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-r from-blue-600 to-purple-600 rounded-full flex items-center justify-center mx-auto mb-3 sm:mb-4 shadow-lg">
              <LogIn className="w-8 h-8 sm:w-12 sm:h-12 text-white" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-blue-600 mb-1">Bem-vindo</h2>
            <p className="text-gray-600 text-xs sm:text-sm">Entre com suas credenciais para continuar</p>
          </div>
          {/* Username */}
          <div>
            <label className="flex items-center text-blue-600 font-semibold mb-2 text-sm sm:text-base">
              <User className="w-4 h-4 sm:w-5 sm:h-5 mr-2 text-blue-400" /> Usuário
            </label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleInputChange}
              className="w-full border-2 border-gray-300 rounded-lg px-3 sm:px-4 py-2 sm:py-3 text-sm sm:text-base outline-none transition-all duration-200 bg-white/90 shadow-sm"
              placeholder="Digite seu usuário"
              required
              onFocus={e => e.target.classList.add('border-blue-600')}
              onBlur={e => e.target.classList.remove('border-blue-600')}
            />
          </div>
          {/* Password */}
          <div>
            <label className="flex items-center text-blue-600 font-semibold mb-2 text-sm sm:text-base">
              <Lock className="w-4 h-4 sm:w-5 sm:h-5 mr-2 text-blue-400" /> Senha
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={formData.password}
                onChange={e => {
                  handleInputChange(e);
                  if (fieldError) setFieldError('');
                }}
                className="w-full border-2 border-gray-300 rounded-lg px-3 sm:px-4 py-2 sm:py-3 text-sm sm:text-base outline-none transition-all duration-200 bg-white/90 shadow-sm pr-10 sm:pr-12"
                placeholder="Digite sua senha"
                required
                onFocus={e => e.target.classList.add('border-blue-600')}
                onBlur={e => e.target.classList.remove('border-blue-600')}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 bg-transparent border-none text-blue-600 cursor-pointer p-0"
              >
                {showPassword ? (
                  <EyeOff className="w-5 h-5 sm:w-6 sm:h-6" />
                ) : (
                  <Eye className="w-5 h-5 sm:w-6 sm:h-6" />
                )}
              </button>
            </div>
            {fieldError && (
              <div className="text-red-500 text-xs sm:text-sm mt-2 ml-1">{fieldError}</div>
            )}
          </div>
          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold py-2 sm:py-3 px-3 sm:px-4 rounded-lg text-base sm:text-lg border-none shadow-md transition-all duration-200 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                Entrando...
              </>
            ) : (
              <>
                <LogIn className="w-5 h-5 sm:w-6 sm:h-6" />
                Entrar
              </>
            )}
          </button>
        </form>
        {/* Back to Home */}
        <div className="mt-4 sm:mt-6 text-center">
          <Link 
            to="/" 
            className="text-blue-600 font-semibold text-base underline decoration-blue-600 flex items-center justify-center gap-2"
          >
            <ArrowLeft className="w-5 h-5" />
            Voltar ao Início
          </Link>
        </div>
        {/* Footer */}
        <div className="text-center mt-4 sm:mt-6">
          <p className="text-gray-200 opacity-70 text-xs sm:text-sm">Sistema de Catálogo Inteligente</p>
        </div>
      </div>
    </div>
  );
};

export default Login;