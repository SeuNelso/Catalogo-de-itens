import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogIn, Eye, EyeOff, Lock, User, ArrowLeft, Shield } from 'react-feather';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';

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

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.username || !formData.password) {
      setToast({ type: 'error', message: 'Por favor, preencha todos os campos' });
      return;
    }

    setLoading(true);

    try {
      const result = await login(formData.username, formData.password);
      
      if (result.success) {
        setToast({ type: 'success', message: 'Login realizado com sucesso! Redirecionando...' });
        setTimeout(() => {
          navigate('/cadastrar');
        }, 1500);
      } else {
        setToast({ type: 'error', message: result.message || 'Credenciais inválidas' });
      }
    } catch (error) {
      setToast({ type: 'error', message: 'Erro de conexão' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-600 via-purple-600 to-pink-600 flex items-center justify-center p-4">
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
      
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8 animate-fade-in">
          <div className="flex items-center justify-center mb-4">
            <Shield className="w-8 h-8 text-white mr-3" />
            <h1 className="text-3xl md:text-4xl font-bold text-white">
              Área Administrativa
            </h1>
          </div>
          <p className="text-white/90 text-lg">
            Faça login para acessar o painel de administração
          </p>
        </div>

        {/* Login Form */}
        <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-8 animate-fade-in">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-gradient-to-br from-primary to-primary-light rounded-full flex items-center justify-center mx-auto mb-4">
              <LogIn className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              Bem-vindo de volta
            </h2>
            <p className="text-gray-600">
              Entre com suas credenciais para continuar
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Username */}
            <div>
              <label className="form-label flex items-center">
                <User className="w-4 h-4 mr-2 text-gray-500" />
                Usuário
              </label>
              <input
                type="text"
                name="username"
                value={formData.username}
                onChange={handleInputChange}
                className="form-input"
                placeholder="Digite seu usuário"
                required
              />
            </div>

            {/* Password */}
            <div>
              <label className="form-label flex items-center">
                <Lock className="w-4 h-4 mr-2 text-gray-500" />
                Senha
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={formData.password}
                  onChange={handleInputChange}
                  className="form-input pr-12"
                  placeholder="Digite sua senha"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-gray-700 transition-colors"
                >
                  {showPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full text-lg py-4 hover-lift"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                  Entrando...
                </>
              ) : (
                <>
                  <LogIn className="w-5 h-5 mr-2" />
                  Entrar
                </>
              )}
            </button>
          </form>

          {/* Back to Home */}
          <div className="mt-6 text-center">
            <Link 
              to="/" 
              className="inline-flex items-center text-gray-600 hover:text-primary transition-colors"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Voltar ao Início
            </Link>
          </div>

          {/* Demo Credentials */}
          <div className="mt-8 p-4 bg-blue-50 rounded-lg">
            <h3 className="text-sm font-semibold text-blue-900 mb-2">
              💡 Credenciais de Demonstração:
            </h3>
            <div className="text-xs text-blue-800 space-y-1">
              <p><strong>Usuário:</strong> admin</p>
              <p><strong>Senha:</strong> admin123</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-white/70 text-sm">
            Sistema de Catálogo Inteligente
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login; 