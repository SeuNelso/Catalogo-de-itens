import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useNavigate, Link } from 'react-router-dom';
import { FaSearch, FaUser, FaPlus, FaPen, FaTimes } from 'react-icons/fa';
import { getRequisicoesArmazemOrigemIds } from '../utils/requisicoesArmazemOrigem';
import { ROLE_OPTIONS, roleLabel } from '../utils/roles';
import { filtrarArmazensCentrais } from '../utils/armazensRequisicaoOrigem';

function normalizeRow(u) {
  const ids = getRequisicoesArmazemOrigemIds(u);
  return { ...u, requisicoes_armazem_origem_ids: ids, pode_controlo_stock: Boolean(u.pode_controlo_stock) };
}

function nomeExibicao(u) {
  if (!u) return '—';
  const p = [u.nome, u.sobrenome].map((x) => (x != null ? String(x).trim() : '')).filter(Boolean);
  return p.join(' ') || u.nome || '—';
}

function trimEq(a, b) {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function buildDraftFromUser(u) {
  return {
    id: u.id,
    nome: u.nome != null ? String(u.nome) : '',
    sobrenome: u.sobrenome != null ? String(u.sobrenome) : '',
    telemovel: u.telemovel != null ? String(u.telemovel) : '',
    email: u.email != null ? String(u.email) : '',
    username: u.username != null ? String(u.username) : '',
    numero_colaborador: u.numero_colaborador != null ? String(u.numero_colaborador) : '',
    role: u.role,
    requisicoes_armazem_origem_ids: [...(u.requisicoes_armazem_origem_ids || [])],
    pode_controlo_stock: Boolean(u.pode_controlo_stock),
    nova_senha: '',
    nova_senha2: ''
  };
}

const AdminUsuarios = () => {
  const { user, isAuthenticated } = useAuth();
  const isAdmin = user && user.role === 'admin';
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [armazensCentrais, setArmazensCentrais] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  /** Cópia editável: perfil, role, armazéns e opcional nova senha */
  const [draft, setDraft] = useState(null);
  /** Só permite alterar campos após clicar em «Editar» */
  const [isEditing, setIsEditing] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    fetchUsuarios();
    // eslint-disable-next-line
  }, [isAuthenticated, user]);

  useEffect(() => {
    if (!isAuthenticated || !isAdmin) return;
    (async () => {
      try {
        const res = await fetch('/api/armazens?ativo=true', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data) ? filtrarArmazensCentrais(data) : [];
        setArmazensCentrais(list);
      } catch (_) {}
    })();
  }, [isAuthenticated, isAdmin]);

  const fetchUsuarios = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/usuarios', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.details || data.detalhes || 'Erro ao buscar usuários');
      }
      const data = await res.json();
      const rows = Array.isArray(data) ? data.map(normalizeRow) : [];
      setUsuarios(rows);
      if (rows.length === 1 && user && user.role !== 'admin') {
        const u = rows[0];
        setSelectedId(u.id);
        setDraft(buildDraftFromUser(u));
        setIsEditing(false);
      } else {
        setSelectedId((prev) => {
          if (prev == null) return null;
          return rows.some((r) => r.id === prev) ? prev : null;
        });
        setDraft((d) => {
          if (!d) return d;
          const u = rows.find((r) => r.id === d.id);
          if (!u) return null;
          return buildDraftFromUser(u);
        });
      }
    } catch (err) {
      setError(err.message || 'Erro ao buscar usuários');
    } finally {
      setLoading(false);
    }
  };

  const normalize = (v) => String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const usuariosFiltrados = useMemo(() => {
    const q = normalize(searchTerm.trim());
    return (usuarios || [])
      .filter((u) => {
        if (!q) return true;
        const hay = normalize([
          u.id,
          u.nome,
          u.sobrenome,
          u.telemovel,
          u.username,
          u.email,
          u.numero_colaborador,
          u.role,
          (u.requisicoes_armazem_origem_ids || []).join(' ')
        ].join(' '));
        return hay.includes(q);
      })
      .sort((a, b) =>
        nomeExibicao(a).localeCompare(nomeExibicao(b), 'pt', { sensitivity: 'base' })
      );
  }, [usuarios, searchTerm]);

  const selectedFromList = useMemo(
    () => (selectedId != null ? usuarios.find((u) => u.id === selectedId) : null),
    [usuarios, selectedId]
  );

  const selectUser = useCallback((u) => {
    if (!u) {
      setSelectedId(null);
      setDraft(null);
      setIsEditing(false);
      setSuccessMsg('');
      return;
    }
    setSelectedId(u.id);
    setDraft(buildDraftFromUser(u));
    setIsEditing(false);
    setSuccessMsg('');
  }, []);

  const toggleArmazemOrigem = (armazemId) => {
    if (!draft || !isEditing) return;
    setDraft((d) => {
      if (!d) return d;
      const ids = [...(d.requisicoes_armazem_origem_ids || [])];
      const i = ids.indexOf(armazemId);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(armazemId);
      ids.sort((a, b) => a - b);
      return { ...d, requisicoes_armazem_origem_ids: ids };
    });
  };

  const handleSave = async () => {
    if (!draft || !selectedFromList || !isEditing) return;
    const temPwd = Boolean(draft.nova_senha?.trim());
    const temPwd2 = Boolean(draft.nova_senha2?.trim());
    if (temPwd !== temPwd2 || (temPwd && draft.nova_senha !== draft.nova_senha2)) {
      setError('Para alterar a palavra-passe, preencha os dois campos igualmente.');
      return;
    }
    if (!draft.nome?.trim()) {
      setError('O nome é obrigatório.');
      return;
    }
    if (!draft.numero_colaborador?.trim()) {
      setError('O número de colaborador é obrigatório.');
      return;
    }
    if (!draft.username?.trim()) {
      setError('O username é obrigatório.');
      return;
    }
    setSavingId(draft.id);
    setError('');
    setSuccessMsg('');
    try {
      /** Campos alterados + role/ids (só admin pode enviar role e armazéns de requisições) */
      const body = {};
      if (isAdmin) {
        body.role = draft.role;
        body.requisicoes_armazem_origem_ids = draft.requisicoes_armazem_origem_ids || [];
        body.pode_controlo_stock = Boolean(draft.pode_controlo_stock);
      }
      if (!trimEq(draft.nome, selectedFromList.nome)) body.nome = draft.nome.trim();
      if (!trimEq(draft.sobrenome, selectedFromList.sobrenome)) {
        body.sobrenome = draft.sobrenome?.trim() || '';
      }
      if (!trimEq(draft.telemovel, selectedFromList.telemovel)) {
        body.telemovel = draft.telemovel?.trim() || '';
      }
      if (!trimEq(draft.email, selectedFromList.email)) body.email = draft.email?.trim() || '';
      if (!trimEq(draft.username, selectedFromList.username)) {
        body.username = draft.username.trim();
      }
      if (!trimEq(draft.numero_colaborador, selectedFromList.numero_colaborador)) {
        body.numero_colaborador = draft.numero_colaborador.trim();
      }
      if (temPwd) {
        body.nova_senha = draft.nova_senha;
      }
      const uid = Number(draft.id);
      const res = await fetch(`/api/usuarios/${uid}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg =
          data.error ||
          data.detalhes ||
          data.details ||
          data.message ||
          'Erro ao atualizar utilizador';
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      await fetchUsuarios();
      setIsEditing(false);
      setSuccessMsg('Alterações gravadas com sucesso.');
    } catch (err) {
      setError(err.message || 'Erro ao atualizar utilizador');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async () => {
    if (!isAdmin || !selectedFromList) return;
    const ok = await confirm({
      title: 'Tem a certeza?',
      message: `Vai excluir permanentemente o utilizador "${nomeExibicao(selectedFromList)}" (ID ${selectedFromList.id}). Esta ação não pode ser desfeita. Deseja continuar?`,
      confirmLabel: 'Sim, excluir',
      cancelLabel: 'Não, cancelar',
      variant: 'danger'
    });
    if (!ok) return;

    const id = selectedFromList.id;
    setDeletingId(id);
    setError('');
    try {
      const res = await fetch(`/api/usuarios/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = 'Erro ao excluir usuário';
        try {
          const errorData = JSON.parse(text);
          msg = errorData.error || errorData.message || errorData.details || msg;
        } catch (_) {
          if (text.includes('<!DOCTYPE')) {
            msg = 'O servidor devolveu HTML em vez de JSON — confirme que a API está atualizada (rota DELETE /api/usuarios).';
          } else if (text.trim()) {
            msg = text.slice(0, 240);
          }
        }
        throw new Error(msg);
      }
      setUsuarios((prev) => prev.filter((u) => u.id !== id));
      selectUser(null);
    } catch (err) {
      setError(err.message || 'Erro ao excluir usuário');
    } finally {
      setDeletingId(null);
    }
  };

  const hasChanges =
    draft &&
    selectedFromList &&
    (draft.nome.trim() !== String(selectedFromList.nome || '').trim() ||
      String(draft.sobrenome || '').trim() !== String(selectedFromList.sobrenome || '').trim() ||
      String(draft.telemovel || '').trim() !== String(selectedFromList.telemovel || '').trim() ||
      String(draft.email || '').trim() !== String(selectedFromList.email || '').trim() ||
      String(draft.username || '').trim() !== String(selectedFromList.username || '').trim() ||
      String(draft.numero_colaborador || '').trim() !== String(selectedFromList.numero_colaborador || '').trim() ||
      Boolean(draft.nova_senha?.trim()) ||
      (isAdmin &&
        (draft.role !== selectedFromList.role ||
          Boolean(draft.pode_controlo_stock) !== Boolean(selectedFromList.pode_controlo_stock) ||
          JSON.stringify([...(draft.requisicoes_armazem_origem_ids || [])].sort()) !==
            JSON.stringify([...(selectedFromList.requisicoes_armazem_origem_ids || [])].sort()))));

  /** Lista só para admin ou quando há mais do que um registo (caso raro) */
  const showUserList = isAdmin || usuarios.length > 1;
  const pageTitle = isAdmin ? 'Utilizadores' : 'Meu perfil';
  const pageSubtitle = isAdmin
    ? 'Selecione um utilizador na lista para alterar perfil e armazéns de requisições'
    : 'Consulte e edite os seus dados de perfil.';

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto" />
          <p className="mt-4 text-gray-600">Carregando utilizadores...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">{pageTitle}</h1>
            <p className="text-gray-600">{pageSubtitle}</p>
          </div>
          {isAdmin && (
            <Link
              to="/cadastro"
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors font-semibold"
            >
              <FaPlus />
              Criar utilizador
            </Link>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm font-medium border border-red-200">
            {error}
          </div>
        )}
        {successMsg && (
          <div className="mb-4 p-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm font-medium border border-emerald-200">
            {successMsg}
          </div>
        )}

        <div className={`grid grid-cols-1 gap-4 lg:gap-6 items-start ${showUserList ? 'lg:grid-cols-12' : ''}`}>
          {/* Lista — admin ou vários registos */}
          {showUserList && (
          <div className="lg:col-span-5 xl:col-span-4 bg-white rounded-lg shadow-sm overflow-hidden border border-gray-100">
            <div className="p-4 border-b border-gray-100 bg-gray-50">
              <div className="relative">
                <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar por nome, email, número, role..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent text-sm"
                />
              </div>
              <p className="mt-2 text-xs text-gray-600">
                {usuariosFiltrados.length} utilizador(es)
              </p>
            </div>
            <div className="max-h-[min(70vh,560px)] overflow-auto">
              {usuariosFiltrados.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-sm">
                  Nenhum utilizador encontrado
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {usuariosFiltrados.map((u) => {
                    const selected = selectedId === u.id;
                    const nArm = (u.requisicoes_armazem_origem_ids || []).length;
                    return (
                      <li key={u.id}>
                        <button
                          type="button"
                          onClick={() => selectUser(u)}
                          className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${
                            selected ? 'bg-blue-50 border-l-4 border-l-[#0915FF]' : 'hover:bg-gray-50 border-l-4 border-l-transparent'
                          }`}
                        >
                          <FaUser className={`mt-0.5 shrink-0 ${selected ? 'text-[#0915FF]' : 'text-gray-400'}`} />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-gray-900 truncate">
                              {nomeExibicao(u)}
                            </div>
                            <div className="text-xs text-gray-500 truncate">{u.email || u.username || `ID ${u.id}`}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 max-w-[14rem] truncate"
                                title={u.role ? `role na base: ${u.role}` : undefined}
                              >
                                {roleLabel(u.role)}
                              </span>
                              {nArm > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">
                                  {nArm} armazém(ns) req.
                                </span>
                              )}
                              {u.pode_controlo_stock && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900">
                                  Stock
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          )}

          {/* Painel de edição — alinhado ao painel direito das localizações */}
          <div
            className={`bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden ${
              showUserList ? 'lg:col-span-7 xl:col-span-8' : 'lg:col-span-12'
            }`}
          >
            {!selectedFromList || !draft || draft.id !== selectedFromList.id ? (
              <div className="p-10 text-center text-gray-500">
                <FaUser className="mx-auto text-4xl text-gray-300 mb-4" />
                <p className="text-lg font-medium text-gray-700">Selecione um utilizador</p>
                <p className="text-sm mt-2 max-w-md mx-auto">
                  Clique num nome na lista à esquerda para ver e alterar o perfil e os armazéns centrais de origem das requisições.
                </p>
              </div>
            ) : (
              <div className="p-5 sm:p-6">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6 pb-4 border-b border-gray-100">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {nomeExibicao({ nome: draft.nome, sobrenome: draft.sobrenome })}
                    </h2>
                    <p className="text-sm text-gray-500">ID #{selectedFromList.id}</p>
                    {!isEditing && (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5 mt-2 inline-block">
                        Modo consulta. Clique em «Editar» para alterar dados.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0 justify-end">
                    {isEditing ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(buildDraftFromUser(selectedFromList));
                          setIsEditing(false);
                          setError('');
                          setSuccessMsg('');
                        }}
                        disabled={savingId === draft.id}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium disabled:opacity-50"
                      >
                        <FaTimes />
                        Cancelar edição
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditing(true);
                          setSuccessMsg('');
                          setError('');
                        }}
                        disabled={deletingId === selectedFromList.id}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0915FF] text-white hover:bg-[#070FCC] text-sm font-semibold disabled:opacity-50"
                      >
                        <FaPen />
                        Editar
                      </button>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deletingId === selectedFromList.id || isEditing}
                        className="px-4 py-2 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 text-sm font-medium disabled:opacity-50"
                        title={isEditing ? 'Guarde ou cancele a edição antes de excluir' : undefined}
                      >
                        {deletingId === selectedFromList.id ? 'A excluir…' : 'Excluir utilizador'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Nome *</label>
                    <input
                      value={draft.nome}
                      onChange={(e) => setDraft((d) => (d ? { ...d, nome: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      readOnly={!isEditing}
                      className={`w-full text-sm rounded-lg px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 text-gray-800 cursor-default' : 'bg-white'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Sobrenome</label>
                    <input
                      value={draft.sobrenome}
                      onChange={(e) => setDraft((d) => (d ? { ...d, sobrenome: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      readOnly={!isEditing}
                      className={`w-full text-sm rounded-lg px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 cursor-default' : 'bg-white'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Telemóvel</label>
                    <input
                      value={draft.telemovel}
                      onChange={(e) => setDraft((d) => (d ? { ...d, telemovel: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      readOnly={!isEditing}
                      className={`w-full text-sm rounded-lg px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 cursor-default' : 'bg-white'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">N.º colaborador *</label>
                    <input
                      value={draft.numero_colaborador}
                      onChange={(e) => setDraft((d) => (d ? { ...d, numero_colaborador: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      readOnly={!isEditing}
                      className={`w-full text-sm rounded-lg px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 cursor-default' : 'bg-white'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Username *</label>
                    <input
                      value={draft.username}
                      onChange={(e) => setDraft((d) => (d ? { ...d, username: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      readOnly={!isEditing}
                      className={`w-full text-sm rounded-lg px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 cursor-default' : 'bg-white'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">E-mail</label>
                    <input
                      type="email"
                      value={draft.email}
                      onChange={(e) => setDraft((d) => (d ? { ...d, email: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      readOnly={!isEditing}
                      className={`w-full text-sm rounded-lg px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 cursor-default' : 'bg-white'
                      }`}
                    />
                  </div>
                </div>

                {!isAdmin && selectedFromList && (
                  <p className="text-sm text-gray-600 mb-4">
                    Perfil atribuído:{' '}
                    <span className="font-medium text-gray-800">
                      {ROLE_OPTIONS.find((r) => r.value === draft.role)?.label || draft.role}
                    </span>
                    {' '}(apenas um administrador pode alterar)
                    <span className="block mt-2 text-gray-500">
                      Controlo de stock (consulta/gestão por localização):{' '}
                      <span className="font-medium text-gray-800">
                        {selectedFromList.pode_controlo_stock ? 'Ativo' : 'Inativo'}
                      </span>
                      {' '}
                      — definido pelo administrador.
                    </span>
                  </p>
                )}

                {isEditing && (
                  <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50/80 p-4">
                    <label className="block text-sm font-medium text-gray-800 mb-2">Nova palavra-passe (opcional)</label>
                    <p className="text-xs text-gray-600 mb-3">
                      {isAdmin
                        ? 'Só preencha se quiser redefinir a palavra-passe deste utilizador.'
                        : 'Só preencha se quiser alterar a sua palavra-passe.'}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Nova palavra-passe"
                        value={draft.nova_senha}
                        onChange={(e) => setDraft((d) => (d ? { ...d, nova_senha: e.target.value } : d))}
                        disabled={savingId === draft.id}
                        className="w-full text-sm rounded-lg px-3 py-2 border border-gray-300 bg-white"
                      />
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Confirmar"
                        value={draft.nova_senha2}
                        onChange={(e) => setDraft((d) => (d ? { ...d, nova_senha2: e.target.value } : d))}
                        disabled={savingId === draft.id}
                        className="w-full text-sm rounded-lg px-3 py-2 border border-gray-300 bg-white"
                      />
                    </div>
                  </div>
                )}

                {isAdmin && (
                  <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Perfil (role)</label>
                    <select
                      value={draft.role}
                      onChange={(e) => setDraft((d) => (d ? { ...d, role: e.target.value } : d))}
                      disabled={!isEditing || savingId === draft.id}
                      className={`w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] ${
                        !isEditing ? 'bg-gray-50 cursor-default text-gray-800' : 'bg-white'
                      }`}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {isAdmin && (
                  <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Requisições — armazéns de origem
                    </label>
                    <p className="text-xs text-gray-500 mb-3">
                      Utilizadores que não são admin/controller só veem requisições cuja origem (armazém central) está nesta lista. Vazio = sem filtro extra.
                    </p>
                    <div className="rounded-lg border border-gray-200 bg-gray-50/80 max-h-56 overflow-y-auto p-3 space-y-2">
                      {armazensCentrais.length === 0 ? (
                        <p className="text-sm text-gray-400">Nenhum armazém central ativo. Crie ou ative armazéns com tipo «central».</p>
                      ) : (
                        armazensCentrais.map((a) => (
                          <label
                            key={a.id}
                            className="flex items-center gap-3 text-sm cursor-pointer py-1.5 px-2 rounded hover:bg-white/80"
                          >
                            <input
                              type="checkbox"
                              className="rounded border-gray-300 text-[#0915FF] focus:ring-[#0915FF]"
                              checked={(draft.requisicoes_armazem_origem_ids || []).includes(a.id)}
                              onChange={() => toggleArmazemOrigem(a.id)}
                              disabled={!isEditing || savingId === draft.id}
                            />
                            <span>{a.codigo ? `${a.codigo} — ${a.descricao}` : a.descricao}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {isAdmin && (
                  <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50/90 p-4">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1 rounded border-gray-300 text-[#0915FF] focus:ring-[#0915FF]"
                        checked={Boolean(draft.pode_controlo_stock)}
                        onChange={(e) =>
                          setDraft((d) => (d ? { ...d, pode_controlo_stock: e.target.checked } : d))
                        }
                        disabled={!isEditing || savingId === draft.id}
                      />
                      <span>
                        <span className="block text-sm font-medium text-gray-800">
                          Acesso a controlo de stock
                        </span>
                        <span className="block text-xs text-gray-600 mt-1">
                          Permite consultar e gerir quantidades por localização nos armazéns centrais (menu Consulta /
                          Localizações e stock, e botão de stock na lista de armazéns). Apenas administradores podem
                          alterar esta opção.
                        </span>
                      </span>
                    </label>
                  </div>
                )}

                {isEditing && (
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={savingId === draft.id || !hasChanges}
                      className="inline-flex items-center justify-center px-6 py-2.5 rounded-lg bg-[#0915FF] text-white font-semibold hover:bg-[#070FCC] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingId === draft.id ? 'A gravar…' : 'Gravar alterações'}
                    </button>
                    <button
                      type="button"
                      onClick={() => selectedFromList && setDraft(buildDraftFromUser(selectedFromList))}
                      disabled={savingId === draft.id || !hasChanges}
                      className="px-6 py-2.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Repor alterações
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminUsuarios;
