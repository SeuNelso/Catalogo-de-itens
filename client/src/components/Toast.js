import React, { useEffect } from 'react';

const Toast = ({ type = 'success', message, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const colors = {
    success: 'bg-green-500 text-white',
    error: 'bg-red-500 text-white',
    warning: 'bg-yellow-500 text-gray-900',
    info: 'bg-blue-500 text-white',
  };

  return (
    <div className={`fixed top-6 right-6 z-[9999] px-6 py-4 rounded-lg shadow-lg flex items-center gap-3 animate-fade-in ${colors[type]}`}
      role="alert"
      aria-live="assertive"
    >
      <span className="font-semibold capitalize">{type === 'success' ? 'Sucesso' : type === 'error' ? 'Erro' : type === 'warning' ? 'Aviso' : 'Info'}:</span>
      <span>{message}</span>
      <button onClick={onClose} className="ml-4 text-lg font-bold opacity-70 hover:opacity-100" aria-label="Fechar">×</button>
    </div>
  );
};

export default Toast; 