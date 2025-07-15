import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

const roles = [
  { value: 'admin', label: 'Administrador' },
  { value: 'controller', label: 'Controller' },
  { value: 'basico', label: 'Básico' }
];

const AdminUsuarios = () => {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    if (!isAuthenticated || user.role !== 'admin') {
      navigate('/');
      return;
    }
    fetchUsuarios();
    // eslint-disable-next-line
  }, [isAuthenticated, user]);

  const fetchUsuarios = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/usuarios', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      if (!res.ok) throw new Error('Erro ao buscar usuários');
      const data = await res.json();
      setUsuarios(data);
    } catch (err) {
      setError(err.message || 'Erro ao buscar usuários');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = (id, newRole) => {
    setUsuarios(usuarios.map(u => u.id === id ? { ...u, role: newRole } : u));
  };

  const handleSaveRole = async (id, role) => {
    setSavingId(id);
    setError('');
    try {
      const res = await fetch(`/api/usuarios/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ role })
      });
      if (!res.ok) throw new Error('Erro ao atualizar role');
      await fetchUsuarios();
    } catch (err) {
      setError(err.message || 'Erro ao atualizar role');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', background: '#fff', borderRadius: 16, boxShadow: '0 4px 24px #2336ff11', padding: 32 }}>
      <h2 style={{ fontWeight: 800, fontSize: 28, color: '#0915FF', marginBottom: 24 }}>Administração de Usuários</h2>
      {loading ? (
        <div>Carregando usuários...</div>
      ) : error ? (
        <div style={{ color: '#ef4444', fontWeight: 600 }}>{error}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 16 }}>
          <thead>
            <tr style={{ background: '#f3f4fa' }}>
              <th style={{ padding: 10, borderRadius: 8  }}>ID</th>
              <th style={{ padding: 10 }}>Nome</th>
              <th style={{ padding: 10 }}>Número Colaborador</th>
              <th style={{ padding: 10 }}>Username</th>
              <th style={{ padding: 10 }}>E-mail</th>
              <th style={{ padding: 10 }}>Role</th>
              <th style={{ padding: 10 }}>Ação</th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: 8 }}>{u.id}</td>
                <td style={{ padding: 8 }}>{u.nome}</td>
                <td style={{ padding: 8 }}>{u.numero_colaborador || '-'}</td>
                <td style={{ padding: 8 }}>{u.username || '-'}</td>
                <td style={{ padding: 8 }}>{u.email || '-'}</td>
                <td style={{ padding: 8 }}>
                  <select value={u.role} onChange={e => handleRoleChange(u.id, e.target.value)} disabled={savingId === u.id} style={{ padding: 6, borderRadius: 6, border: '1px solid #d1d5db' }}>
                    {roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: 8 }}>
                  <button onClick={() => handleSaveRole(u.id, u.role)} disabled={savingId === u.id} style={{ background: '#0915FF', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', fontWeight: 600, cursor: savingId === u.id ? 'not-allowed' : 'pointer' }}>
                    {savingId === u.id ? 'Salvando...' : 'Salvar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default AdminUsuarios; 