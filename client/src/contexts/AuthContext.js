import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setIsAuthenticated(false);
      setUser(null);
      setLoading(false);
      return;
    }
    if (token) {
      try {
        const response = await fetch('/api/verify-token', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          setUser(data.user || data);
          setIsAuthenticated(true);
        } else {
          localStorage.removeItem('token');
          setIsAuthenticated(false);
          setUser(null);
        }
      } catch (error) {
        localStorage.removeItem('token');
        setIsAuthenticated(false);
        setUser(null);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (username, password) => {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        const data = await response.json();
        localStorage.setItem('token', data.token);
        setUser(data.user);
        setIsAuthenticated(true);
        return { success: true };
      } else {
        const text = await response.text();
        let data = {};
        try {
          data = JSON.parse(text);
        } catch (_) {
          // Resposta não é JSON (ex.: servidor caiu, página de erro em HTML)
          const fallback = response.status === 500
            ? 'Erro no servidor. Verifique variáveis de ambiente (DATABASE_URL, JWT_SECRET), migrações do banco e os logs do servidor.'
            : 'Erro no login';
          return { success: false, message: fallback };
        }
        const msg = data.error || data.message || (response.status === 500
          ? 'Erro no servidor. Verifique variáveis de ambiente e migrações do banco.'
          : 'Erro no login');
        return { success: false, message: msg };
      }
    } catch (error) {
      return { success: false, message: 'Erro de conexão. Verifique se o backend está no ar e a URL da API.' };
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    setUser(null);
  };

  const value = {
    isAuthenticated,
    user,
    loading,
    login,
    logout,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 