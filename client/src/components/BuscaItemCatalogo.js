import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';

export function itemTextoSecundario(item) {
  if (!item) return '';
  return (item.descricao || item.nome || '').trim();
}

/** Extrai código do texto «COD - descrição» ou do primeiro token. */
export function extrairCodigoItemBusca(valor) {
  const s = String(valor || '').trim();
  if (!s) return '';
  const dash = s.indexOf(' - ');
  if (dash > 0) return s.slice(0, dash).trim();
  return s.split(/\s+/)[0].trim();
}

export function labelItemCatalogo(item) {
  const cod = String(item?.codigo || '').trim();
  const desc = itemTextoSecundario(item);
  return desc ? `${cod} - ${desc}` : cod;
}

/**
 * Campo de pesquisa de artigos no catálogo (padrão CriarRequisicao / ConsultaMovimentos).
 */
export default function BuscaItemCatalogo({
  value,
  onChange,
  onSelectItem,
  placeholder = 'Pesquisa no catálogo (código ou descrição)…',
  className = '',
  inputClassName = '',
  disabled = false,
  minChars = 1,
  limit = 200,
  incluirInativos = true,
  filterItem,
  id,
  autoFocus = false,
}) {
  const [itensFiltrados, setItensFiltrados] = useState([]);
  const [mostrarLista, setMostrarLista] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const refLista = useRef(null);
  const refInput = useRef(null);
  const debounceRef = useRef(null);
  const skipBuscaRef = useRef(false);
  const abortRef = useRef(null);

  useEffect(() => {
    if (skipBuscaRef.current) {
      skipBuscaRef.current = false;
      return undefined;
    }
    const q = String(value || '').trim();
    if (!q || q.length < minChars) {
      abortRef.current?.abort();
      setItensFiltrados([]);
      setMostrarLista(false);
      setSelectedIndex(-1);
      setLoading(false);
      return undefined;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.get('/api/itens', {
          params: {
            search: q,
            limit,
            page: 1,
            incluirInativos,
          },
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (abortRef.current !== ac) return;
        let list = Array.isArray(data?.itens) ? data.itens : [];
        if (typeof filterItem === 'function') {
          list = list.filter(filterItem);
        }
        setItensFiltrados(list);
        setMostrarLista(true);
        setSelectedIndex(list.length > 0 ? 0 : -1);
      } catch (err) {
        if (axios.isCancel?.(err) || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        setItensFiltrados([]);
        setMostrarLista(true);
        setSelectedIndex(-1);
      } finally {
        if (abortRef.current === ac) setLoading(false);
      }
    }, 280);
    return () => {
      clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [value, minChars, limit, incluirInativos, filterItem]);

  useEffect(() => {
    if (mostrarLista && selectedIndex >= 0 && refLista.current) {
      const el = refLista.current.querySelector(`[data-item-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex, mostrarLista]);

  const selecionar = (item) => {
    if (!item) return;
    skipBuscaRef.current = true;
    onChange?.(labelItemCatalogo(item));
    onSelectItem?.(item);
    setMostrarLista(false);
    setSelectedIndex(-1);
  };

  const inputCls =
    inputClassName ||
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0915FF] focus:border-transparent';

  return (
    <div className={`relative ${className}`.trim()}>
      <input
        ref={refInput}
        id={id}
        type="text"
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange?.(e.target.value);
        }}
        onFocus={() => {
          if (String(value || '').trim()) setMostrarLista(true);
        }}
        onBlur={() => {
          setTimeout(() => setMostrarLista(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            if (mostrarLista && itensFiltrados.length > 0) {
              e.preventDefault();
              setSelectedIndex((i) => (i < itensFiltrados.length - 1 ? i + 1 : i));
            }
          } else if (e.key === 'ArrowUp') {
            if (mostrarLista && itensFiltrados.length > 0) {
              e.preventDefault();
              setSelectedIndex((i) => (i > 0 ? i - 1 : 0));
            }
          } else if (e.key === 'Enter') {
            if (mostrarLista && itensFiltrados.length > 0) {
              e.preventDefault();
              const idx = selectedIndex >= 0 ? selectedIndex : 0;
              selecionar(itensFiltrados[idx]);
            }
          } else if (e.key === 'Escape') {
            setMostrarLista(false);
          }
        }}
        className={inputCls}
      />
      {mostrarLista && String(value || '').trim() && (
        <div
          ref={refLista}
          className="absolute z-20 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto"
        >
          {loading ? (
            <div className="px-4 py-3 text-sm text-gray-500">A pesquisar…</div>
          ) : itensFiltrados.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">Nenhum item encontrado</div>
          ) : (
            itensFiltrados.map((item, index) => (
              <div
                key={item.id}
                data-item-index={index}
                role="button"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selecionar(item);
                }}
                className={`px-4 py-2 cursor-pointer border-b border-gray-200 last:border-b-0 ${
                  index === selectedIndex ? 'bg-[#0915FF]/15 text-[#0915FF]' : 'hover:bg-gray-100'
                }`}
              >
                <div className="font-medium text-gray-900">{item.codigo}</div>
                <div className="text-sm text-gray-500">{itemTextoSecundario(item)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
