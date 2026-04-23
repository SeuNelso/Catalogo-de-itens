import React from 'react';
import { FaSearch, FaQrcode } from 'react-icons/fa';

const inputClassComIcone =
  'w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#0915FF]';
const inputClassSemIcone =
  'w-full pl-3 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#0915FF]';

const btnLerClass =
  'shrink-0 px-3 py-2 border border-gray-300 rounded-lg text-sm flex items-center justify-center gap-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-45 disabled:cursor-not-allowed';

/**
 * Caixa de pesquisa + botão «Ler» (QR/código de barras), padrão da página Consulta.
 */
const PesquisaComLeitorQr = ({
  value,
  onChange,
  onLerClick,
  placeholder,
  inputType = 'text',
  disabled = false,
  lerDisabled = false,
  lerTitle = 'Ler QR ou código de barras',
  lerAriaLabel,
  showSearchIcon = true,
  className = 'flex gap-2 min-w-0',
  inputClassName,
  autoComplete = 'off',
  name,
  id,
  fontMono = false,
  onKeyDown,
  onFocus
}) => {
  const baseInput = inputClassName || (showSearchIcon ? inputClassComIcone : inputClassSemIcone);
  const inputCn = [baseInput, fontMono ? 'font-mono' : ''].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <div className="relative flex-1 min-w-0">
        {showSearchIcon ? (
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
        ) : null}
        <input
          type={inputType}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          placeholder={placeholder}
          disabled={disabled}
          className={inputCn}
          autoComplete={autoComplete}
          name={name}
          id={id}
        />
      </div>
      <button
        type="button"
        onClick={onLerClick}
        disabled={lerDisabled || disabled}
        className={btnLerClass}
        title={lerTitle}
        aria-label={lerAriaLabel || lerTitle}
      >
        <FaQrcode className="text-base text-[#0915FF]" />
        <span className="hidden sm:inline whitespace-nowrap">Ler</span>
      </button>
    </div>
  );
};

export default PesquisaComLeitorQr;
