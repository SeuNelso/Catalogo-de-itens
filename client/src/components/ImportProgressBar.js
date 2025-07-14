import React from 'react';
import { useImportProgress } from '../contexts/ImportProgressContext';

const ImportProgressBar = () => {
  const { status, progress } = useImportProgress();
  if (status !== 'progresso' || !progress || !progress.total) return null;
  const percent = Math.round((progress.processados / progress.total) * 100);
  return (
    <div style={{
      position: 'fixed',
      left: 24,
      bottom: 24,
      zIndex: 9999,
      background: '#fff',
      borderRadius: 12,
      boxShadow: '0 4px 16px rgba(9,21,255,0.10)',
      padding: '18px 28px',
      minWidth: 260,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 8
    }}>
      <span style={{ color: '#0915FF', fontWeight: 700, fontSize: 16 }}>
        Importando: {progress.processados} de {progress.total} ({percent}%)
      </span>
      <div style={{ width: 200, height: 14, background: '#e5e7eb', borderRadius: 8, overflow: 'hidden', marginTop: 2 }}>
        <div style={{
          width: `${percent}%`,
          height: '100%',
          background: '#0915FF',
          transition: 'width 0.3s',
          borderRadius: 8
        }} />
      </div>
      {progress.erros && progress.erros.length > 0 && (
        <span style={{ color: '#ef4444', fontWeight: 500, fontSize: 13 }}>
          {progress.erros.length} erro(s) até agora
        </span>
      )}
    </div>
  );
};

export default ImportProgressBar; 