import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

/**
 * Modal que abre a câmera e lê um QR code. Ao detectar, chama onScan(texto) e fecha.
 * O conteúdo do QR deve ser o texto da localização (ex: "EXPEDIÇÃO.E").
 */
const QrScannerModal = ({ open, onClose, onScan, title = 'Ler localização por QR Code' }) => {
  const scannerRef = useRef(null);
  const scannedRef = useRef(false);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    if (!open) return;
    scannedRef.current = false;

    let mounted = true;
    const startScanner = async () => {
      try {
        setErro(null);
        const html5Qr = new Html5Qrcode('qr-reader-localizacao');
        scannerRef.current = html5Qr;

        const cameras = await Html5Qrcode.getCameras();
        const backCamera = cameras.find(c => c.label.toLowerCase().includes('back') || c.label.toLowerCase().includes('trás'));
        const cameraId = backCamera?.id || (cameras.length > 0 ? cameras[0].id : null);
        if (!cameraId) {
          setErro('Nenhuma câmera encontrada.');
          return;
        }

        await html5Qr.start(
          cameraId,
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1
          },
          (decodedText) => {
            if (!mounted || !scannerRef.current || scannedRef.current) return;
            const text = (decodedText || '').trim();
            if (text) {
              scannedRef.current = true;
              scannerRef.current.stop().catch(() => {});
              scannerRef.current = null;
              onScan(text);
              onClose();
            }
          },
          () => {}
        );
      } catch (e) {
        if (mounted) {
          setErro(e?.message || 'Não foi possível aceder à câmera. Verifique as permissões.');
        }
      }
    };

    startScanner();
    return () => {
      mounted = false;
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, [open, onScan, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={() => { if (scannerRef.current) scannerRef.current.stop().catch(() => {}); onClose(); }}
            className="text-gray-500 hover:text-gray-700 p-1"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          {erro ? (
            <p className="text-red-600 text-sm">{erro}</p>
          ) : (
            <div id="qr-reader-localizacao" className="rounded-lg overflow-hidden" />
          )}
        </div>
        <div className="p-4 border-t border-gray-200">
          <button
            type="button"
            onClick={() => { if (scannerRef.current) scannerRef.current.stop().catch(() => {}); onClose(); }}
            className="w-full py-2 px-4 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
};

export default QrScannerModal;
