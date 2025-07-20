import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// Função específica para corrigir o ícone do catálogo inteligente
const fixCatalogIcon = () => {
  // Procurar por ícones dentro de elementos azuis na página inicial
  const blueElements = document.querySelectorAll('div[style*="background: #0915FF"], div[style*="background-color: #0915FF"]');
  
  blueElements.forEach(element => {
    const icons = element.querySelectorAll('svg');
    icons.forEach(icon => {
      // Forçar cor branca com máxima prioridade
      icon.style.setProperty('color', '#fff', 'important');
      icon.style.setProperty('fill', '#fff', 'important');
      icon.style.setProperty('stroke', '#fff', 'important');
      
      console.log('Ícone do catálogo corrigido para branco:', icon);
    });
  });
  
  // Procurar especificamente por ícones na página inicial
  const homeIcons = document.querySelectorAll('.Home-card svg, .Home-card * svg');
  homeIcons.forEach(icon => {
    const parentElement = icon.closest('div[style*="background: #0915FF"], div[style*="background-color: #0915FF"]');
    if (parentElement) {
      icon.style.setProperty('color', '#fff', 'important');
      icon.style.setProperty('fill', '#fff', 'important');
      icon.style.setProperty('stroke', '#fff', 'important');
      
      console.log('Ícone da página inicial corrigido para branco:', icon);
    }
  });
};

// Executar correção do ícone do catálogo imediatamente
fixCatalogIcon();

// Executar também quando a página carregar
document.addEventListener('DOMContentLoaded', fixCatalogIcon);

// Função específica para corrigir o botão "Criar Conta"
const fixCreateAccountButton = () => {
  const createAccountButtons = document.querySelectorAll('a[href="/cadastro"], .Home-link[href="/cadastro"]');
  
  createAccountButtons.forEach(button => {
    // Forçar fundo azul e texto branco com máxima prioridade
    button.style.setProperty('background', '#0915FF', 'important');
    button.style.setProperty('border', '1.5px solid #0915FF', 'important');
    button.style.setProperty('color', '#fff', 'important');
    button.style.setProperty('text-shadow', '0 1px 2px rgba(0, 0, 0, 0.1)', 'important');
    
    // Corrigir também o texto e ícone dentro do botão
    const textElements = button.querySelectorAll('*');
    textElements.forEach(element => {
      element.style.setProperty('color', '#fff', 'important');
      element.style.setProperty('text-shadow', '0 1px 2px rgba(0, 0, 0, 0.1)', 'important');
    });
    
    // Corrigir especificamente o ícone
    const icon = button.querySelector('svg');
    if (icon) {
      icon.style.setProperty('color', '#fff', 'important');
    }
    
    console.log('Botão Criar Conta corrigido para azul:', button);
  });
};

// Executar correção do botão "Criar Conta" imediatamente
fixCreateAccountButton();

// Executar também quando a página carregar
document.addEventListener('DOMContentLoaded', fixCreateAccountButton);

// Função específica para corrigir o botão de login na página inicial
const fixLoginButton = () => {
  const loginButtons = document.querySelectorAll('a[href="/login"], .Home-link');
  
  loginButtons.forEach(button => {
    // Verificar se o botão tem fundo azul
    const computedStyle = window.getComputedStyle(button);
    const backgroundColor = computedStyle.backgroundColor;
    
    if (backgroundColor.includes('rgb(9, 21, 255)') || // #0915FF
        backgroundColor.includes('rgb(76, 99, 255)') || // #4C63FF
        backgroundColor.includes('#0915FF') ||
        backgroundColor.includes('#4C63FF')) {
      
      // Forçar cor branca com máxima prioridade
      button.style.setProperty('color', '#fff', 'important');
      button.style.setProperty('text-shadow', '0 1px 2px rgba(0, 0, 0, 0.1)', 'important');
      
      // Corrigir também o texto dentro do botão
      const textElements = button.querySelectorAll('*');
      textElements.forEach(element => {
        element.style.setProperty('color', '#fff', 'important');
        element.style.setProperty('text-shadow', '0 1px 2px rgba(0, 0, 0, 0.1)', 'important');
      });
      
      console.log('Botão Login corrigido para branco:', button);
    }
  });
};

// Executar correção do botão de login imediatamente
fixLoginButton();

// Executar também quando a página carregar
document.addEventListener('DOMContentLoaded', fixLoginButton);

// Função específica para corrigir o botão SAIR
const fixLogoutButton = () => {
  const logoutButtons = document.querySelectorAll('.navbar-digi-logout, .navbar-digi-mobile-logout');
  
  logoutButtons.forEach(button => {
    // Forçar cor azul com máxima prioridade
    button.style.setProperty('color', '#0915FF', 'important');
    button.style.setProperty('background', '#fff', 'important');
    button.style.setProperty('font-weight', '700', 'important');
    button.style.setProperty('text-shadow', 'none', 'important');
    
    // Corrigir também o texto dentro do botão
    const textElements = button.querySelectorAll('*');
    textElements.forEach(element => {
      element.style.setProperty('color', '#0915FF', 'important');
      element.style.setProperty('text-shadow', 'none', 'important');
    });
    
    console.log('Botão SAIR corrigido:', button);
  });
};

// Executar correção do botão SAIR imediatamente
fixLogoutButton();

// Executar também quando a página carregar
document.addEventListener('DOMContentLoaded', fixLogoutButton);

// Script para detectar e corrigir problemas de texto em branco
const fixInvisibleText = () => {
  // Função para verificar se um elemento tem texto visível
  const hasVisibleText = (element) => {
    const computedStyle = window.getComputedStyle(element);
    const color = computedStyle.color;
    const backgroundColor = computedStyle.backgroundColor;
    
    // Verificar se a cor do texto é muito clara ou transparente
    if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent' || 
        color === 'rgba(255, 255, 255, 1)' || color === 'white') {
      return false;
    }
    
    return true;
  };

  // Função para verificar se um elemento tem fundo azul
  const hasBlueBackground = (element) => {
    const computedStyle = window.getComputedStyle(element);
    const backgroundColor = computedStyle.backgroundColor;
    
    // Verificar se o fundo é azul
    return backgroundColor.includes('rgb(9, 21, 255)') || // #0915FF
           backgroundColor.includes('rgb(76, 99, 255)') || // #4C63FF
           backgroundColor.includes('rgb(6, 11, 204)') ||  // #060BCC
           backgroundColor.includes('#0915FF') ||
           backgroundColor.includes('#4C63FF') ||
           backgroundColor.includes('#060BCC');
  };

  // Função para corrigir texto invisível
  const fixElement = (element) => {
    const isNavbar = element.closest('.navbar-digi');
    const hasBlue = hasBlueBackground(element);
    
    if (isNavbar || hasBlue) {
      element.style.color = '#fff !important';
      element.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.1)';
    } else {
      element.style.color = '#333 !important';
    }
    
    element.style.textRendering = 'optimizeLegibility';
    element.style.fontDisplay = 'swap';
  };

  // Verificar todos os elementos de texto
  const textElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, a, button, input, textarea, label, td, th, svg');
  
  textElements.forEach(element => {
    const isNavbar = element.closest('.navbar-digi');
    const hasBlue = hasBlueBackground(element);
    const parentHasBlue = element.closest('[style*="background"]') && hasBlueBackground(element.closest('[style*="background"]'));
    const isLogoutButton = element.classList.contains('navbar-digi-logout') || 
                          element.classList.contains('navbar-digi-mobile-logout') ||
                          element.textContent === 'SAIR' ||
                          element.textContent === 'Sair' ||
                          element.textContent === 'sair';
    const isCameraButton = element.textContent && element.textContent.toLowerCase().includes('câmera') || 
                          element.textContent && element.textContent.toLowerCase().includes('camera') ||
                          element.textContent && element.textContent.toLowerCase().includes('tirar foto') ||
                          element.textContent && element.textContent.toLowerCase().includes('enviar imagem');
    const isLoginButton = element.textContent === 'Login' ||
                         element.textContent === 'login' ||
                         element.closest('a[href="/login"]') ||
                         element.classList.contains('Home-link');
    const isCreateAccountButton = element.textContent === 'Criar Conta' ||
                                 element.textContent === 'criar conta' ||
                                 element.closest('a[href="/cadastro"]') ||
                                 (element.classList.contains('Home-link') && element.closest('a[href="/cadastro"]'));
    const isGrayIcon = element.tagName === 'SVG' && (
                       element.style.color === 'rgb(128, 128, 128)' ||
                       element.style.color === '#808080' ||
                       element.style.color === 'gray' ||
                       element.style.color === 'grey' ||
                       element.style.fill === 'rgb(128, 128, 128)' ||
                       element.style.fill === '#808080' ||
                       element.style.fill === 'gray' ||
                       element.style.fill === 'grey'
                     );
    
    // Corrigir botão SAIR para azul - PRIORIDADE MÁXIMA
    if (isLogoutButton) {
      element.style.setProperty('color', '#0915FF', 'important');
      element.style.setProperty('background', '#fff', 'important');
      element.style.setProperty('font-weight', '700', 'important');
      element.style.setProperty('text-shadow', 'none', 'important');
      console.log('Botão SAIR corrigido para azul:', element);
    }
    // Corrigir ícones cinzas para branco
    else if (isGrayIcon && (hasBlue || parentHasBlue)) {
      element.style.setProperty('color', '#fff', 'important');
      element.style.setProperty('fill', '#fff', 'important');
      element.style.setProperty('stroke', '#fff', 'important');
      console.log('Ícone cinza corrigido para branco:', element);
    }
    // Corrigir botão "Criar Conta" para azul com texto branco
    else if (isCreateAccountButton) {
      element.style.setProperty('background', '#0915FF', 'important');
      element.style.setProperty('border', '1.5px solid #0915FF', 'important');
      element.style.setProperty('color', '#fff', 'important');
      element.style.setProperty('text-shadow', '0 1px 2px rgba(0, 0, 0, 0.1)', 'important');
      console.log('Botão Criar Conta corrigido para azul:', element);
    }
    // Corrigir botão de login para branco
    else if (isLoginButton && (hasBlue || parentHasBlue)) {
      element.style.setProperty('color', '#fff', 'important');
      element.style.setProperty('text-shadow', '0 1px 2px rgba(0, 0, 0, 0.1)', 'important');
      console.log('Botão Login corrigido para branco:', element);
    }
    // Corrigir botão da câmera para branco
    else if (isCameraButton || (hasBlue && isCameraButton)) {
      element.style.color = '#fff !important';
      element.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.1)';
    }
    // Corrigir se for navbar, tem fundo azul, ou está dentro de elemento azul
    else if (isNavbar || hasBlue || parentHasBlue) {
      element.style.color = '#fff !important';
      element.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.1)';
    } else if (!hasVisibleText(element)) {
      element.style.color = '#333 !important';
    }
    
    element.style.textRendering = 'optimizeLegibility';
    element.style.fontDisplay = 'swap';
  });

  // Verificar especificamente cabeçalhos de tabela
  const tableHeaders = document.querySelectorAll('table thead, table thead th, table thead td, thead, thead th, thead td');
  tableHeaders.forEach(header => {
    header.style.backgroundColor = '#0915FF !important';
    header.style.color = '#fff !important';
    
    const headerElements = header.querySelectorAll('*');
    headerElements.forEach(element => {
      element.style.color = '#fff !important';
      element.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.1)';
    });
  });
};

// Executar a correção quando a página carregar
document.addEventListener('DOMContentLoaded', fixInvisibleText);

// Executar a correção periodicamente para capturar elementos carregados dinamicamente
setInterval(fixInvisibleText, 2000);

// Executar a correção quando a janela ganhar foco
window.addEventListener('focus', fixInvisibleText);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
); 