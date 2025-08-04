import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate, Link } from 'react-router-dom';

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
    <div className="min-h-screen bg-[#f3f6fd] flex flex-col items-center justify-center py-4 sm:py-12 px-2 sm:px-4">
      <div className="w-full max-w-[98vw] sm:max-w-4xl bg-white rounded-2xl shadow-lg p-4 sm:p-8 mt-4 sm:mt-10">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 sm:mb-6 gap-4">
          <h2 className="font-extrabold text-xl sm:text-2xl text-[#0915FF]">Administração de Usuários</h2>
          <Link 
            to="/cadastro" 
            className="bg-[#0915FF] text-white font-bold rounded-lg px-4 py-2 text-sm sm:text-base shadow-md hover:bg-[#2336ff] transition-colors flex items-center gap-2"
          >
            <span>➕</span>
            Criar Novo Usuário
          </Link>
        </div>
        {loading ? (
          <div>Carregando usuários...</div>
        ) : error ? (
          <div className="text-red-500 font-semibold">{error}</div>
        ) : (
          <div className="space-y-4">
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto rounded-xl">
              <table className="min-w-full text-xs sm:text-base">
                <thead>
                  <tr className="bg-gradient-to-r from-[#0a1fff] to-[#3b82f6] text-white font-bold">
                    <th className="py-3 px-4 rounded-tl-xl">ID</th>
                    <th className="py-3 px-4">Nome</th>
                    <th className="py-3 px-4">Número Colaborador</th>
                    <th className="py-3 px-4">Username</th>
                    <th className="py-3 px-4">E-mail</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4 rounded-tr-xl">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {usuarios.map(u => (
                    <tr key={u.id} className="border-b border-[#e5e7eb]">
                      <td className="py-2 px-4">{u.id}</td>
                      <td className="py-2 px-4">{u.nome}</td>
                      <td className="py-2 px-4">{u.numero_colaborador || '-'}</td>
                      <td className="py-2 px-4">{u.username || '-'}</td>
                      <td className="py-2 px-4">{u.email || '-'}</td>
                      <td className="py-2 px-4">
                        <select value={u.role} onChange={e => handleRoleChange(u.id, e.target.value)} disabled={savingId === u.id} className="px-2 py-1 rounded border border-[#d1d5db] bg-white">
                          {roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </td>
                      <td className="py-2 px-4">
                        <button onClick={() => handleSaveRole(u.id, u.role)} disabled={savingId === u.id} className="bg-[#0915FF] text-white rounded px-4 py-1 font-semibold text-xs sm:text-base shadow hover:bg-[#2336ff] transition disabled:opacity-60 disabled:cursor-not-allowed">
                          {savingId === u.id ? 'Salvando...' : 'Salvar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden space-y-4">
              {usuarios.map(u => (
                <div key={u.id} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-gray-600">ID:</span>
                      <span className="text-sm">{u.id}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-gray-600">Nome:</span>
                      <span className="text-sm text-right">{u.nome}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-gray-600">Número:</span>
                      <span className="text-sm">{u.numero_colaborador || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-gray-600">Username:</span>
                      <span className="text-sm">{u.username || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-gray-600">E-mail:</span>
                      <span className="text-sm">{u.email || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-gray-600">Role:</span>
                      <select 
                        value={u.role} 
                        onChange={e => handleRoleChange(u.id, e.target.value)} 
                        disabled={savingId === u.id} 
                        className="px-3 py-1 rounded border border-gray-300 bg-white text-sm"
                      >
                        {roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>
                    <div className="pt-2">
                      <button 
                        onClick={() => handleSaveRole(u.id, u.role)} 
                        disabled={savingId === u.id} 
                        className="w-full bg-[#0915FF] text-white rounded-lg px-4 py-2 font-semibold text-sm shadow hover:bg-[#2336ff] transition disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {savingId === u.id ? 'Salvando...' : 'Salvar Alterações'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminUsuarios; 