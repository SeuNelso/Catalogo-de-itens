import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { FaPlus, FaSearch } from 'react-icons/fa';

const STATUS_CARDS = [
  { key: 'pendente', label: 'Pendentes', color: 'bg-yellow-50 border-yellow-200 text-yellow-800' },
  { key: 'EM SEPARACAO', label: 'Em separação', color: 'bg-orange-50 border-orange-200 text-orange-900' },
  { key: 'separado', label: 'Separadas', color: 'bg-green-50 border-green-200 text-green-800' },
  { key: 'EM EXPEDICAO', label: 'Em expedição', color: 'bg-blue-50 border-blue-200 text-blue-800' },
  { key: 'Entregue', label: 'Entregues', color: 'bg-emerald-50 border-emerald-200 text-emerald-800' },
  { key: 'FINALIZADO', label: 'Finalizadas', color: 'bg-slate-50 border-slate-300 text-slate-800' },
  { key: 'cancelada', label: 'Canceladas', color: 'bg-red-50 border-red-200 text-red-800' }
];

const normalize = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const getStatusLabel = (status) => {
  const labels = {
    pendente: 'Pendente',
    'EM SEPARACAO': 'Em separação',
    separado: 'Separado',
    'EM EXPEDICAO': 'Em expedição',
    Entregue: 'Entregue',
    FINALIZADO: 'Finalizado',
    cancelada: 'Cancelada'
  };
  return labels[status] || status || 'Pendente';
};

const Transferencias = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const latestFetchIdRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showStatusBoard, setShowStatusBoard] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [requisicoes, setRequisicoes] = useState([]);
  const [armazensById, setArmazensById] = useState({});

  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const statusParam = params.get('status') || '';
    setStatusFilter(statusParam);
    setShowStatusBoard(!statusParam);
  }, [location.search]);

  useEffect(() => {
    const fetchAll = async () => {
      const fetchId = ++latestFetchIdRef.current;
      try {
        setLoading(true);
        const token = localStorage.getItem('token');
        const [resReqs, resArmazens] = await Promise.all([
          fetch('/api/requisicoes', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/armazens', { headers: { Authorization: `Bearer ${token}` } })
        ]);

        const reqs = resReqs.ok ? await resReqs.json() : [];
        const armazens = resArmazens.ok ? await resArmazens.json() : [];

        if (fetchId !== latestFetchIdRef.current) return;

        const mapa = (Array.isArray(armazens) ? armazens : []).reduce((acc, a) => {
          acc[Number(a.id)] = a;
          return acc;
        }, {});

        setArmazensById(mapa);
        setRequisicoes(Array.isArray(reqs) ? reqs : []);
      } finally {
        if (fetchId === latestFetchIdRef.current) {
          setLoading(false);
        }
      }
    };

    fetchAll();
  }, []);

  const transferencias = useMemo(() => {
    return requisicoes.filter((r) => {
      const origem = armazensById[Number(r.armazem_origem_id)];
      const destino = armazensById[Number(r.armazem_id)];
      if (!origem || !destino) return false;
      const centralApeado = origem.tipo === 'central' && destino.tipo === 'apeado';
      const apeadoCentral = origem.tipo === 'apeado' && destino.tipo === 'central';
      return centralApeado || apeadoCentral;
    });
  }, [requisicoes, armazensById]);

  const countsByStatus = useMemo(
    () =>
      transferencias.reduce((acc, r) => {
        const s = r.status || 'pendente';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
    [transferencias]
  );

  const filtered = useMemo(() => {
    const statused = statusFilter ? transferencias.filter((r) => (r.status || 'pendente') === statusFilter) : transferencias;
    if (!searchTerm.trim()) return statused;
    const q = normalize(searchTerm.trim());
    return statused.filter((r) => {
      const textos = [
        r.id,
        r.status,
        r.armazem_origem_descricao,
        r.armazem_descricao,
        r.observacoes,
        r.usuario_nome,
        r.criador_username
      ];
      return textos.some((t) => normalize(t).includes(q));
    });
  }, [transferencias, statusFilter, searchTerm]);

  const ordenadas = useMemo(() => {
    const arr = [...filtered];
    if (statusFilter) {
      return arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [filtered, statusFilter]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0915FF] mx-auto" />
          <p className="mt-4 text-gray-600">Carregando transferências...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">Transferências</h1>
            <p className="text-gray-600">
              {showStatusBoard
                ? 'Selecione um status para abrir a lista e gerir por FIFO.'
                : `Transferências entre Centrais e APEADOS (${getStatusLabel(statusFilter)}).`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            <Link
              to="/transferencias/criar"
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0915FF] text-white rounded-lg hover:bg-[#070FCC] transition-colors"
            >
              <FaPlus /> Nova Transferência
            </Link>
          </div>
        </div>

        {!showStatusBoard && (
          <div className="mb-3 sm:hidden">
            <button
              type="button"
              onClick={() => {
                navigate('/transferencias');
                setSearchTerm('');
              }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Voltar aos status
            </button>
          </div>
        )}

        {showStatusBoard && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {STATUS_CARDS.map((card) => {
              const qty = countsByStatus[card.key] || 0;
              return (
                <button
                  key={card.key}
                  type="button"
                  onClick={() => {
                    const params = new URLSearchParams();
                    params.set('status', card.key);
                    navigate(`/transferencias?${params.toString()}`);
                  }}
                  className={`text-left rounded-xl border p-5 shadow-sm hover:shadow-md transition-all ${card.color}`}
                >
                  <div className="text-sm font-semibold opacity-90">{card.label}</div>
                  <div className="mt-2 text-3xl font-bold">{qty}</div>
                </button>
              );
            })}
          </div>
        )}

        {!showStatusBoard && (
          <>
            <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1 relative">
                  <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Buscar por origem, destino, criador, observações..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigate('/transferencias');
                    setSearchTerm('');
                  }}
                  className="hidden sm:block px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Voltar aos status
                </button>
              </div>
            </div>

            {ordenadas.length === 0 ? (
              <div className="bg-white rounded-lg shadow-sm p-8 text-center">
                <p className="text-gray-500 text-lg">Nenhuma transferência encontrada</p>
              </div>
            ) : (
              <div className="space-y-4">
                {statusFilter && (
                  <div className="text-xs text-gray-600 px-1">
                    FIFO ativo: listagem da mais antiga para a mais nova.
                  </div>
                )}
                {ordenadas.map((r, idx) => (
                  <div
                    key={r.id}
                    className="relative overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
                  >
                    {statusFilter && (
                      <span className="absolute left-3 top-3 px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                        FIFO #{idx + 1}
                      </span>
                    )}
                    <div className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-4">
                      <div className="min-w-0">
                        <div className="flex items-start gap-3 flex-wrap mb-3 pr-24 sm:pr-0">
                          <div className="text-3xl font-black text-gray-900 leading-none">#{r.id}</div>
                          <span className="px-3 py-1 text-sm rounded-full bg-blue-100 text-blue-800 font-semibold">
                            {getStatusLabel(r.status)}
                          </span>
                          {r.status === 'EM EXPEDICAO' && Boolean(r.cancelada_em_expedicao) && (
                            <span className="px-3 py-1 text-sm rounded-full bg-red-100 text-red-800 font-semibold">
                              Cancelada
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600 space-y-1">
                          <div><strong>Origem:</strong> {r.armazem_origem_descricao || r.armazem_origem_id}</div>
                          <div><strong>Destino:</strong> {r.armazem_descricao || r.armazem_id}</div>
                          <div><strong>Criado por:</strong> {r.usuario_nome || r.criador_username || '—'}</div>
                          <div><strong>Data:</strong> {r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR') : '—'}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default Transferencias;
