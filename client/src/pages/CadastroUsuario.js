import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const CadastroUsuario = () => {
  const navigate = useNavigate();
  const [form, setForm] = useState({ nome: '', numero_colaborador: '', senha: '', senha2: '' });
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = e => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setStatus('');
    setMessage('');
    if (!form.nome || !form.numero_colaborador || !form.senha || !form.senha2) {
      setStatus('erro');
      setMessage('Preencha todos os campos.');
      return;
    }
    if (form.senha !== form.senha2) {
      setStatus('erro');
      setMessage('As senhas não coincidem.');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/cadastrar-usuario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: form.nome, numero_colaborador: form.numero_colaborador, senha: form.senha })
      });
      const data = await response.json();
      if (response.ok) {
        setStatus('sucesso');
        setMessage('Cadastro realizado com sucesso! Redirecionando para login...');
        setTimeout(() => navigate('/login'), 1800);
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

  return (
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-4 sm:py-12 px-2 sm:px-4">
      <div className="bg-white rounded-2xl shadow-lg border border-[#d1d5db] w-full max-w-[95vw] sm:max-w-[420px] p-4 sm:p-8 my-4 sm:my-10 flex flex-col items-center gap-4 sm:gap-6">
        <h1 className="text-[#0915FF] font-extrabold text-xl sm:text-2xl text-center m-0">Criar Conta</h1>
        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-3 sm:gap-4">
          <input name="nome" value={form.nome} onChange={handleChange} placeholder="Nome completo" required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
          <input name="numero_colaborador" value={form.numero_colaborador} onChange={handleChange} placeholder="Número de colaborador" required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
          <input name="senha" value={form.senha} onChange={handleChange} placeholder="Senha" type="password" required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
          <input name="senha2" value={form.senha2} onChange={handleChange} placeholder="Confirme a senha" type="password" required className="px-3 py-2 rounded-lg border border-[#d1d5db] text-sm sm:text-base w-full" />
          <button type="submit" disabled={loading} className="bg-[#0915FF] text-white font-bold rounded-lg py-2 sm:py-3 text-base sm:text-lg border-none shadow-md mt-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
            {loading ? 'Cadastrando...' : 'Criar Conta'}
          </button>
        </form>
        {status === 'sucesso' && <div className="text-green-500 font-semibold text-sm sm:text-base">{message}</div>}
        {status === 'erro' && <div className="text-red-500 font-semibold text-sm sm:text-base">{message}</div>}
      </div>
    </div>
  );
};

export default CadastroUsuario; 