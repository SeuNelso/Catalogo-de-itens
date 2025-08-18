import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';

const SETORES_DISPONIVEIS = [
  'CLIENTE',
  'ENGENHARIA', 
  'FIBRA',
  'FROTA',
  'IT',
  'LOGISTICA',
  'MARKETING',
  'MOVEL',
  'NOWO',
  'FERRAMENTA',
  'EPI',
  'EPC'
];

const MultiSelectSetores = ({ value = [], onChange, placeholder = "Selecione os setores..." }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [dropdownPosition, setDropdownPosition] = useState('bottom');
  const dropdownRef = useRef(null);
  const portalRef = useRef(null);
  const [coords, setCoords] = useState({ left: 0, top: 0, width: 260 });

  // Fechar dropdown quando clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      const clickedOutsideTrigger = dropdownRef.current && !dropdownRef.current.contains(event.target);
      const clickedOutsidePortal = portalRef.current && !portalRef.current.contains(event.target);
      if (clickedOutsideTrigger && clickedOutsidePortal) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filtrar setores baseado no termo de busca
  const filteredSetores = SETORES_DISPONIVEIS.filter(setor =>
    setor.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSetorToggle = (setor) => {
    const newValue = value.includes(setor)
      ? value.filter(s => s !== setor)
      : [...value, setor];
    onChange(newValue);
  };

  const removeSetor = (setorToRemove) => {
    onChange(value.filter(setor => setor !== setorToRemove));
  };

  const handleToggleDropdown = () => {
    if (!isOpen) {
      const rect = dropdownRef.current?.getBoundingClientRect();
      const spaceBelow = window.innerHeight - (rect?.bottom || 0);
      const spaceAbove = rect?.top || 0;
      const position = spaceBelow < 320 && spaceAbove > 320 ? 'top' : 'bottom';
      setDropdownPosition(position);
      if (rect) {
        const top = position === 'top' ? rect.top : rect.bottom;
        setCoords({ left: rect.left, top, width: Math.max(rect.width, 260) });
      }
    }
    setIsOpen(!isOpen);
  };

  // Atualiza coordenadas em scroll/resize quando aberto
  useEffect(() => {
    if (!isOpen) return;
    const update = () => {
      const rect = dropdownRef.current?.getBoundingClientRect();
      if (!rect) return;
      const top = dropdownPosition === 'top' ? rect.top : rect.bottom;
      setCoords({ left: rect.left, top, width: Math.max(rect.width, 260) });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [isOpen, dropdownPosition]);



  return (
    <div className="relative" ref={dropdownRef}>
      {/* Campo de entrada */}
      <div
        className="w-full px-2 py-1.5 border border-gray-300 rounded-md bg-white cursor-pointer hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
        onClick={handleToggleDropdown}
      >
        <div className="flex flex-wrap gap-1 min-h-[18px]">
          {value.length > 0 ? (
            value.map(setor => (
              <span
                key={setor}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full"
              >
                {setor}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSetor(setor);
                  }}
                  className="text-blue-600 hover:text-blue-800"
                >
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="text-gray-500">{placeholder}</span>
          )}
        </div>
      </div>

             {/* Dropdown via Portal para evitar clipping */}
       {isOpen && ReactDOM.createPortal(
        <div
          ref={portalRef}
          style={{ position: 'fixed', left: coords.left, top: coords.top, width: coords.width, transform: dropdownPosition === 'top' ? 'translateY(-6px) translateY(-100%)' : 'translateY(6px)' }}
          className="z-[99999] max-w-[90vw] bg-white border border-gray-300 rounded-md shadow-lg max-h-80 overflow-y-auto"
          onMouseLeave={() => {
            setIsOpen(false);
            setSearchTerm('');
          }}
        >
          {/* Campo de busca */}
          <div className="sticky top-0 bg-white border-b border-gray-200 p-2">
            <input
              type="text"
              placeholder="Buscar setores..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Lista de setores */}
          <div className="py-1">
            {filteredSetores.length > 0 ? (
              filteredSetores.map(setor => (
                <div
                  key={setor}
                  className={`px-3 py-2 cursor-pointer hover:bg-gray-100 flex items-center gap-2 ${
                    value.includes(setor) ? 'bg-blue-50 text-blue-700' : ''
                  }`}
                  onClick={() => handleSetorToggle(setor)}
                >
                  <input
                    type="checkbox"
                    checked={value.includes(setor)}
                    onChange={() => {}}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm flex-1 whitespace-nowrap">{setor}</span>
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500">
                Nenhum setor encontrado
              </div>
            )}
          </div>

          {/* Botões de ação */}
          <div className="border-t border-gray-200 p-2 flex gap-2">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded"
            >
              Limpar
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded ml-auto"
            >
              Fechar
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default MultiSelectSetores;
