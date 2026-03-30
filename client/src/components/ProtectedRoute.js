import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { podeUsarControloStock } from '../utils/controloStock';

const ProtectedRoute = ({ children, allowedRoles, requireControloStock }) => {
  const { isAuthenticated, loading, user } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && ((!user) || (!allowedRoles.includes(user.role)))) {
    return <Navigate to="/" replace />;
  }

  if (requireControloStock && !podeUsarControloStock(user)) {
    return <Navigate to="/" replace />;
  }

  return children;
};

export default ProtectedRoute; 