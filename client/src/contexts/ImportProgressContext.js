import React, { createContext, useContext, useState, useRef } from 'react';

const ImportProgressContext = createContext();

export function ImportProgressProvider({ children }) {
  const [status, setStatus] = useState(''); // '', 'progresso', 'sucesso', 'erro'
  const [importId, setImportId] = useState(null);
  const [progress, setProgress] = useState(null); // { total, processados, status, erros }
  const pollingRef = useRef(null);

  // Iniciar importação: recebe importId e rota opcional
  const startImport = (id, customRoute = null) => {
    setImportId(id);
    setStatus('progresso');
    setProgress(null);
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const token = localStorage.getItem('token');
        const route = customRoute || `/api/importar-excel-status/${id}`;
        const resp = await fetch(route, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (resp.ok) {
          const data = await resp.json();
          setProgress(data);
          if (data.status === 'concluido' || data.status === 'erro') {
            clearInterval(pollingRef.current);
            setImportId(null);
            setStatus(data.status === 'concluido' ? 'sucesso' : 'erro');
          }
        } else {
          clearInterval(pollingRef.current);
          setImportId(null);
          setStatus('erro');
        }
      } catch (err) {
        clearInterval(pollingRef.current);
        setImportId(null);
        setStatus('erro');
      }
    }, 2000);
  };

  // Resetar barra
  const resetImport = () => {
    setStatus('');
    setImportId(null);
    setProgress(null);
    if (pollingRef.current) clearInterval(pollingRef.current);
  };

  return (
    <ImportProgressContext.Provider value={{ status, importId, progress, startImport, resetImport }}>
      {children}
    </ImportProgressContext.Provider>
  );
}

export function useImportProgress() {
  return useContext(ImportProgressContext);
} 