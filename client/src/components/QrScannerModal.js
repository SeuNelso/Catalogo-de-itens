import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
const INITIAL_ZOOM = 2.7;

/** Evita exceção/rejeição "Cannot stop, scanner is not running or paused" (duplo stop ou race no unmount). */
function safeStopScanner(instance) {
  if (!instance) return;
  try {
    const ret = instance.stop();
    if (ret != null && typeof ret.then === 'function') {
      ret.catch(() => {});
    }
  } catch {
    /* já parado ou nunca iniciou */
  }
}

/**
 * Modal que abre a câmera e lê QR code / código de barras.
 * Ao detectar, chama onScan(texto) e fecha.
 */
const QrScannerModal = ({
  open,
  onClose,
  onScan,
  title = 'Ler localização por QR Code',
  readerId = 'qr-reader-localizacao',
  formatsToSupport = null,
  closeOnScan = true
}) => {
  const scannerRef = useRef(null);
  const lastScanRef = useRef({ text: '', at: 0 });
  const [erro, setErro] = useState(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomValue, setZoomValue] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1, step: 0.1 });

  useEffect(() => {
    if (!open) return;
    lastScanRef.current = { text: '', at: 0 };
    setTorchSupported(false);
    setTorchOn(false);
    setZoomSupported(false);
    setZoomValue(1);
    setZoomRange({ min: 1, max: 1, step: 0.1 });

    let mounted = true;
    const probeCameraAccess = async () => {
      if (!navigator?.mediaDevices?.getUserMedia) return null;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        let deviceId = null;
        try {
          const track = stream.getVideoTracks?.()[0];
          const settings = track?.getSettings?.() || {};
          deviceId = settings?.deviceId || null;
        } catch {}
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {}
        return { deviceId };
      } catch (err) {
        return { error: err };
      }
    };
    const errorText = (err) => {
      if (!err) return '';
      const name = String(err?.name || '').trim();
      const msg = String(err?.message || '').trim();
      const constraint = String(err?.constraint || '').trim();
      const base = [name, msg].filter(Boolean).join(': ');
      if (constraint) return `${base || 'Erro'} (constraint: ${constraint})`;
      return base || String(err);
    };
    const readTrackCapabilities = (instance) => {
      if (!instance || typeof instance.getRunningTrackCapabilities !== 'function') return;
      try {
        const caps = instance.getRunningTrackCapabilities() || {};
        const hasTorch = caps.torch === true;
        if (mounted) setTorchSupported(Boolean(hasTorch));
        if (caps.zoom && typeof caps.zoom === 'object') {
          const min = Number.isFinite(Number(caps.zoom.min)) ? Number(caps.zoom.min) : 1;
          const max = Number.isFinite(Number(caps.zoom.max)) ? Number(caps.zoom.max) : min;
          const step = Number.isFinite(Number(caps.zoom.step)) ? Number(caps.zoom.step) : 0.1;
          if (max > min && mounted) {
            setZoomSupported(true);
            setZoomRange({ min, max, step });
            const target = Math.min(max, Math.max(min, INITIAL_ZOOM));
            setZoomValue(target);
            if (typeof instance.applyVideoConstraints === 'function') {
              instance.applyVideoConstraints({ advanced: [{ zoom: target }] }).catch(() => {});
            }
          }
        }
      } catch {
        // Alguns browsers não expõem capabilities completas.
      }
    };
    const startScanner = async () => {
      try {
        setErro(null);
        const probe = await probeCameraAccess();
        if (probe?.error) {
          throw probe.error;
        }
        const html5Qr = new Html5Qrcode(readerId);
        scannerRef.current = html5Qr;
        const isMobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');

        const qrConfig = {
          fps: 15,
          // Área de leitura maior ajuda quando o QR é pequeno no enquadramento.
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const side = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.85);
            return { width: side, height: side };
          },
          aspectRatio: 1,
          disableFlip: true,
          ...(Array.isArray(formatsToSupport) && formatsToSupport.length > 0
            ? { formatsToSupport }
            : {})
        };

        const onDecoded = (decodedText) => {
          if (!mounted || !scannerRef.current) return;
          const text = (decodedText || '').trim();
          if (text) {
            const now = Date.now();
            const last = lastScanRef.current;
            if (last.text === text && now - last.at < 1200) return; // evita leituras duplicadas do mesmo frame
            lastScanRef.current = { text, at: now };
            if (closeOnScan) {
              const s = scannerRef.current;
              scannerRef.current = null;
              safeStopScanner(s);
              onScan(text);
              onClose();
            } else {
              onScan(text);
            }
          }
        };

        const onError = () => {};
        // Alguns dispositivos falham ao listar câmeras (getCameras) antes de iniciar stream.
        // Primeiro tentamos por facingMode; só depois tentamos ids concretos.
        const sourcesToTry = [
          {
            facingMode: { exact: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }]
          },
          {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }]
          },
          { facingMode: { ideal: 'environment' } },
          { facingMode: 'environment' }
        ];
        let backCameraIdFromList = null;
        try {
          const cameras = await Html5Qrcode.getCameras();
          if (Array.isArray(cameras) && cameras.length > 0) {
            const backCamera = cameras.find((c) => {
              const lbl = String(c.label || '').toLowerCase();
              return lbl.includes('back') || lbl.includes('trás') || lbl.includes('rear') || lbl.includes('environment');
            });
            backCameraIdFromList = backCamera?.id || null;
            if (backCameraIdFromList) {
              // No telemóvel, priorizar sempre traseira.
              sourcesToTry.unshift(backCameraIdFromList);
            } else if (cameras[0]?.id) {
              sourcesToTry.push(cameras[0].id);
            }
          }
        } catch {
          // ignorar: alguns browsers bloqueiam enumeração antes de stream.
        }
        if (probe?.deviceId) {
          // Em mobile, só usar deviceId do probe se ele já for a traseira identificada.
          if (!isMobileUa || (backCameraIdFromList && probe.deviceId === backCameraIdFromList)) {
            sourcesToTry.push(probe.deviceId);
          }
        }

        let started = false;
        let lastErr = null;
        for (const source of sourcesToTry) {
          try {
            await html5Qr.start(source, qrConfig, onDecoded, onError);
            started = true;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!started) {
          throw lastErr || new Error('Não foi possível iniciar a câmera.');
        }
        readTrackCapabilities(html5Qr);
      } catch (e) {
        if (mounted) {
          const detail = errorText(e);
          if (!window.isSecureContext) {
            setErro('A câmera só funciona em contexto seguro (HTTPS) ou localhost.');
          } else if (detail) {
            setErro(`Não foi possível aceder à câmera (${detail}).`);
          } else {
            setErro(
              'Não foi possível aceder à câmera. Feche outros apps que estejam usando a câmera e recarregue a página.'
            );
          }
        }
      }
    };

    startScanner();
    return () => {
      mounted = false;
      const s = scannerRef.current;
      scannerRef.current = null;
      safeStopScanner(s);
    };
  }, [open, onScan, onClose, readerId, formatsToSupport, closeOnScan]);

  const fecharScanner = () => {
    const s = scannerRef.current;
    scannerRef.current = null;
    safeStopScanner(s);
    onClose();
  };

  const toggleTorch = async () => {
    const s = scannerRef.current;
    if (!s || typeof s.applyVideoConstraints !== 'function') return;
    try {
      const next = !torchOn;
      await s.applyVideoConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      // Ignorar falha em dispositivos sem suporte real ao torch.
    }
  };

  const handleZoomChange = async (nextRaw) => {
    const s = scannerRef.current;
    if (!s || typeof s.applyVideoConstraints !== 'function') return;
    const next = Number(nextRaw);
    if (!Number.isFinite(next)) return;
    try {
      await s.applyVideoConstraints({ advanced: [{ zoom: next }] });
      setZoomValue(next);
    } catch {
      // Ignorar falha para dispositivos que reportam zoom mas não aplicam.
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={fecharScanner}
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
            <>
              <div className="relative rounded-lg overflow-hidden">
                <div id={readerId} className="rounded-lg overflow-hidden" />
                {/* Guia visual da área lida: cruz central sobre o vídeo */}
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute top-1/2 left-0 w-full h-[2px] -translate-y-1/2 bg-red-500/70 shadow-[0_0_6px_rgba(239,68,68,0.6)]" />
                </div>
              </div>
              {(torchSupported || zoomSupported) && (
                <div className="mt-3 flex flex-col gap-3">
                  {torchSupported && (
                    <button
                      type="button"
                      onClick={toggleTorch}
                      className="w-full py-2 px-3 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                    >
                      {torchOn ? 'Desligar lanterna' : 'Ligar lanterna'}
                    </button>
                  )}
                  {zoomSupported && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Zoom ({zoomValue.toFixed(1)}x)
                      </label>
                      <input
                        type="range"
                        min={zoomRange.min}
                        max={zoomRange.max}
                        step={zoomRange.step}
                        value={zoomValue}
                        onChange={(e) => handleZoomChange(e.target.value)}
                        className="w-full"
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-4 border-t border-gray-200">
          <button
            type="button"
            onClick={fecharScanner}
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
export { Html5QrcodeSupportedFormats };
