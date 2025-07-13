import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
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
import './App.css';

function App() {
  return (
    <AuthProvider>
      <Router>
        <div className="App min-h-screen bg-[#F7F8FA] flex flex-col">
          <Navbar />
          <div className="flex-1 pt-16">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/listar" element={<ListarItens />} />
              <Route path="/item/:id" element={<DetalhesItem />} />
              <Route path="/editar/:id" element={<ProtectedRoute><EditarItem /></ProtectedRoute>} />
              <Route path="/excluir-artigo" element={<ProtectedRoute><ExcluirArtigo /></ProtectedRoute>} />
              {/* Rotas protegidas */}
              <Route 
                path="/cadastrar" 
                element={
                  <ProtectedRoute>
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
            </Routes>
          </div>
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App; 