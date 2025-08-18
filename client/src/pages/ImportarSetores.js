import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Toast from '../components/Toast';

const ImportarSetores = () => {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('success');
  const [importResult, setImportResult] = useState(null);

  // Verificar se o usuário está autenticado
  if (!user || !isAuthenticated) {
    navigate('/login');
    return null;
  }

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      // Verificar se é um arquivo Excel
      const fileExtension = selectedFile.name.split('.').pop().toLowerCase();
      if (fileExtension !== 'xlsx' && fileExtension !== 'xls') {
        setToastMessage('Por favor, selecione um arquivo Excel (.xlsx ou .xls)');
        setToastType('error');
        setShowToast(true);
        setFile(null);
        e.target.value = '';
        return;
      }
      setFile(selectedFile);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setToastMessage('Por favor, selecione um arquivo para importar');
      setToastType('error');
      setShowToast(true);
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('file', file);

    try {
      // Iniciar progresso de upload
      setUploadProgress(10);

             // Obter token do localStorage
       const token = localStorage.getItem('token');
       
       if (!token) {
         setToastMessage('Sessão expirada. Faça login novamente.');
         setToastType('error');
         setShowToast(true);
         setIsUploading(false);
         setUploadProgress(0);
         navigate('/login');
         return;
       }
       
       const response = await fetch('/api/importar-setores', {
         method: 'POST',
         headers: {
           'Authorization': `Bearer ${token}`
         },
         body: formData,
       });

      if (response.ok) {
        // Progresso de processamento
        setUploadProgress(50);
        
        const result = await response.json();
        
        // Progresso final
        setUploadProgress(100);
        
        // Aguardar um pouco para mostrar 100%
        setTimeout(() => {
          setToastMessage(`Importação concluída! ${result.sucesso} itens processados com sucesso.`);
          setToastType('success');
          setFile(null);
          setImportResult(result);
          // Limpar o input de arquivo
          document.getElementById('file-input').value = '';
          setShowToast(true);
          setIsUploading(false);
          setUploadProgress(0);
        }, 500);
      } else {
        const result = await response.json();
        setToastMessage(result.error || 'Erro durante a importação');
        setToastType('error');
        setShowToast(true);
        setIsUploading(false);
        setUploadProgress(0);
      }
    } catch (error) {
      setToastMessage('Erro de conexão. Tente novamente.');
      setToastType('error');
      setShowToast(true);
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const downloadTemplate = async () => {
    try {
      // Obter token do localStorage
      const token = localStorage.getItem('token');
      
      if (!token) {
        setToastMessage('Sessão expirada. Faça login novamente.');
        setToastType('error');
        setShowToast(true);
        navigate('/login');
        return;
      }
      
      const response = await fetch('/api/download-template-setores', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'template_setores.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      } else {
        const result = await response.json();
        setToastMessage(result.error || 'Erro ao baixar template');
        setToastType('error');
        setShowToast(true);
      }
    } catch (error) {
      setToastMessage('Erro ao baixar template');
      setToastType('error');
      setShowToast(true);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Importar Setores
          </h1>
          <p className="text-gray-600">
            Importe setores para os itens do catálogo a partir de um arquivo Excel
          </p>
        </div>

        {/* Card Principal */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Upload do Arquivo
            </h2>
            
            {/* Área de Upload */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors">
              <div className="mb-4">
                <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                  <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              
              <div className="mb-4">
                <label htmlFor="file-input" className="cursor-pointer">
                  <span className="text-blue-600 hover:text-blue-500 font-medium">
                    Clique para selecionar
                  </span>
                  <span className="text-gray-500"> ou arraste e solte</span>
                </label>
                <input
                  id="file-input"
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                  className="hidden"
                  disabled={isUploading}
                />
              </div>
              
              <p className="text-sm text-gray-500">
                Apenas arquivos Excel (.xlsx, .xls) são aceitos
              </p>
              
              {file && (
                <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-md">
                  <p className="text-sm text-green-800">
                    <strong>Arquivo selecionado:</strong> {file.name}
                  </p>
                  <p className="text-xs text-green-600 mt-1">
                    Tamanho: {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              )}
            </div>
          </div>

                     {/* Barra de Progresso */}
           {isUploading && (
             <div className="mb-6">
               <div className="flex justify-between text-sm text-gray-600 mb-2">
                 <span>
                   {uploadProgress < 30 ? 'Enviando arquivo...' : 
                    uploadProgress < 80 ? 'Processando dados...' : 
                    'Finalizando...'}
                 </span>
                 <span>{uploadProgress}%</span>
               </div>
               <div className="w-full bg-gray-200 rounded-full h-3 relative overflow-hidden">
                 <div
                   className="bg-blue-600 h-3 rounded-full transition-all duration-500 ease-out"
                   style={{ width: `${uploadProgress}%` }}
                 ></div>
                 {uploadProgress === 100 && (
                   <div className="absolute inset-0 flex items-center justify-center">
                     <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                       <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                     </svg>
                   </div>
                 )}
               </div>
               <div className="mt-2 text-xs text-gray-500">
                 {uploadProgress < 30 && 'Enviando arquivo para o servidor...'}
                 {uploadProgress >= 30 && uploadProgress < 80 && 'Validando e processando setores...'}
                 {uploadProgress >= 80 && 'Salvando alterações no banco de dados...'}
               </div>
             </div>
           )}

          {/* Botões */}
          <div className="flex flex-col sm:flex-row gap-4">
            <button
              onClick={handleUpload}
              disabled={!file || isUploading}
              className={`flex-1 px-6 py-3 rounded-md font-medium text-white transition-colors ${
                !file || isUploading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {isUploading ? 'Importando...' : 'Importar Setores'}
            </button>
            
            <button
              onClick={downloadTemplate}
              className="px-6 py-3 border border-gray-300 rounded-md font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Baixar Template
            </button>
          </div>
        </div>

        {/* Instruções */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Instruções
          </h2>
          
          <div className="space-y-4">
            <div>
              <h3 className="font-medium text-gray-900 mb-2">Estrutura do Arquivo Excel:</h3>
              <div className="bg-gray-50 p-4 rounded-md">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-3 bg-gray-100">Artigo</th>
                      <th className="text-left py-2 px-3 bg-gray-100">SETOR</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2 px-3">3000003</td>
                      <td className="py-2 px-3">MOVEL</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2 px-3">3000020</td>
                      <td className="py-2 px-3">MOVEL, FIBRA</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3">3000022</td>
                      <td className="py-2 px-3">FIBRA, CLIENTE, ENGENHARIA</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="font-medium text-gray-900 mb-2">Setores Válidos:</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 text-sm">
                {[
                  'CLIENTE', 'ENGENHARIA', 'FIBRA', 'FROTA',
                  'IT', 'LOGISTICA', 'MARKETING', 'MOVEL',
                  'NOWO', 'FERRAMENTA', 'EPI', 'EPC'
                ].map(setor => (
                  <span key={setor} className="bg-blue-50 text-blue-700 px-2 py-1 rounded">
                    {setor}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <h3 className="font-medium text-gray-900 mb-2">Regras Importantes:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-600">
                <li>Apenas códigos que existem no sistema serão processados</li>
                <li>Setores inválidos serão ignorados</li>
                <li>Para múltiplos setores, separe por vírgula na mesma célula</li>
                <li>Setores duplicados são removidos automaticamente</li>
                <li>Os setores são convertidos para maiúsculas automaticamente</li>
              </ul>
            </div>
          </div>
                 </div>
       </div>

       {/* Resultados da Importação */}
       {importResult && (
         <div className="bg-white rounded-lg shadow-md p-6 mb-6">
           <h2 className="text-xl font-semibold text-gray-900 mb-4">
             Resultados da Importação
           </h2>
           
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
             <div className="bg-green-50 border border-green-200 rounded-lg p-4">
               <div className="text-2xl font-bold text-green-600">{importResult.sucesso}</div>
               <div className="text-sm text-green-700">Itens Processados</div>
             </div>
             
             <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
               <div className="text-2xl font-bold text-blue-600">{importResult.total}</div>
               <div className="text-sm text-blue-700">Total de Linhas</div>
             </div>
             
             {importResult.erros > 0 && (
               <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                 <div className="text-2xl font-bold text-red-600">{importResult.erros}</div>
                 <div className="text-sm text-red-700">Erros</div>
               </div>
             )}
             
             {importResult.itensNaoEncontrados > 0 && (
               <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                 <div className="text-2xl font-bold text-yellow-600">{importResult.itensNaoEncontrados}</div>
                 <div className="text-sm text-yellow-700">Itens Não Encontrados</div>
               </div>
             )}
           </div>

           {importResult.detalhes && importResult.detalhes.length > 0 && (
             <div>
               <h3 className="font-medium text-gray-900 mb-3">Detalhes dos Erros:</h3>
               <div className="bg-gray-50 rounded-lg p-4 max-h-60 overflow-y-auto">
                 {importResult.detalhes.slice(0, 10).map((detalhe, index) => (
                   <div key={index} className="text-sm text-gray-700 mb-2 p-2 bg-white rounded border">
                     <strong>Linha {detalhe.linha}:</strong> {detalhe.codigo} - {detalhe.erro}
                     {detalhe.setoresInvalidos && (
                       <div className="text-xs text-red-600 mt-1">
                         Setores inválidos: {detalhe.setoresInvalidos.join(', ')}
                       </div>
                     )}
                   </div>
                 ))}
                 {importResult.detalhes.length > 10 && (
                   <div className="text-sm text-gray-500 mt-2">
                     ... e mais {importResult.detalhes.length - 10} erros
                   </div>
                 )}
               </div>
             </div>
           )}

           <div className="mt-4 flex justify-end">
             <button
               onClick={() => setImportResult(null)}
               className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
             >
               Fechar Resultados
             </button>
           </div>
         </div>
       )}

       {/* Toast */}
       {showToast && (
         <Toast
           message={toastMessage}
           type={toastType}
           onClose={() => setShowToast(false)}
         />
       )}
     </div>
   );
 };

export default ImportarSetores;
