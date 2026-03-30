import React from 'react';
import { useLocation } from 'react-router-dom';
import ListarRequisicoes from './ListarRequisicoes';
import TransferenciasRecebimento from './TransferenciasRecebimento';

const isTrueLike = (v) => ['1', 'true', 'yes', 'sim'].includes(String(v || '').toLowerCase());

const TransferenciasHome = () => {
  const location = useLocation();
  const params = new URLSearchParams(location.search || '');
  const modoRecebimento = isTrueLike(params.get('recebimento'));

  if (modoRecebimento) return <TransferenciasRecebimento />;
  return <ListarRequisicoes modo="transferencias" />;
};

export default TransferenciasHome;

