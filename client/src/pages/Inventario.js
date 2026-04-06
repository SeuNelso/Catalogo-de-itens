import React, { useEffect, useMemo, useState } from 'react';
import Toast from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';

const STATUS_LABEL = {
  ABERTA: 'Abertas',
  CONTADA: 'Contadas',
  JUSTIFICADA: 'Para decisão do supervisor',
  APROVADA_SUPERVISOR: 'Aprovadas (aguarda ajuste)',
  REJEITADA_SUPERVISOR: 'Rejeitadas',
  APLICADA: 'Aplicadas',
};

function statusColor(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'ABERTA') return 'bg-amber-100 text-amber-800';
  if (s === 'CONTADA') return 'bg-sky-100 text-sky-800';
  if (s === 'JUSTIFICADA') return 'bg-violet-100 text-violet-800';
  if (s === 'APROVADA_SUPERVISOR') return 'bg-indigo-100 text-indigo-800';
  if (s === 'REJEITADA_SUPERVISOR') return 'bg-rose-100 text-rose-800';
  if (s === 'APLICADA') return 'bg-emerald-100 text-emerald-800';
  return 'bg-gray-100 text-gray-700';
}

const Inventario = () => {
  const { user } = useAuth();
  const role = String(user?.role || '').toLowerCase();
  const isAdmin = role === 'admin';
  const canCreateAndJustify = isAdmin || role === 'backoffice_armazem';
  const canCount = isAdmin || role === 'operador';
  const canDecideAndApply = isAdmin || role === 'supervisor_armazem';

  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [armazens, setArmazens] = useState([]);
  const [tarefas, setTarefas] = useState([]);
  const [filtros, setFiltros] = useState({ status: '' });

  const [form, setForm] = useState({
    armazem_id: '',
    localizacao_id: '',
    q_item: '',
    item_id: '',
  });
  const [itemsOptions, setItemsOptions] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);

  const [countDraft, setCountDraft] = useState({});
  const [justDraft, setJustDraft] = useState({});
  const [decisionDraft, setDecisionDraft] = useState({});
  const [busyId, setBusyId] = useState('');

  const token = localStorage.getItem('token');

  const carregarArmazens = async () => {
    const res = await fetch('/api/inventario/armazens', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || data.details || 'Erro ao carregar armazéns');
    setArmazens(Array.isArray(data) ? data : []);
  };

  const carregarTarefas = async (status = filtros.status) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    const res = await fetch(`/api/inventario/tarefas?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || data.details || 'Erro ao carregar tarefas');
    setTarefas(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        await carregarArmazens();
        await carregarTarefas('');
      } catch (e) {
        setToast({ type: 'error', message: e.message || 'Erro ao carregar inventário' });
      } finally {
        setLoading(false);
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const armazemSel = useMemo(
    () => armazens.find((a) => String(a.id) === String(form.armazem_id)),
    [armazens, form.armazem_id]
  );
  const localizacoes = Array.isArray(armazemSel?.localizacoes) ? armazemSel.localizacoes : [];

  useEffect(() => {
    setForm((p) => ({ ...p, localizacao_id: '', item_id: '' }));
    setItemsOptions([]);
    setSelectedItem(null);
  }, [form.armazem_id]);

  useEffect(() => {
    setForm((p) => ({ ...p, item_id: '' }));
    setItemsOptions([]);
    setSelectedItem(null);
  }, [form.localizacao_id]);

  useEffect(() => {
    const q = String(form.q_item || '').trim();
    if (!form.armazem_id || !form.localizacao_id || q.length < 2) {
      setItemsOptions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          armazem_id: String(form.armazem_id),
          localizacao_id: String(form.localizacao_id),
          q,
        });
        const res = await fetch(`/api/inventario/itens?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => []);
        if (!res.ok) throw new Error(data.error || data.details || 'Erro ao procurar itens');
        setItemsOptions(Array.isArray(data) ? data : []);
      } catch (e) {
        setToast({ type: 'error', message: e.message || 'Erro ao procurar itens' });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [form.armazem_id, form.localizacao_id, form.q_item, token]);

  const tarefasByStatus = useMemo(() => {
    const out = {};
    for (const row of tarefas) {
      const s = String(row.status || '').toUpperCase();
      if (!out[s]) out[s] = [];
      out[s].push(row);
    }
    return out;
  }, [tarefas]);

  const criarPedido = async (e) => {
    e.preventDefault();
    if (!canCreateAndJustify) return;
    if (!form.armazem_id || !form.localizacao_id || !form.item_id) {
      setToast({ type: 'error', message: 'Selecione armazém, localização e artigo.' });
      return;
    }
    try {
      setBusyId('create');
      const res = await fetch('/api/inventario/tarefas', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          armazem_id: Number(form.armazem_id),
          localizacao_id: Number(form.localizacao_id),
          item_id: Number(form.item_id),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao criar pedido');
      setForm({ armazem_id: '', localizacao_id: '', q_item: '', item_id: '' });
      setSelectedItem(null);
      setItemsOptions([]);
      await carregarTarefas('');
      setToast({ type: 'success', message: 'Pedido de contagem criado.' });
    } catch (e2) {
      setToast({ type: 'error', message: e2.message || 'Erro ao criar pedido' });
    } finally {
      setBusyId('');
    }
  };

  const guardarContagem = async (id) => {
    try {
      const raw = String(countDraft[id] ?? '').replace(',', '.');
      const qtd = Number(raw);
      if (!Number.isFinite(qtd) || qtd < 0) {
        setToast({ type: 'error', message: 'Quantidade física inválida.' });
        return;
      }
      setBusyId(`count:${id}`);
      const res = await fetch(`/api/inventario/tarefas/${id}/contar`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ qtd_fisica: qtd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao guardar contagem');
      await carregarTarefas('');
      setToast({ type: 'success', message: 'Contagem guardada.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao guardar contagem' });
    } finally {
      setBusyId('');
    }
  };

  const guardarJustificativa = async (id) => {
    try {
      const justificativa = String(justDraft[id] || '').trim();
      if (justificativa.length < 10) {
        setToast({ type: 'error', message: 'Justificativa mínima de 10 caracteres.' });
        return;
      }
      setBusyId(`just:${id}`);
      const res = await fetch(`/api/inventario/tarefas/${id}/justificar`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ justificativa }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao justificar');
      await carregarTarefas('');
      setToast({ type: 'success', message: 'Justificativa enviada para aprovação.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao justificar' });
    } finally {
      setBusyId('');
    }
  };

  const decidir = async (id, acao) => {
    try {
      const motivo = String(decisionDraft[id] || '').trim();
      if (acao === 'rejeitar' && motivo.length < 5) {
        setToast({ type: 'error', message: 'Motivo da rejeição mínimo de 5 caracteres.' });
        return;
      }
      setBusyId(`dec:${id}:${acao}`);
      const res = await fetch(`/api/inventario/tarefas/${id}/decidir`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ acao, motivo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao decidir');
      await carregarTarefas('');
      setToast({ type: 'success', message: acao === 'aprovar' ? 'Pedido aprovado.' : 'Pedido rejeitado.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao decidir pedido' });
    } finally {
      setBusyId('');
    }
  };

  const aplicar = async (id) => {
    try {
      setBusyId(`apply:${id}`);
      const res = await fetch(`/api/inventario/tarefas/${id}/aplicar`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || 'Erro ao aplicar ajuste');
      await carregarTarefas('');
      setToast({ type: 'success', message: 'Ajuste aplicado ao stock.' });
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Erro ao aplicar ajuste' });
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Inventário - pedidos de contagem</h1>
          <p className="text-sm text-gray-600 mt-1">
            Backoffice abre e justifica, operador conta, supervisor aprova/rejeita e aplica o ajuste.
          </p>
        </div>

        {canCreateAndJustify && (
          <form onSubmit={criarPedido} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 space-y-3">
            <h2 className="text-base font-semibold text-gray-900">Novo pedido de contagem</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <select
                value={form.armazem_id}
                onChange={(e) => setForm((p) => ({ ...p, armazem_id: e.target.value }))}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">Armazém</option>
                {armazens.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.codigo} - {a.descricao}
                  </option>
                ))}
              </select>
              <select
                value={form.localizacao_id}
                onChange={(e) => setForm((p) => ({ ...p, localizacao_id: e.target.value }))}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                disabled={!form.armazem_id}
              >
                <option value="">Localização</option>
                {localizacoes.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.localizacao}
                  </option>
                ))}
              </select>
              <input
                value={form.q_item}
                onChange={(e) => setForm((p) => ({ ...p, q_item: e.target.value }))}
                placeholder="Pesquisar artigo (código/descrição)"
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                disabled={!form.localizacao_id}
              />
              <select
                value={form.item_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const pick = itemsOptions.find((x) => String(x.item_id) === String(id)) || null;
                  setSelectedItem(pick);
                  setForm((p) => ({ ...p, item_id: id }));
                }}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                disabled={!itemsOptions.length}
              >
                <option value="">Selecionar artigo</option>
                {itemsOptions.map((it) => (
                  <option key={it.item_id} value={it.item_id}>
                    {it.codigo} - {it.descricao}
                  </option>
                ))}
              </select>
            </div>
            {selectedItem && (
              <div className="text-sm text-gray-700">
                Qtd. sistema na localização: <strong>{String(selectedItem.quantidade_sistema || '0')}</strong>
              </div>
            )}
            <div>
              <button
                type="submit"
                disabled={busyId === 'create'}
                className="px-4 py-2 rounded-lg text-sm bg-[#0915FF] text-white hover:opacity-90 disabled:opacity-60"
              >
                {busyId === 'create' ? 'A guardar...' : 'Criar pedido'}
              </button>
            </div>
          </form>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={filtros.status}
              onChange={(e) => setFiltros({ status: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">Todos os status</option>
              {Object.keys(STATUS_LABEL).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => carregarTarefas(filtros.status)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              disabled={loading}
            >
              Atualizar
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Object.keys(STATUS_LABEL).map((status) => {
            const rows = tarefasByStatus[status] || [];
            if (filtros.status && filtros.status !== status) return null;
            return (
              <div key={status} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5">
                <h3 className="font-semibold text-gray-900 mb-3">{STATUS_LABEL[status]} ({rows.length})</h3>
                {!rows.length && <p className="text-sm text-gray-500">Sem tarefas neste status.</p>}
                <div className="space-y-3">
                  {rows.map((t) => (
                    <div key={t.id} className="border border-gray-200 rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-sm text-gray-900">#{t.id} - {t.item_codigo}</div>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor(t.status)}`}>
                          {t.status}
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-gray-700 space-y-1">
                        <div>Artigo: {t.item_descricao}</div>
                        <div>Armazém: {t.armazem_codigo} - {t.armazem_descricao}</div>
                        <div>Localização: {t.localizacao}</div>
                        <div>Qtd sistema: {String(t.qtd_sistema_snapshot || '0')}</div>
                        <div>Qtd física: {t.qtd_fisica == null ? '-' : String(t.qtd_fisica)}</div>
                        <div>Delta: {t.delta == null ? '-' : String(t.delta)}</div>
                        {t.justificativa_backoffice ? <div>Justificativa: {t.justificativa_backoffice}</div> : null}
                        {t.supervisor_decisao_motivo ? <div>Motivo decisão: {t.supervisor_decisao_motivo}</div> : null}
                      </div>

                      {canCount && String(t.status) === 'ABERTA' && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            value={countDraft[t.id] ?? ''}
                            onChange={(e) => setCountDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                            placeholder="Qtd física"
                            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-40"
                          />
                          <button
                            type="button"
                            onClick={() => guardarContagem(t.id)}
                            disabled={busyId === `count:${t.id}`}
                            className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50 disabled:opacity-60"
                          >
                            Guardar contagem
                          </button>
                        </div>
                      )}

                      {canCreateAndJustify && String(t.status) === 'CONTADA' && (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={justDraft[t.id] ?? ''}
                            onChange={(e) => setJustDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                            placeholder="Justificativa do backoffice (mínimo 10 caracteres)"
                            className="w-full min-h-[70px] px-3 py-2 border border-gray-300 rounded-lg text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => guardarJustificativa(t.id)}
                            disabled={busyId === `just:${t.id}`}
                            className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50 disabled:opacity-60"
                          >
                            Enviar justificativa
                          </button>
                        </div>
                      )}

                      {canDecideAndApply && String(t.status) === 'JUSTIFICADA' && (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={decisionDraft[t.id] ?? ''}
                            onChange={(e) => setDecisionDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                            placeholder="Motivo (obrigatório para rejeição)"
                            className="w-full min-h-[64px] px-3 py-2 border border-gray-300 rounded-lg text-sm"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => decidir(t.id, 'aprovar')}
                              disabled={busyId === `dec:${t.id}:aprovar`}
                              className="px-3 py-2 rounded-lg text-sm border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                            >
                              Aprovar
                            </button>
                            <button
                              type="button"
                              onClick={() => decidir(t.id, 'rejeitar')}
                              disabled={busyId === `dec:${t.id}:rejeitar`}
                              className="px-3 py-2 rounded-lg text-sm border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60"
                            >
                              Rejeitar
                            </button>
                          </div>
                        </div>
                      )}

                      {canDecideAndApply && String(t.status) === 'APROVADA_SUPERVISOR' && (
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={() => aplicar(t.id)}
                            disabled={busyId === `apply:${t.id}`}
                            className="px-3 py-2 rounded-lg text-sm border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                          >
                            Aplicar ajuste de stock
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
};

export default Inventario;
