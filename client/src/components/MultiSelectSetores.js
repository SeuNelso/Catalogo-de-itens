import React, { useState, useRef, useEffect } from 'react';

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
  const dropdownRef = useRef(null);

  // Fechar dropdown quando clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
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



  return (
    <div className="relative" ref={dropdownRef}>
      {/* Campo de entrada */}
      <div
        className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white cursor-pointer hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex flex-wrap gap-1 min-h-[20px]">
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

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto">
          {/* Campo de busca */}
          <div className="sticky top-0 bg-white border-b border-gray-200 p-2">
            <input
              type="text"
              placeholder="Buscar setores..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              onClick={(e) => e.stopPropagation()}
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
                    onChange={() => {}} // Controlado pelo onClick do div
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm">{setor}</span>
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
        </div>
      )}
    </div>
  );
};

export default MultiSelectSetores;
