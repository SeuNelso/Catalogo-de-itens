import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

const CadastrarUsuario = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ nome: '', username: '', email: '', password: '', role: 'controller' });
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  if (!user || user.role !== 'admin') {
    return <div style={{ color: '#ef4444', textAlign: 'center', marginTop: 40 }}>Acesso restrito a administradores.</div>;
  }

  const handleChange = e => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setStatus('');
    setMessage('');
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/usuarios', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (response.ok) {
        setStatus('sucesso');
        setMessage('Usuário cadastrado com sucesso!');
        setForm({ nome: '', username: '', email: '', password: '', role: 'controller' });
        setTimeout(() => navigate('/'), 1500);
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
        <h1 style={{ color: '#0915FF', fontWeight: 800, fontSize: 26, textAlign: 'center', margin: 0 }}>Cadastrar Usuário</h1>
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input name="nome" value={form.nome} onChange={handleChange} placeholder="Nome completo" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <input name="username" value={form.username} onChange={handleChange} placeholder="Username" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <input name="email" value={form.email} onChange={handleChange} placeholder="Email" type="email" style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <input name="password" value={form.password} onChange={handleChange} placeholder="Senha" type="password" required style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }} />
          <select name="role" value={form.role} onChange={handleChange} style={{ padding: 10, borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 16 }}>
            <option value="controller">Controller</option>
            <option value="admin">Administrador</option>
          </select>
          <button type="submit" disabled={loading} style={{ background: '#0915FF', color: '#fff', fontWeight: 700, borderRadius: 10, padding: '12px 0', fontSize: 17, border: 'none', boxShadow: '0 2px 8px rgba(9,21,255,0.10)', cursor: loading ? 'not-allowed' : 'pointer', marginTop: 8 }}>
            {loading ? 'Cadastrando...' : 'Cadastrar Usuário'}
          </button>
        </form>
        {status === 'sucesso' && <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 16 }}>{message}</div>}
        {status === 'erro' && <div style={{ color: '#ef4444', fontWeight: 600, fontSize: 16 }}>{message}</div>}
      </div>
    </div>
  );
};

export default CadastrarUsuario; 