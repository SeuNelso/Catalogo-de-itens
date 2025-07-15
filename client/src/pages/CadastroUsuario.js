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
    <div className="min-h-screen bg-[#e5eefe] flex flex-col items-center justify-center py-12 px-4">
      <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 8px 32px rgba(9,21,255,0.08)', border: '1.5px solid #d1d5db', maxWidth: 420, width: '100%', padding: 36, margin: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
        <h1 style={{ color: '#0915FF', fontWeight: 800, fontSize: 26, textAlign: 'center', margin: 0 }}>Criar Conta</h1>
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input name="nome" value={form.nome} onChange={handleChange} placeholder="Nome completo" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <input name="numero_colaborador" value={form.numero_colaborador} onChange={handleChange} placeholder="Número de colaborador" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <input name="senha" value={form.senha} onChange={handleChange} placeholder="Senha" type="password" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <input name="senha2" value={form.senha2} onChange={handleChange} placeholder="Confirme a senha" type="password" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <button type="submit" disabled={loading} style={{ background: '#0915FF', color: '#fff', fontWeight: 700, borderRadius: 10, padding: '12px 0', fontSize: 17, border: 'none', boxShadow: '0 2px 8px rgba(9,21,255,0.10)', cursor: loading ? 'not-allowed' : 'pointer', marginTop: 8 }}>
            {loading ? 'Cadastrando...' : 'Criar Conta'}
          </button>
        </form>
        {status === 'sucesso' && <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 16 }}>{message}</div>}
        {status === 'erro' && <div style={{ color: '#ef4444', fontWeight: 600, fontSize: 16 }}>{message}</div>}
      </div>
    </div>
  );
};

export default CadastroUsuario; 