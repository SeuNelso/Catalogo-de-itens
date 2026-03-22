import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const CadastroUsuario = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const [form, setForm] = useState({
    nome: '',
    sobrenome: '',
    telemovel: '',
    numero_colaborador: '',
    email: '',
    username: '',
    senha: '',
    senha2: ''
  });
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

    if (user && user.role !== 'admin') {
      setStatus('erro');
      setMessage('Apenas administradores podem criar usuários.');
      setTimeout(() => navigate('/'), 2000);
    }
  }, [isAuthenticated, user, navigate]);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('');
    setMessage('');

    if (!user || user.role !== 'admin') {
      setStatus('erro');
      setMessage('Apenas administradores podem criar usuários.');
      return;
    }

    if (!form.nome?.trim() || !form.numero_colaborador?.trim()) {
      setStatus('erro');
      setMessage('Nome e número de colaborador são obrigatórios.');
      return;
    }

    const pwd = form.senha?.trim() ?? '';
    const pwd2 = form.senha2?.trim() ?? '';
    if (!pwd || !pwd2) {
      setStatus('erro');
      setMessage('A palavra-passe e a confirmação são obrigatórias.');
      return;
    }
    if (pwd !== pwd2) {
      setStatus('erro');
      setMessage('As duas palavras-passe devem ser iguais.');
      return;
    }

    setLoading(true);
    try {
      const body = {
        nome: form.nome.trim(),
        sobrenome: form.sobrenome.trim() || undefined,
        telemovel: form.telemovel.trim() || undefined,
        numero_colaborador: form.numero_colaborador.trim(),
        email: form.email.trim() || undefined,
        username: form.username.trim() || undefined,
        senha: pwd
      };

      const token = localStorage.getItem('token');
      const response = await fetch('/api/cadastrar-usuario', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setStatus('sucesso');
        let msg = data.message || 'Cadastro realizado com sucesso!';
        if (data.aviso) msg += ` ${data.aviso}`;
        setMessage(`${msg} Redirecionando para login...`);
        setTimeout(() => navigate('/login'), 2200);
      } else {
        setStatus('erro');
        setMessage(data.error || 'Erro ao cadastrar usuário.');
      }
    } catch (err) {
      setStatus('erro');
      setMessage('Erro de conexão.');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = 'px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full';

  return (
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-4 sm:py-12 px-2 sm:px-4">
      <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] w-full max-w-[95vw] sm:max-w-lg p-4 sm:p-8 my-4 sm:my-10 flex flex-col items-center gap-4 sm:gap-6">
        <h1 className="text-[#0915FF] font-extrabold text-xl sm:text-2xl text-center m-0">Criar utilizador</h1>
        {user && user.role === 'admin' ? (
          <form onSubmit={handleSubmit} className="w-full flex flex-col gap-3 sm:gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nome *</label>
                <input name="nome" value={form.nome} onChange={handleChange} placeholder="Nome próprio" required className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Sobrenome</label>
                <input name="sobrenome" value={form.sobrenome} onChange={handleChange} placeholder="Apelido(s)" className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Telemóvel</label>
              <input name="telemovel" value={form.telemovel} onChange={handleChange} placeholder="9xx xxx xxx" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Número de colaborador *</label>
              <input name="numero_colaborador" value={form.numero_colaborador} onChange={handleChange} placeholder="Ex.: 1128" required className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">E-mail</label>
              <input name="email" type="email" value={form.email} onChange={handleChange} placeholder="email@empresa.pt" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
              <input name="username" value={form.username} onChange={handleChange} placeholder="Se vazio, usa o nº colaborador" className={inputCls} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Palavra-passe *</label>
                <input
                  name="senha"
                  value={form.senha}
                  onChange={handleChange}
                  placeholder="Definir palavra-passe"
                  type="password"
                  required
                  minLength={1}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Confirmar palavra-passe *</label>
                <input
                  name="senha2"
                  value={form.senha2}
                  onChange={handleChange}
                  placeholder="Repetir palavra-passe"
                  type="password"
                  required
                  minLength={1}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <button type="submit" disabled={loading} className="bg-[#0915FF] text-white font-bold rounded-lg py-2 sm:py-3 text-base sm:text-lg border-none shadow-md mt-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
              {loading ? 'A cadastrar...' : 'Criar utilizador'}
            </button>
          </form>
        ) : (
          <div className="text-center">
            <p className="text-red-500 font-semibold text-sm sm:text-base mb-4">
              Acesso negado. Apenas administradores podem criar utilizadores.
            </p>
            <button
              onClick={() => navigate('/')}
              className="bg-[#0915FF] text-white font-bold rounded-lg py-2 px-4 text-sm sm:text-base border-none shadow-md transition-all"
            >
              Voltar ao início
            </button>
          </div>
        )}
        {status === 'sucesso' && <div className="text-green-600 font-semibold text-sm sm:text-base text-center">{message}</div>}
        {status === 'erro' && <div className="text-red-500 font-semibold text-sm sm:text-base text-center">{message}</div>}
      </div>
    </div>
  );
};

export default CadastroUsuario;
