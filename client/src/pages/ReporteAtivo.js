import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../utils/apiUrl';
import Toast from '../components/Toast';

const REPORTE_ATIVO_API = '/api/admin/reporte-ativo';

function sanitizeFileName(name) {
  return String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || 'Reporte';
}

function formatReporteDateStamp(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function applyCodigosToItens(codigos, itensList) {
  const mwCodes = new Set(itensList.map((it) => String(it.codigo)));
  const applied = [];
  for (const cod of codigos) {
    const key = String(cod);
    if (mwCodes.has(key)) applied.push(key);
  }
  return {
    selected: new Set(applied),
    applied: applied.length,
    missing: Math.max(0, codigos.length - applied.length),
    totalInProfile: codigos.length,
  };
}

function mergeItensToDraft(prev, novos) {
  const map = new Map(prev.map((it) => [String(it.codigo).toUpperCase(), it]));
  for (const it of novos) {
    const cod = String(it.codigo || '').trim();
    if (!cod) continue;
    map.set(cod.toUpperCase(), {
      codigo: cod,
      descricao: String(it.descricao || '').trim(),
      no_catalogo: it.no_catalogo !== false,
    });
  }
  return [...map.values()].sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));
}

function parseCodigosFromText(text) {
  return [...new Set(
    String(text || '')
      .split(/[\r\n,;|\t]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )];
}

function ReporteAtivo() {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [itens, setItens] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [loadingParse, setLoadingParse] = useState(false);
  const [loadingGerar, setLoadingGerar] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('success');

  const [perfis, setPerfis] = useState([]);
  const [perfilSeleccionadoId, setPerfilSeleccionadoId] = useState('');
  const [perfilNomeInput, setPerfilNomeInput] = useState('');
  const [perfilDraftItens, setPerfilDraftItens] = useState([]);
  const [perfilDraftFilter, setPerfilDraftFilter] = useState('');
  const [loadingPerfis, setLoadingPerfis] = useState(false);
  const [loadingPerfilAction, setLoadingPerfilAction] = useState(false);

  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogResults, setCatalogResults] = useState([]);
  const [catalogPick, setCatalogPick] = useState(() => new Set());
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [pasteCodigosText, setPasteCodigosText] = useState('');
  const [showPerfisConfig, setShowPerfisConfig] = useState(false);

  const notify = (message, type = 'success') => {
    setToastMessage(message);
    setToastType(type);
    setShowToast(true);
  };

  const getToken = useCallback(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      notify('Sessão expirada. Faça login novamente.', 'error');
      navigate('/login');
      return null;
    }
    return token;
  }, [navigate]);

  const perfilSeleccionado = useMemo(
    () => perfis.find((p) => String(p.id) === String(perfilSeleccionadoId)) || null,
    [perfis, perfilSeleccionadoId]
  );

  const perfilDraftCodigos = useMemo(
    () => perfilDraftItens.map((it) => it.codigo),
    [perfilDraftItens]
  );

  const filteredPerfilDraft = useMemo(() => {
    const q = String(perfilDraftFilter || '').trim().toLowerCase();
    if (!q) return perfilDraftItens;
    return perfilDraftItens.filter((it) => {
      const cod = String(it.codigo || '').toLowerCase();
      const desc = String(it.descricao || '').toLowerCase();
      return cod.includes(q) || desc.includes(q);
    });
  }, [perfilDraftItens, perfilDraftFilter]);

  const carregarPerfis = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoadingPerfis(true);
    try {
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao carregar perfis.');
      }
      setPerfis(Array.isArray(data.perfis) ? data.perfis : []);
    } catch (e) {
      notify(e.message || 'Erro ao carregar perfis.', 'error');
    } finally {
      setLoadingPerfis(false);
    }
  }, [getToken]);

  const carregarPerfilNoDraft = useCallback(async (perfilId) => {
    const token = getToken();
    if (!token || !perfilId) return;
    setLoadingPerfilAction(true);
    try {
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis/${perfilId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao carregar perfil.');
      }
      const itensPerfil = Array.isArray(data.itens) ? data.itens : [];
      setPerfilDraftItens(itensPerfil);
      setPerfilNomeInput(String(data.nome || ''));
    } catch (e) {
      notify(e.message || 'Erro ao carregar perfil.', 'error');
    } finally {
      setLoadingPerfilAction(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (!user || !isAuthenticated) {
      navigate('/login');
      return;
    }
    carregarPerfis();
  }, [user, isAuthenticated, navigate, carregarPerfis]);

  const aplicarPerfilPorId = useCallback(async (perfilId, itensList = itens) => {
    const token = getToken();
    if (!token || !perfilId) return null;

    const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis/${perfilId}`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Erro ao carregar perfil.');
    }

    const codigos = Array.isArray(data.codigos) ? data.codigos : [];
    const result = applyCodigosToItens(codigos, itensList);
    setSelected(result.selected);
    return result;
  }, [getToken, itens]);

  const handleNovoPerfil = () => {
    setPerfilSeleccionadoId('');
    setPerfilNomeInput('');
    setPerfilDraftItens([]);
    setPerfilDraftFilter('');
    setPasteCodigosText('');
    setCatalogPick(new Set());
  };

  const handlePerfilSelectChange = (e) => {
    const id = e.target.value;
    setPerfilSeleccionadoId(id);
    if (!id) {
      setPerfilNomeInput('');
      return;
    }
    const perfil = perfis.find((p) => String(p.id) === String(id));
    setPerfilNomeInput(perfil?.nome || '');
  };

  const handlePerfilSelectNoModal = async (e) => {
    const id = e.target.value;
    setPerfilSeleccionadoId(id);
    if (!id) {
      setPerfilNomeInput('');
      setPerfilDraftItens([]);
      setPerfilDraftFilter('');
      setPasteCodigosText('');
      setCatalogPick(new Set());
      return;
    }
    const perfil = perfis.find((p) => String(p.id) === String(id));
    setPerfilNomeInput(perfil?.nome || '');
    await carregarPerfilNoDraft(id);
  };

  const handleAbrirPerfisConfig = async () => {
    setShowPerfisConfig(true);
    if (perfilSeleccionadoId) {
      await carregarPerfilNoDraft(perfilSeleccionadoId);
    }
  };

  const handleFecharPerfisConfig = () => {
    setShowPerfisConfig(false);
  };

  const handleAplicarPerfil = async () => {
    if (!perfilSeleccionadoId) {
      notify('Seleccione um perfil.', 'error');
      return;
    }
    if (!itens.length) {
      notify('Carregue primeiro a lista de artigos do ficheiro MW.', 'error');
      return;
    }
    setLoadingPerfilAction(true);
    try {
      const result = await aplicarPerfilPorId(perfilSeleccionadoId, itens);
      if (!result) return;
      const nome = perfilSeleccionado?.nome || 'Perfil';
      if (result.missing > 0) {
        notify(
          `Perfil "${nome}": ${result.applied} de ${result.totalInProfile} artigo(s) aplicado(s). ${result.missing} não estão no MW actual.`,
          'success'
        );
      } else {
        notify(`Perfil "${nome}" aplicado (${result.applied} artigo(s)).`);
      }
    } catch (e) {
      notify(e.message || 'Erro ao aplicar perfil.', 'error');
    } finally {
      setLoadingPerfilAction(false);
    }
  };

  const handleGuardarPerfil = async () => {
    const nome = String(perfilNomeInput || '').trim();
    if (!nome) {
      notify('Indique um nome para o perfil.', 'error');
      return;
    }
    const codigos = perfilDraftCodigos;
    if (!codigos.length) {
      notify('Adicione pelo menos um artigo ao perfil.', 'error');
      return;
    }
    if (perfilSeleccionadoId) {
      notify('Para criar um perfil novo, clique em «Novo perfil» ou use «Actualizar perfil».', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;

    setLoadingPerfilAction(true);
    try {
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nome, codigos }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao guardar perfil.');
      }
      await carregarPerfis();
      setPerfilSeleccionadoId(String(data.id));
      setPerfilNomeInput(data.nome || nome);
      notify(`Perfil "${data.nome || nome}" guardado com ${codigos.length} artigo(s).`);
    } catch (e) {
      notify(e.message || 'Erro ao guardar perfil.', 'error');
    } finally {
      setLoadingPerfilAction(false);
    }
  };

  const handleActualizarPerfil = async () => {
    if (!perfilSeleccionadoId) {
      notify('Seleccione um perfil para actualizar.', 'error');
      return;
    }
    const codigos = perfilDraftCodigos;
    if (!codigos.length) {
      notify('Adicione pelo menos um artigo ao perfil.', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;

    const nome = String(perfilNomeInput || perfilSeleccionado?.nome || '').trim();
    if (!nome) {
      notify('Indique um nome para o perfil.', 'error');
      return;
    }

    setLoadingPerfilAction(true);
    try {
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis/${perfilSeleccionadoId}`), {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nome, codigos }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao actualizar perfil.');
      }
      await carregarPerfis();
      notify(`Perfil "${data.nome || nome}" actualizado (${codigos.length} artigo(s)).`);
    } catch (e) {
      notify(e.message || 'Erro ao actualizar perfil.', 'error');
    } finally {
      setLoadingPerfilAction(false);
    }
  };

  const handleApagarPerfil = async () => {
    if (!perfilSeleccionadoId) {
      notify('Seleccione um perfil para apagar.', 'error');
      return;
    }
    const nome = perfilSeleccionado?.nome || 'perfil';
    if (!window.confirm(`Apagar o perfil "${nome}"?`)) return;

    const token = getToken();
    if (!token) return;

    setLoadingPerfilAction(true);
    try {
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis/${perfilSeleccionadoId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao apagar perfil.');
      }
      handleNovoPerfil();
      await carregarPerfis();
      notify(`Perfil "${nome}" apagado.`);
    } catch (e) {
      notify(e.message || 'Erro ao apagar perfil.', 'error');
    } finally {
      setLoadingPerfilAction(false);
    }
  };

  const handleRemoverDoDraft = (codigo) => {
    const key = String(codigo).toUpperCase();
    setPerfilDraftItens((prev) => prev.filter((it) => String(it.codigo).toUpperCase() !== key));
  };

  const handleAdicionarMwAoPerfil = () => {
    if (!selected.size) {
      notify('Seleccione artigos na lista MW primeiro.', 'error');
      return;
    }
    const novos = itens
      .filter((it) => selected.has(String(it.codigo)))
      .map((it) => ({
        codigo: String(it.codigo),
        descricao: String(it.descricao || it.descricao_mw || '').trim(),
        no_catalogo: it.no_catalogo !== false,
      }));
    setPerfilDraftItens((prev) => mergeItensToDraft(prev, novos));
    notify(`${novos.length} artigo(s) adicionado(s) ao perfil.`);
  };

  const handlePesquisarCatalogo = async () => {
    const q = String(catalogSearch || '').trim();
    if (q.length < 2) {
      notify('Digite pelo menos 2 caracteres para pesquisar no catálogo.', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;

    setLoadingCatalog(true);
    try {
      const params = new URLSearchParams({ search: q, limit: '50', page: '1' });
      const response = await fetch(apiUrl(`/api/itens?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao pesquisar catálogo.');
      }
      const lista = Array.isArray(data.itens) ? data.itens : [];
      setCatalogResults(lista.map((it) => ({
        codigo: String(it.codigo || '').trim(),
        descricao: String(it.descricao || it.nome || '').trim(),
        no_catalogo: true,
      })).filter((it) => it.codigo));
      setCatalogPick(new Set());
    } catch (e) {
      notify(e.message || 'Erro ao pesquisar catálogo.', 'error');
    } finally {
      setLoadingCatalog(false);
    }
  };

  const toggleCatalogPick = (codigo) => {
    const key = String(codigo);
    setCatalogPick((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAdicionarCatalogoAoPerfil = () => {
    if (!catalogPick.size) {
      notify('Seleccione artigos nos resultados da pesquisa.', 'error');
      return;
    }
    const novos = catalogResults.filter((it) => catalogPick.has(String(it.codigo)));
    setPerfilDraftItens((prev) => mergeItensToDraft(prev, novos));
    setCatalogPick(new Set());
    notify(`${novos.length} artigo(s) adicionado(s) ao perfil.`);
  };

  const handleImportarCodigosColados = async () => {
    const codigos = parseCodigosFromText(pasteCodigosText);
    if (!codigos.length) {
      notify('Cole pelo menos um código ERP.', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;

    setLoadingPerfilAction(true);
    try {
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/perfis/resolver-codigos`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ codigos }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao importar códigos.');
      }
      const itensResolvidos = Array.isArray(data.itens) ? data.itens : [];
      setPerfilDraftItens((prev) => mergeItensToDraft(prev, itensResolvidos));
      const foraCatalogo = itensResolvidos.filter((it) => !it.no_catalogo).length;
      setPasteCodigosText('');
      notify(
        foraCatalogo > 0
          ? `${itensResolvidos.length} código(s) importado(s). ${foraCatalogo} não estão no catálogo.`
          : `${itensResolvidos.length} código(s) importado(s).`
      );
    } catch (e) {
      notify(e.message || 'Erro ao importar códigos.', 'error');
    } finally {
      setLoadingPerfilAction(false);
    }
  };

  const filteredItens = useMemo(() => {
    const q = String(filter || '').trim().toLowerCase();
    if (!q) return itens;
    return itens.filter((it) => {
      const cod = String(it.codigo || '').toLowerCase();
      const desc = String(it.descricao || '').toLowerCase();
      return cod.includes(q) || desc.includes(q);
    });
  }, [itens, filter]);

  const allFilteredSelected = filteredItens.length > 0
    && filteredItens.every((it) => selected.has(String(it.codigo)));

  const toggleOne = (codigo) => {
    const key = String(codigo);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredItens.forEach((it) => next.delete(String(it.codigo)));
      } else {
        filteredItens.forEach((it) => next.add(String(it.codigo)));
      }
      return next;
    });
  };

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext !== 'xlsx' && ext !== 'xls') {
      notify('Seleccione um ficheiro Excel (.xlsx ou .xls).', 'error');
      e.target.value = '';
      return;
    }
    setFile(f);
    setItens([]);
    setSelected(new Set());
  };

  const handleParse = useCallback(async () => {
    if (!file) {
      notify('Seleccione o ficheiro MW.xlsx primeiro.', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;

    setLoadingParse(true);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/parse`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao ler ficheiro MW.');
      }
      const lista = Array.isArray(data.itens) ? data.itens : [];
      setItens(lista);
      setSelected(new Set());

      if (perfilSeleccionadoId) {
        const result = await aplicarPerfilPorId(perfilSeleccionadoId, lista);
        if (result) {
          const nome = perfilSeleccionado?.nome || 'Perfil';
          notify(
            `${lista.length} artigo(s) no ficheiro. Perfil "${nome}": ${result.applied} seleccionado(s).`
          );
        } else {
          notify(`${lista.length} artigo(s) encontrado(s) no ficheiro.`);
        }
      } else if (perfilDraftCodigos.length) {
        const result = applyCodigosToItens(perfilDraftCodigos, lista);
        setSelected(result.selected);
        notify(
          `${lista.length} artigo(s) no ficheiro. Rascunho do perfil: ${result.applied} seleccionado(s).`
        );
      } else {
        notify(`${lista.length} artigo(s) encontrado(s) no ficheiro.`);
      }
    } catch (e) {
      notify(e.message || 'Erro ao processar ficheiro.', 'error');
    } finally {
      setLoadingParse(false);
    }
  }, [
    file,
    getToken,
    perfilSeleccionadoId,
    perfilSeleccionado,
    perfilDraftCodigos,
    aplicarPerfilPorId,
  ]);

  const handleGerar = async () => {
    const codigos = [...selected];
    if (!codigos.length) {
      notify('Seleccione pelo menos um artigo.', 'error');
      return;
    }
    if (!file) {
      notify('O ficheiro MW original é necessário para gerar o reporte.', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;

    const descricoes_mw = {};
    for (const it of itens) {
      if (!selected.has(String(it.codigo))) continue;
      descricoes_mw[it.codigo] = it.descricao_mw || it.descricao || '';
    }

    const stamp = formatReporteDateStamp();
    const nomeFicheiro = perfilSeleccionadoId
      ? `${sanitizeFileName(perfilNomeInput || perfilSeleccionado?.nome || 'Perfil')} ${stamp}`
      : `Reporte ${stamp}`;

    setLoadingGerar(true);
    try {
      const formData = new FormData();
      formData.append('arquivo', file);
      formData.append('codigos', JSON.stringify(codigos));
      formData.append('descricoes_mw', JSON.stringify(descricoes_mw));
      formData.append('nome_ficheiro', nomeFicheiro);
      const response = await fetch(apiUrl(`${REPORTE_ATIVO_API}/gerar`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao gerar ficheiro.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${nomeFicheiro}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify(`Reporte gerado com ${codigos.length} artigo(s).`);
    } catch (e) {
      notify(e.message || 'Erro ao gerar reporte.', 'error');
    } finally {
      setLoadingGerar(false);
    }
  };

  if (!user || !isAuthenticated) {
    return null;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Reporte Ativo</h1>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Perfil</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Perfil guardado</label>
            <select
              value={perfilSeleccionadoId}
              onChange={handlePerfilSelectChange}
              disabled={loadingPerfis || loadingPerfilAction}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">— Seleccionar perfil —</option>
              {perfis.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.nome}
                  {' '}
                  (
                  {p.total_itens ?? 0}
                  )
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={!perfilSeleccionadoId || !itens.length || loadingPerfilAction}
            onClick={handleAplicarPerfil}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Aplicar ao MW
          </button>
          <button
            type="button"
            onClick={handleAbrirPerfisConfig}
            disabled={loadingPerfilAction}
            className="rounded-md border border-[#0915FF] bg-white px-3 py-2 text-sm font-semibold text-[#0915FF] hover:bg-[#0915FF]/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Configurar perfis
          </button>
        </div>
        {perfilSeleccionado && (
          <p className="mt-2 text-xs text-gray-500">
            {perfilSeleccionado.total_itens ?? 0}
            {' '}
            artigo(s) no perfil seleccionado.
          </p>
        )}
        {loadingPerfis && (
          <p className="mt-2 text-xs text-gray-500">A carregar perfis…</p>
        )}
      </div>

      {showPerfisConfig && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="perfis-config-titulo"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleFecharPerfisConfig();
          }}
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-gray-100 p-4">
              <div className="min-w-0">
                <h2 id="perfis-config-titulo" className="text-lg font-semibold text-gray-900">
                  Configurar perfis
                </h2>
              </div>
              <button
                type="button"
                onClick={handleFecharPerfisConfig}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-900">Editar perfil</h3>
                <button
                  type="button"
                  onClick={handleNovoPerfil}
                  disabled={loadingPerfilAction}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-50"
                >
                  Novo perfil
                </button>
              </div>

              <div className="mb-3">
                <label className="mb-1 block text-xs font-medium text-gray-600">Perfil a editar</label>
                <select
                  value={perfilSeleccionadoId}
                  onChange={handlePerfilSelectNoModal}
                  disabled={loadingPerfis || loadingPerfilAction}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">— Novo perfil (rascunho) —</option>
                  {perfis.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.nome}
                      {' '}
                      (
                      {p.total_itens ?? 0}
                      )
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">Nome do perfil</label>
                  <input
                    type="text"
                    value={perfilNomeInput}
                    onChange={(e) => setPerfilNomeInput(e.target.value)}
                    placeholder="Ex.: Contagem mensal cabos"
                    maxLength={120}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="button"
                  disabled={perfilDraftItens.length === 0 || loadingPerfilAction || !!perfilSeleccionadoId}
                  onClick={handleGuardarPerfil}
                  className="rounded-md bg-[#0915FF] px-3 py-2 text-sm font-semibold text-white hover:bg-[#0712cc] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Guardar perfil
                </button>
                <button
                  type="button"
                  disabled={!perfilSeleccionadoId || perfilDraftItens.length === 0 || loadingPerfilAction}
                  onClick={handleActualizarPerfil}
                  className="rounded-md border border-[#0915FF] bg-white px-3 py-2 text-sm font-semibold text-[#0915FF] hover:bg-[#0915FF]/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Actualizar perfil
                </button>
                <button
                  type="button"
                  disabled={!perfilSeleccionadoId || loadingPerfilAction}
                  onClick={handleApagarPerfil}
                  className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Apagar
                </button>
              </div>

              <div className="mt-4 border-t border-gray-100 pt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
                  Artigos do perfil (
                  {perfilDraftItens.length}
                  )
                </h3>
                {perfilDraftItens.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    <input
                      type="search"
                      placeholder="Filtrar artigos do perfil…"
                      value={perfilDraftFilter}
                      onChange={(e) => setPerfilDraftFilter(e.target.value)}
                      className="min-w-[200px] flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                    />
                    {itens.length > 0 && (
                      <button
                        type="button"
                        disabled={selected.size === 0 || loadingPerfilAction}
                        onClick={handleAdicionarMwAoPerfil}
                        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                      >
                        Adicionar selecção MW
                      </button>
                    )}
                  </div>
                )}
                {perfilDraftItens.length === 0 ? (
                  <p className="text-xs text-gray-500">Nenhum artigo no perfil. Use a pesquisa no catálogo ou cole códigos abaixo.</p>
                ) : (
                  <div className="max-h-48 overflow-auto rounded-md border border-gray-200">
                    <table className="min-w-full text-left text-sm">
                      <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-600">
                        <tr>
                          <th className="px-3 py-2">ERP</th>
                          <th className="px-3 py-2">Descrição</th>
                          <th className="px-3 py-2">Catálogo</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPerfilDraft.map((it) => (
                          <tr key={it.codigo} className="border-t border-gray-100">
                            <td className="px-3 py-1.5 font-mono text-xs">{it.codigo}</td>
                            <td className="px-3 py-1.5 text-gray-800">{it.descricao || '—'}</td>
                            <td className="px-3 py-1.5 text-xs">
                              {it.no_catalogo ? (
                                <span className="text-green-700">Sim</span>
                              ) : (
                                <span className="text-amber-700">Não</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <button
                                type="button"
                                onClick={() => handleRemoverDoDraft(it.codigo)}
                                className="text-xs text-red-600 hover:underline"
                              >
                                Remover
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="mt-4 border-t border-gray-100 pt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600">Adicionar do catálogo</h3>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="search"
                    placeholder="Pesquisar código ou descrição…"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handlePesquisarCatalogo(); }}
                    className="min-w-[200px] flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={loadingCatalog}
                    onClick={handlePesquisarCatalogo}
                    className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {loadingCatalog ? 'A pesquisar…' : 'Pesquisar'}
                  </button>
                  <button
                    type="button"
                    disabled={catalogPick.size === 0}
                    onClick={handleAdicionarCatalogoAoPerfil}
                    className="rounded-md bg-[#0915FF] px-3 py-2 text-sm font-semibold text-white hover:bg-[#0712cc] disabled:opacity-50"
                  >
                    Adicionar ao perfil
                  </button>
                </div>
                {catalogResults.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-auto rounded-md border border-gray-200">
                    <table className="min-w-full text-left text-sm">
                      <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-600">
                        <tr>
                          <th className="px-3 py-2" />
                          <th className="px-3 py-2">ERP</th>
                          <th className="px-3 py-2">Descrição</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catalogResults.map((it) => {
                          const cod = String(it.codigo);
                          const jaNoPerfil = perfilDraftItens.some(
                            (p) => String(p.codigo).toUpperCase() === cod.toUpperCase()
                          );
                          return (
                            <tr key={cod} className="border-t border-gray-100">
                              <td className="px-3 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={catalogPick.has(cod)}
                                  disabled={jaNoPerfil}
                                  onChange={() => toggleCatalogPick(cod)}
                                  aria-label={`Seleccionar ${cod}`}
                                />
                              </td>
                              <td className="px-3 py-1.5 font-mono text-xs">{cod}</td>
                              <td className="px-3 py-1.5 text-gray-800">
                                {it.descricao || '—'}
                                {jaNoPerfil && (
                                  <span className="ml-2 text-xs text-gray-400">(já no perfil)</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="mt-4 border-t border-gray-100 pt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600">Colar códigos ERP</h3>
                <textarea
                  value={pasteCodigosText}
                  onChange={(e) => setPasteCodigosText(e.target.value)}
                  placeholder="Um código por linha (ou separados por vírgula, ponto e vírgula ou tab)"
                  rows={3}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={!pasteCodigosText.trim() || loadingPerfilAction}
                  onClick={handleImportarCodigosColados}
                  className="mt-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                >
                  Importar códigos
                </button>
              </div>
            </div>

            <div className="border-t border-gray-100 p-4">
              <button
                type="button"
                onClick={handleFecharPerfisConfig}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <label className="mb-2 block text-sm font-medium text-gray-700">Ficheiro de stock primavera(.xlsx)</label>
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-md file:border-0 file:bg-[#0915FF] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#0712cc]"
        />
        {file && (
          <p className="mt-2 text-xs text-gray-500">
            Ficheiro:
            {' '}
            {file.name}
          </p>
        )}
        <button
          type="button"
          disabled={!file || loadingParse}
          onClick={handleParse}
          className="mt-4 rounded-md bg-[#0915FF] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0712cc] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingParse ? 'A ler ficheiro…' : 'Carregar lista de artigos'}
        </button>
      </div>

      {itens.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                Artigos MW (
                {itens.length}
                )
              </h2>
              <p className="text-xs text-gray-500">
                {selected.size}
                {' '}
                seleccionado(s) para o reporte
              </p>
            </div>
            <input
              type="search"
              placeholder="Filtrar código ou descrição…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div className="max-h-[420px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      aria-label="Seleccionar todos visíveis"
                    />
                  </th>
                  <th className="px-4 py-2">ERP</th>
                  <th className="px-4 py-2">Descrição</th>
                  <th className="px-4 py-2 text-right">Stock</th>
                  <th className="px-4 py-2">Catálogo</th>
                </tr>
              </thead>
              <tbody>
                {filteredItens.map((it) => {
                  const cod = String(it.codigo);
                  return (
                    <tr key={cod} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(cod)}
                          onChange={() => toggleOne(cod)}
                          aria-label={`Seleccionar ${cod}`}
                        />
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{cod}</td>
                      <td className="px-4 py-2 text-gray-800">{it.descricao || it.descricao_mw || '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs tabular-nums">
                        {Number(it.stock_mw || 0).toLocaleString('pt-PT')}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {it.no_catalogo ? (
                          <span className="text-green-700">Sim</span>
                        ) : (
                          <span className="text-amber-700">Não</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-gray-200 px-4 py-4">
            <button
              type="button"
              disabled={loadingGerar || selected.size === 0}
              onClick={handleGerar}
              className="rounded-md border border-[#0915FF] bg-white px-4 py-2 text-sm font-semibold text-[#0915FF] hover:bg-[#0915FF]/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingGerar ? 'A gerar reporte…' : 'Gerar reporte'}
            </button>
          </div>
        </div>
      )}

      {showToast && (
        <Toast
          message={toastMessage}
          type={toastType}
          onClose={() => setShowToast(false)}
        />
      )}
    </div>
  );
}

export default ReporteAtivo;
