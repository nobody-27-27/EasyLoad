// src/components/Toast.tsx
import React, { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  type?: 'success' | 'info' | 'warning' | 'error';
  duration?: number;
  onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({
  message,
  type = 'info',
  duration = 4000,
  onClose,
}) => {
  const [isVisible] = useState(true);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLeaving(true);
      setTimeout(onClose, 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const handleClose = () => {
    setIsLeaving(true);
    setTimeout(onClose, 300);
  };

  const colors = {
    success: 'bg-green-500 border-green-600',
    info: 'bg-blue-500 border-blue-600',
    warning: 'bg-amber-500 border-amber-600',
    error: 'bg-red-500 border-red-600',
  };

  const icons = {
    success: '✓',
    info: 'ℹ',
    warning: '⚠',
    error: '✕',
  };

  if (!isVisible) return null;

  return (
    <div
      className={`fixed top-4 left-1/2 transform -translate-x-1/2 z-50 transition-all duration-300 ${
        isLeaving ? 'opacity-0 -translate-y-2' : 'opacity-100 translate-y-0'
      }`}
    >
      <div
        className={`${colors[type]} text-white px-6 py-4 rounded-xl shadow-2xl border-l-4 flex items-center gap-3 min-w-80 backdrop-blur-sm`}
      >
        <span className="text-xl font-bold">{icons[type]}</span>
        <p className="font-medium flex-1">{message}</p>
        <button
          onClick={handleClose}
          className="text-white/80 hover:text-white transition-colors text-lg font-bold"
        >
          ×
        </button>
      </div>
    </div>
  );
};

// Toast manager for global use
interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
}

let toastId = 0;
let setToastsGlobal: React.Dispatch<React.SetStateAction<ToastItem[]>> | null = null;

export const showToast = (message: string, type: 'success' | 'info' | 'warning' | 'error' = 'info') => {
  if (setToastsGlobal) {
    const id = ++toastId;
    setToastsGlobal((prev) => [...prev, { id, message, type }]);
  }
};

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    setToastsGlobal = setToasts;
    return () => {
      setToastsGlobal = null;
    };
  }, []);

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex flex-col items-center gap-2 pt-4 pointer-events-none">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast
            message={toast.message}
            type={toast.type}
            onClose={() => removeToast(toast.id)}
          />
        </div>
      ))}
    </div>
  );
};
