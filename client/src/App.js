import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
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
import CadastroUsuario from './pages/CadastroUsuario';
import AdminUsuarios from './pages/AdminUsuarios';
import ImportarItens from './pages/ImportarItens';
import ExportarDados from './pages/ExportarDados';
import './App.css';

function App() {
  return (
    <ImportProgressProvider>
      <AuthProvider>
        <Router>
          <div className="App min-h-screen bg-[#F7F8FA] flex flex-col">
            <Navbar />
            <div className="flex-1 pt-16">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />
                <Route path="/listar" element={<ProtectedRoute><ListarItens /></ProtectedRoute>} />
                <Route path="/item/:id" element={<DetalhesItem />} />
                <Route path="/editar/:id" element={<ProtectedRoute><EditarItem /></ProtectedRoute>} />
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
                <Route path="/exportar" element={<ExportarDados />} />
                <Route path="/cadastro" element={<CadastroUsuario />} />
                <Route 
                  path="/admin-usuarios" 
                  element={
                    <ProtectedRoute allowedRoles={['admin']}>
                      <AdminUsuarios />
                    </ProtectedRoute>
                  } 
                />
              </Routes>
            </div>
            {/* Renderizar a barra de progresso global */}
            <ImportProgressBar />
          </div>
        </Router>
      </AuthProvider>
    </ImportProgressProvider>
  );
}

export default App; 