import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import Toast from '../components/Toast';
import { FaPlus, FaEdit, FaTrash, FaWarehouse, FaMapMarkerAlt, FaChevronDown, FaChevronUp } from 'react-icons/fa';
import axios from 'axios';

const Armazens = () => {
  const [armazens, setArmazens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const [formData, setFormData] = useState({
    codigo: '',
    descricao: '',
    tipo: 'viatura', // 'central' | 'viatura'
    localizacoes: []  // central: [{ localizacao, tipo_localizacao }]; viatura: preenchido com 2 (normal, FERR)
  });
  const [submitting, setSubmitting] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const { user } = useAuth();
  const confirm = useConfirm();
  const isAdmin = user && user.role === 'admin';

  useEffect(() => {
    fetchArmazens();
  }, []);

  const fetchArmazens = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/armazens', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      setArmazens(response.data || []);
    } catch (error) {
      console.error('Erro ao buscar armazéns:', error);
      setToast({ type: 'error', message: 'Erro ao carregar armazéns' });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.codigo.trim()) {
      setToast({ type: 'error', message: 'O código é obrigatório (ex: V848 ou E)' });
      return;
    }
    if (!formData.descricao.trim()) {
      setToast({ type: 'error', message: 'A descrição é obrigatória (ex: BBCH06)' });
      return;
    }
    const locsCentrais = (formData.localizacoes || [])
      .filter(l => (l.localizacao || '').trim())
      .map(l => {
        const loc = (l.localizacao || '').trim();
        const tipoLoc = (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal';
        return { localizacao: loc, tipo_localizacao: tipoLoc };
      });
    const payload = {
      codigo: formData.codigo.trim(),
      descricao: formData.descricao.trim(),
      tipo: formData.tipo,
      localizacoes: formData.tipo === 'viatura'
        ? [
            { localizacao: formData.codigo.trim().toUpperCase(), tipo_localizacao: 'normal' },
            { localizacao: formData.codigo.trim().toUpperCase() + '.FERR', tipo_localizacao: 'FERR' }
          ]
        : locsCentrais
    };
    if (formData.tipo === 'central') {
      const hasRecebimento = payload.localizacoes.some(l => l.tipo_localizacao === 'recebimento');
      const hasExpedicao = payload.localizacoes.some(l => l.tipo_localizacao === 'expedicao');
      if (!hasRecebimento || !hasExpedicao) {
        setToast({ type: 'error', message: 'Armazém central deve ter pelo menos uma localização de Recebimento e uma ou mais de Expedição.' });
        return;
      }
    }

    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');
      const config = {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      };

      if (editandoId) {
        await axios.put(`/api/armazens/${editandoId}`, payload, config);
        setToast({ type: 'success', message: 'Armazém atualizado com sucesso!' });
      } else {
        const res = await axios.post('/api/armazens', payload, config);
        setToast({
          type: res.data?.warning ? 'error' : 'success',
          message: res.data?.warning || 'Armazém criado com sucesso!'
        });
      }

      setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [] });
      setEditandoId(null);
      setMostrarForm(false);
      fetchArmazens();
    } catch (error) {
      const data = error.response?.data;
      let msg = data?.error || 'Erro ao salvar armazém';
      if (data?.details) msg += ': ' + data.details;
      setToast({ type: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (armazem) => {
    const requestedId = armazem?.id;
    if (requestedId == null) {
      setToast({ type: 'error', message: 'Armazém sem ID. Recarregue a lista.' });
      return;
    }
    setEditandoId(null);
    setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [] });
    setLoadingEdit(true);
    setMostrarForm(true);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`/api/armazens/${requestedId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = response.data;
      if (data.id != null && String(data.id) !== String(requestedId)) {
        setMostrarForm(false);
        return;
      }
      const locs = (data.localizacoes || []).map(l => {
        let locStr = '';
        let tipoLoc = 'normal';
        if (typeof l === 'object' && l !== null) {
          locStr = (l.localizacao != null) ? String(l.localizacao).trim() : '';
          tipoLoc = (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal';
        } else if (typeof l === 'string') {
          const trimmed = l.trim();
          if (trimmed.startsWith('{')) {
            try {
              const parsed = JSON.parse(trimmed);
              locStr = (parsed.localizacao != null) ? String(parsed.localizacao).trim() : trimmed;
              tipoLoc = (parsed.tipo_localizacao === 'recebimento' || parsed.tipo_localizacao === 'expedicao' || parsed.tipo_localizacao === 'FERR') ? parsed.tipo_localizacao : 'normal';
            } catch (_) {
              locStr = trimmed;
            }
          } else {
            locStr = trimmed;
            tipoLoc = trimmed.toUpperCase().includes('.FERR') ? 'FERR' : 'normal';
          }
        }
        return { localizacao: locStr, tipo_localizacao: tipoLoc };
      }).filter(l => l.localizacao !== '');
      if (data.localizacao && !locs.length) locs.push({ localizacao: String(data.localizacao).trim(), tipo_localizacao: 'normal' });
      const tipoFromApi = (data.tipo === 'central' || data.tipo === 'viatura') ? data.tipo : null;
      const hasRecebimentoOuExpedicao = locs.some(l => l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao');
      const tipo = tipoFromApi ?? (locs.length > 2 || hasRecebimentoOuExpedicao ? 'central' : 'viatura');
      setFormData({
        codigo: data.codigo || '',
        descricao: data.descricao || '',
        tipo,
        localizacoes: tipo === 'central' ? (locs.length > 0 ? locs : [{ localizacao: '', tipo_localizacao: 'normal' }]) : locs
      });
      setEditandoId(data.id);
    } catch (error) {
      console.error('Erro ao carregar armazém:', error);
      setToast({ type: 'error', message: 'Erro ao carregar dados do armazém' });
      setMostrarForm(false);
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleCancel = () => {
    setFormData({ codigo: '', descricao: '', tipo: 'viatura', localizacoes: [] });
    setEditandoId(null);
    setMostrarForm(false);
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Excluir armazém',
      message: 'Tem certeza que deseja excluir este armazém?',
      variant: 'danger'
    });
    if (!ok) return;

    try {
      const token = localStorage.getItem('token');
      await axios.delete(`/api/armazens/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      setToast({ type: 'success', message: 'Armazém excluído com sucesso' });
      fetchArmazens();
    } catch (error) {
      const msg = error.response?.data?.error || 'Erro ao excluir armazém';
      setToast({ type: 'error', message: msg });
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto" />
          <p className="mt-4 text-gray-600">Carregando armazéns...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Armazéns</h1>
            <p className="text-gray-600">Cadastre e gerencie os armazéns de destino das requisições</p>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                handleCancel();
                setMostrarForm(!mostrarForm);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors"
            >
              <FaPlus />
              {mostrarForm ? 'Cancelar' : 'Novo Armazém'}
            </button>
          )}
        </div>

        {isAdmin && mostrarForm && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
            {loadingEdit ? (
              <div className="flex items-center gap-2 text-gray-600 py-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#0915FF]" />
                Carregando dados do armazém...
              </div>
            ) : (
            <>
            <h2 className="text-lg font-semibold text-gray-800 mb-4">
              {editandoId ? 'Editar Armazém' : 'Criar Armazém'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tipo de armazém <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="viatura"
                      checked={formData.tipo === 'viatura'}
                      onChange={() => setFormData(prev => ({ ...prev, tipo: 'viatura', localizacoes: [] }))}
                      className="text-[#0915FF]"
                    />
                    <span>Viatura</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="tipo"
                      value="central"
                      checked={formData.tipo === 'central'}
                      onChange={() => setFormData(prev => ({
                        ...prev,
                        tipo: 'central',
                        localizacoes: prev.localizacoes.length ? prev.localizacoes : [{ localizacao: '', tipo_localizacao: 'normal' }]
                      }))}
                      className="text-[#0915FF]"
                    />
                    <span>Central</span>
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Viatura: 2 localizações (uma .FERR). Central: várias localizações, com Recebimento e Expedição.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Código <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="codigo"
                  value={formData.codigo}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  placeholder={formData.tipo === 'viatura' ? 'Ex: V848' : 'Ex: E'}
                />
                <p className="mt-1 text-xs text-gray-500">Código do armazém (ex: V848 para viatura, E para central)</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Descrição <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="descricao"
                  value={formData.descricao}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  placeholder="Ex: BBCH06"
                />
                <p className="mt-1 text-xs text-gray-500">Exibido como &quot;código - descrição&quot;</p>
              </div>
              {formData.tipo === 'viatura' && (
                <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Localizações (viatura)
                  </label>
                  <p className="text-xs text-gray-500 mb-2">A viatura tem sempre 2 localizações: uma base e uma .FERR</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600 w-32">Localização 1:</span>
                      <span className="font-mono bg-white px-2 py-1 rounded border border-gray-200">{formData.codigo ? formData.codigo.trim().toUpperCase() : '—'}</span>
                      <span className="text-xs text-gray-500">(normal)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600 w-32">Localização 2:</span>
                      <span className="font-mono bg-white px-2 py-1 rounded border border-gray-200">{formData.codigo ? formData.codigo.trim().toUpperCase() + '.FERR' : '—'}</span>
                      <span className="text-xs text-gray-500">(.FERR)</span>
                    </div>
                  </div>
                </div>
              )}
              {formData.tipo === 'central' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Localizações (central) <span className="text-red-500">*</span>
                  </label>
                  <p className="text-xs text-gray-500 mb-2">Obrigatório: pelo menos uma de Recebimento e uma ou mais de Expedição. As restantes podem ser Normal.</p>
                  {(formData.localizacoes.length === 0 ? [{ localizacao: '', tipo_localizacao: 'normal' }] : formData.localizacoes).map((loc, idx) => (
                    <div key={idx} className="flex gap-2 mb-2 flex-wrap items-center">
                      <input
                        type="text"
                        value={loc.localizacao || ''}
                        onChange={(e) => {
                          const newLocs = [...(formData.localizacoes.length ? formData.localizacoes : [{ localizacao: '', tipo_localizacao: 'normal' }])];
                          if (!newLocs[idx]) newLocs[idx] = { localizacao: '', tipo_localizacao: 'normal' };
                          newLocs[idx] = { ...newLocs[idx], localizacao: e.target.value };
                          setFormData(prev => ({ ...prev, localizacoes: newLocs }));
                        }}
                        className="flex-1 min-w-[120px] px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                        placeholder="Ex: E, EXPEDICAO, Prateleira A..."
                      />
                      <select
                        value={loc.tipo_localizacao || 'normal'}
                        onChange={(e) => {
                          const newLocs = [...(formData.localizacoes.length ? formData.localizacoes : [{ localizacao: '', tipo_localizacao: 'normal' }])];
                          if (!newLocs[idx]) newLocs[idx] = { localizacao: '', tipo_localizacao: 'normal' };
                          newLocs[idx] = { ...newLocs[idx], tipo_localizacao: e.target.value };
                          setFormData(prev => ({ ...prev, localizacoes: newLocs }));
                        }}
                        className="w-36 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF]"
                      >
                        <option value="recebimento">Recebimento</option>
                        <option value="expedicao">Expedição</option>
                        <option value="normal">Normal</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({
                          ...prev,
                          localizacoes: prev.localizacoes.filter((_, i) => i !== idx)
                        }))}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                        title="Remover"
                      >
                        <FaTrash />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({
                      ...prev,
                      localizacoes: [...(prev.localizacoes.length ? prev.localizacoes : [{ localizacao: '', tipo_localizacao: 'normal' }]), { localizacao: '', tipo_localizacao: 'normal' }]
                    }))}
                    className="flex items-center gap-2 text-[#0915FF] hover:underline text-sm mt-2"
                  >
                    <FaPlus /> Adicionar localização
                  </button>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] disabled:opacity-50 flex items-center gap-2"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <FaWarehouse />
                      {editandoId ? 'Salvar' : 'Criar Armazém'}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
              </div>
            </form>
            </>
            )}
          </div>
        )}

        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          {armazens.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <FaWarehouse className="mx-auto text-4xl text-gray-300 mb-4" />
              <p className="text-lg">Nenhum armazém cadastrado</p>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setMostrarForm(true)}
                  className="mt-4 text-[#0915FF] hover:underline"
                >
                  Criar primeiro armazém
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {armazens.map((armazem) => {
                const locs = armazem.localizacoes || (armazem.localizacao ? [{ localizacao: armazem.localizacao, tipo_localizacao: 'normal' }] : []);
                const numLocs = locs.length;
                const isExpanded = expandedId === armazem.id;
                return (
                  <li key={armazem.id} className="p-4 sm:p-6 hover:bg-gray-50 flex flex-col gap-2">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : armazem.id)}
                        className="flex-1 text-left flex items-center gap-2 flex-wrap"
                      >
                        <FaWarehouse className="text-[#0915FF]" />
                        <span className="font-semibold text-gray-900">
                          {armazem.codigo ? `${armazem.codigo} - ${armazem.descricao}` : armazem.descricao}
                        </span>
                        {(armazem.tipo === 'central' || armazem.tipo === 'viatura') && (
                          <span className={`px-2 py-0.5 text-xs rounded ${armazem.tipo === 'central' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>
                            {armazem.tipo === 'central' ? 'Central' : 'Viatura'}
                          </span>
                        )}
                        {armazem.ativo === false && (
                          <span className="px-2 py-0.5 text-xs bg-gray-200 text-gray-600 rounded">Inativo</span>
                        )}
                        {numLocs > 0 && (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                            {isExpanded ? <FaChevronUp /> : <FaChevronDown />}
                            {numLocs} localização(ões) — {isExpanded ? 'recolher' : 'ver'}
                          </span>
                        )}
                      </button>
                      {isAdmin && (
                        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => handleEdit(armazem)}
                            className="p-2 text-[#0915FF] hover:bg-[#0915FF]/10 rounded-lg transition-colors"
                            title="Editar"
                          >
                            <FaEdit />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(armazem.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Excluir"
                          >
                            <FaTrash />
                          </button>
                        </div>
                      )}
                    </div>
                    {numLocs > 0 && isExpanded && (
                      <div className="pl-8 pt-2 pb-1 flex flex-wrap gap-1 border-t border-gray-100">
                        {locs.map((l, i) => (
                          <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs">
                            <FaMapMarkerAlt />
                            {typeof l === 'object' && l !== null && l.localizacao != null ? l.localizacao : (typeof l === 'string' ? l : '')}
                            {typeof l === 'object' && l !== null && l.tipo_localizacao && l.tipo_localizacao !== 'normal' && (
                              <span className="text-gray-500">({l.tipo_localizacao})</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {toast && (
          <Toast
            type={toast.type}
            message={toast.message}
            onClose={() => setToast(null)}
          />
        )}
      </div>
    </div>
  );
};

export default Armazens;
