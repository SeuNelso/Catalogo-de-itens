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
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const [fieldError, setFieldError] = useState('');

  React.useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
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
          navigate('/cadastrar');
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
    <div className="min-h-screen flex items-center justify-center p-4" style={{
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #ff6cab 100%)',
      transition: 'background 0.5s',
      position: 'relative'
    }}>
      {toast && (
        <div style={{
          position: 'absolute',
          top: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          minWidth: 220,
          maxWidth: 320,
          padding: '8px 18px',
          borderRadius: 8,
          background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
          color: toast.type === 'success' ? '#15803d' : '#b91c1c',
          fontWeight: 600,
          fontSize: 14,
          boxShadow: '0 2px 8px rgba(9,21,255,0.08)',
          textAlign: 'center',
          pointerEvents: 'none',
        }}>
          {toast.message}
        </div>
      )}
      <div style={{
        width: '100%',
        maxWidth: isMobile ? 380 : 420,
        margin: '0 auto',
        borderRadius: 28,
        background: 'rgba(255,255,255,0.18)',
        boxShadow: '0 8px 32px 0 rgba(76,99,255,0.18)',
        backdropFilter: 'blur(16px)',
        border: '1.5px solid rgba(255,255,255,0.25)',
        padding: isMobile ? 18 : 36,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        animation: 'fadeIn 0.7s',
        gap: isMobile ? 18 : 28
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: isMobile ? 18 : 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
            <Shield style={{ width: 36, height: 36, color: '#fff', marginRight: 10, filter: 'drop-shadow(0 2px 8px #0915FF)' }} />
            <h1 style={{ fontSize: isMobile ? 26 : 32, fontWeight: 800, color: '#fff', textShadow: '0 2px 8px #2336ff' }}>Área Administrativa</h1>
          </div>
          <p style={{ color: '#f3f4fa', fontSize: isMobile ? 15 : 18, margin: 0, opacity: 0.92 }}>Faça login para acessar o painel de administração</p>
        </div>
        {/* Login Form */}
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 20 }}>
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <div style={{ width: 60, height: 60, background: 'linear-gradient(135deg, #0915FF, #764ba2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px auto', boxShadow: '0 2px 8px #2336ff' }}>
              <LogIn style={{ width: 32, height: 32, color: '#fff' }} />
            </div>
            <h2 style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, color: '#0915FF', margin: 0 }}>Bem-vindo de volta</h2>
            <p style={{ color: '#555', fontSize: isMobile ? 13 : 15, margin: 0 }}>Entre com suas credenciais para continuar</p>
          </div>
          {/* Username */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', color: '#0915FF', fontWeight: 600, marginBottom: 4, fontSize: 15 }}>
              <User style={{ width: 18, height: 18, marginRight: 6, color: '#2336ff' }} /> Usuário
            </label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleInputChange}
              style={{
                width: '100%',
                border: '2px solid #d1d5db',
                borderRadius: 10,
                padding: '12px 16px',
                fontSize: 15,
                outline: 'none',
                transition: 'border 0.2s, box-shadow 0.2s',
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 1px 4px rgba(9,21,255,0.04)'
              }}
              placeholder="Digite seu usuário"
              required
              onFocus={e => e.target.style.border = '2px solid #0915FF'}
              onBlur={e => e.target.style.border = '2px solid #d1d5db'}
            />
          </div>
          {/* Password */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', color: '#0915FF', fontWeight: 600, marginBottom: 4, fontSize: 15 }}>
              <Lock style={{ width: 18, height: 18, marginRight: 6, color: '#2336ff' }} /> Senha
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={formData.password}
                onChange={e => {
                  handleInputChange(e);
                  if (fieldError) setFieldError('');
                }}
                style={{
                  width: '100%',
                  border: '2px solid #d1d5db',
                  borderRadius: 10,
                  padding: '12px 16px',
                  fontSize: 15,
                  outline: 'none',
                  transition: 'border 0.2s, box-shadow 0.2s',
                  background: 'rgba(255,255,255,0.95)',
                  boxShadow: '0 1px 4px rgba(9,21,255,0.04)',
                  paddingRight: 44
                }}
                placeholder="Digite sua senha"
                required
                onFocus={e => e.target.style.border = '2px solid #0915FF'}
                onBlur={e => e.target.style.border = '2px solid #d1d5db'}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#2336ff', cursor: 'pointer', padding: 0 }}
              >
                {showPassword ? (
                  <EyeOff style={{ width: 22, height: 22 }} />
                ) : (
                  <Eye style={{ width: 22, height: 22 }} />
                )}
              </button>
            </div>
            {fieldError && (
              <div style={{ color: '#ef4444', fontSize: 13, marginTop: 4, marginLeft: 2 }}>{fieldError}</div>
            )}
          </div>
          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              background: 'linear-gradient(90deg, #0915FF 60%, #764ba2 100%)',
              color: '#fff',
              fontWeight: 700,
              borderRadius: 12,
              padding: '14px 0',
              fontSize: 17,
              border: 'none',
              boxShadow: '0 2px 8px rgba(9,21,255,0.10)',
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              marginTop: 8,
              transition: 'background 0.2s, color 0.2s'
            }}
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                Entrando...
              </>
            ) : (
              <>
                <LogIn style={{ width: 22, height: 22, marginRight: 6 }} />
                Entrar
              </>
            )}
          </button>
        </form>
        {/* Back to Home */}
        <div style={{ marginTop: 18, textAlign: 'center' }}>
          <Link 
            to="/" 
            style={{ color: '#2336ff', fontWeight: 600, fontSize: 15, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <ArrowLeft style={{ width: 18, height: 18 }} />
            Voltar ao Início
          </Link>
        </div>
        {/* Demo Credentials */}
        <div style={{ marginTop: 24, padding: 12, background: 'rgba(9,21,255,0.07)', borderRadius: 10, width: '100%' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0915FF', marginBottom: 6 }}>💡 Credenciais de Demonstração:</h3>
          <div style={{ fontSize: 13, color: '#2336ff', lineHeight: 1.6 }}>
            <p><strong>Usuário:</strong> admin</p>
            <p><strong>Senha:</strong> admin123</p>
          </div>
        </div>
        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <p style={{ color: '#fff', opacity: 0.7, fontSize: 13, margin: 0 }}>Sistema de Catálogo Inteligente</p>
        </div>
      </div>
    </div>
  );
};

export default Login; 