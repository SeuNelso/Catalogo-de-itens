import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ConfirmProvider } from './contexts/ConfirmContext';
import { ImportProgressProvider } from './contexts/ImportProgressContext';
import ImportProgressBar from './components/ImportProgressBar';
import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';
import Home from './pages/Home';
import Login from './pages/Login';
import CadastrarItem from './pages/CadastrarItem';
import ListarItens from './pages/ListarItens';
import DetalhesItem from './pages/DetalhesItem';
import EditarItem from './pages/EditarItem';
import ExcluirArtigo from './pages/ExcluirArtigo';
import ImportarExcel from './pages/ImportarExcel';
import ImportarStockNacional from './pages/ImportarStockNacional';
import ImportarDadosItens from './pages/ImportarDadosItens';
import CadastroUsuario from './pages/CadastroUsuario';
import AdminUsuarios from './pages/AdminUsuarios';
import ImportarItens from './pages/ImportarItens';
import ImportarImagensAutomaticas from './pages/ImportarImagensAutomaticas';
import DetectarImagensAutomaticas from './pages/DetectarImagensAutomaticas';
import ExportarDados from './pages/ExportarDados';
import ItensNaoCadastrados from './pages/ItensNaoCadastrados';
import ImportarSetores from './pages/ImportarSetores';
import ImportarUnidades from './pages/ImportarUnidades';
import ImportarRequisicao from './pages/ImportarRequisicao';
import ListarRequisicoes from './pages/ListarRequisicoes';
import ListarDevolucoes from './pages/ListarDevolucoes';
import TransferenciasHome from './pages/TransferenciasHome';
import CriarRequisicao from './pages/CriarRequisicao';
import EditarRequisicao from './pages/EditarRequisicao';
import PrepararRequisicao from './pages/PrepararRequisicao';
import Armazens from './pages/Armazens';
import ConsultaLocalizacoesEstoque from './pages/ConsultaLocalizacoesEstoque';
import TransferenciaLocalizacao from './pages/TransferenciaLocalizacao';
import ConsultaMovimentos from './pages/ConsultaMovimentos';
import Inventario from './pages/Inventario';
import ContagemSemanal from './pages/ContagemSemanal';
import './App.css';
import { ROLES_COM_ACESSO_REQUISICOES } from './utils/roles';

function RouteTracker() {
  const location = useLocation();

  useEffect(() => {
    const p = location.pathname || '/';
    // Guarda a última rota útil para o "voltar" do navegador.
    if (p !== '/' && p !== '/login') {
      sessionStorage.setItem('lastRoute', p);
    }
  }, [location.pathname]);

  return null;
}

function App() {
  const currentYear = new Date().getFullYear();

  return (
    <ImportProgressProvider>
      <AuthProvider>
        <ConfirmProvider>
        <Router>
          <RouteTracker />
          <div className="App min-h-screen bg-[#F7F8FA] flex flex-col">
            <Navbar />
            <div className="flex-1 pt-0">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />
                <Route path="/listar" element={<ProtectedRoute><ListarItens /></ProtectedRoute>} />
                <Route path="/item/:id" element={<DetalhesItem />} />
                <Route 
                  path="/editar/:id" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <EditarItem />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/excluir-artigo" 
                  element={
                    <ProtectedRoute allowedRoles={['admin']}>
                      <ExcluirArtigo />
                    </ProtectedRoute>
                  } 
                />
                {/* Rotas protegidas */}
                <Route 
                  path="/cadastrar" 
                  element={
                    <ProtectedRoute allowedRoles={['admin']}>
                      <CadastrarItem />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-excel" 
                  element={
                    <ProtectedRoute>
                      <ImportarExcel />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-stock-nacional" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <ImportarStockNacional />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-itens" 
                  element={
                    <ProtectedRoute allowedRoles={['admin']}>
                      <ImportarItens />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-dados-itens" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <ImportarDadosItens />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-imagens-automaticas" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <ImportarImagensAutomaticas />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/detectar-imagens-automaticas" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <DetectarImagensAutomaticas />
                    </ProtectedRoute>
                  } 
                />
                <Route path="/exportar" element={<ExportarDados />} />
                <Route 
                  path="/cadastro" 
                  element={
                    <ProtectedRoute allowedRoles={['admin']}>
                      <CadastroUsuario />
                    </ProtectedRoute>
                  } 
                />
                <Route
                  path="/admin-usuarios"
                  element={
                    <ProtectedRoute>
                      <AdminUsuarios />
                    </ProtectedRoute>
                  }
                />
                <Route 
                  path="/itens-nao-cadastrados" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller', 'backoffice_armazem', 'supervisor_armazem']}>
                      <ItensNaoCadastrados />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-setores" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <ImportarSetores />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/importar-unidades" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'controller']}>
                      <ImportarUnidades />
                    </ProtectedRoute>
                  } 
                />
                {/* Rotas de Requisições */}
                <Route 
                  path="/requisicoes" 
                  element={
                    <ProtectedRoute allowedRoles={[...ROLES_COM_ACESSO_REQUISICOES]}>
                      <ListarRequisicoes />
                    </ProtectedRoute>
                  } 
                />
                <Route
                  path="/devolucoes"
                  element={
                    <ProtectedRoute allowedRoles={[...ROLES_COM_ACESSO_REQUISICOES]}>
                      <ListarDevolucoes />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/transferencias"
                  element={
                    <ProtectedRoute allowedRoles={[...ROLES_COM_ACESSO_REQUISICOES]}>
                      <TransferenciasHome />
                    </ProtectedRoute>
                  }
                />
                <Route 
                  path="/requisicoes/criar" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem']}>
                      <CriarRequisicao />
                    </ProtectedRoute>
                  } 
                />
                <Route
                  path="/transferencias/criar"
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem']}>
                      <CriarRequisicao />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/transferencias/localizacao"
                  element={
                    <ProtectedRoute
                      requireControloStock
                    >
                      <TransferenciaLocalizacao />
                    </ProtectedRoute>
                  }
                />
                <Route 
                  path="/requisicoes/importar" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem']}>
                      <ImportarRequisicao />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/requisicoes/editar/:id" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem']}>
                      <EditarRequisicao />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/requisicoes/preparar/:id" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'operador', 'backoffice_armazem', 'supervisor_armazem']}>
                      <PrepararRequisicao />
                    </ProtectedRoute>
                  } 
                />
                <Route 
                  path="/armazens" 
                  element={
                    <ProtectedRoute allowedRoles={['admin', 'backoffice_armazem', 'supervisor_armazem']}>
                      <Armazens />
                    </ProtectedRoute>
                  } 
                />
                <Route
                  path="/consulta-estoque-localizacoes"
                  element={
                    <ProtectedRoute
                      requireControloStock
                    >
                      <ConsultaLocalizacoesEstoque />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/inventario"
                  element={
                    <ProtectedRoute
                      allowedRoles={['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador']}
                      requireControloStock
                    >
                      <Inventario />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/inventario/contagem-semanal"
                  element={
                    <ProtectedRoute
                      allowedRoles={['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador']}
                      requireControloStock
                    >
                      <ContagemSemanal />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/movimentos"
                  element={
                    <ProtectedRoute requireConsultaMovimentos>
                      <ConsultaMovimentos />
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </div>
            <footer className="border-t border-gray-200 bg-white/90 px-4 py-3 text-center text-xs text-gray-600">
              {`Copyright (c) ${currentYear} Catalogo de Itens. Todos os direitos reservados.`}
            </footer>
            {/* Renderizar a barra de progresso global */}
            <ImportProgressBar />
          </div>
        </Router>
        </ConfirmProvider>
      </AuthProvider>
    </ImportProgressProvider>
  );
}

export default App; 