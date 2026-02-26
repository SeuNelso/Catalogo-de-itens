import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const resolveRef = useRef(null);
  const [state, setState] = useState({
    open: false,
    title: 'Confirmar',
    message: '',
    confirmLabel: 'Sim',
    cancelLabel: 'Cancelar',
    variant: 'primary' // 'primary' | 'danger' | 'warning'
  });

  const confirm = useCallback((options = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({
        open: true,
        title: options.title ?? 'Confirmar',
        message: options.message ?? 'Tem certeza?',
        confirmLabel: options.confirmLabel ?? 'Sim',
        cancelLabel: options.cancelLabel ?? 'Cancelar',
        variant: options.variant ?? 'primary'
      });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    resolveRef.current?.(true);
    resolveRef.current = null;
    setState(s => ({ ...s, open: false }));
  }, []);

  const handleCancel = useCallback(() => {
    resolveRef.current?.(false);
    resolveRef.current = null;
    setState(s => ({ ...s, open: false }));
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {state.open && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/50" aria-modal="true" role="dialog">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 animate-fade-in">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">{state.title}</h3>
            <p className="text-gray-600 mb-6">{state.message}</p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium transition-colors"
              >
                {state.cancelLabel}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  state.variant === 'danger'
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : state.variant === 'warning'
                    ? 'bg-amber-500 text-gray-900 hover:bg-amber-600'
                    : 'bg-[#0915FF] text-white hover:bg-[#070FCC]'
                }`}
              >
                {state.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx.confirm;
}
