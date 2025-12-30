// src/components/ResizableSidebar.tsx
import React, { useState, useCallback, useEffect } from 'react';

interface ResizableSidebarProps {
  children: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

export const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  children,
  defaultWidth = 320,
  minWidth = 280,
  maxWidth = 600,
}) => {
  const [width, setWidth] = useState(() => {
    // Load saved width from localStorage
    const saved = localStorage.getItem('sidebar-width');
    return saved ? parseInt(saved, 10) : defaultWidth;
  });
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback(
    (e: MouseEvent) => {
      if (isResizing) {
        const newWidth = Math.min(maxWidth, Math.max(minWidth, e.clientX));
        setWidth(newWidth);
        localStorage.setItem('sidebar-width', String(newWidth));
      }
    },
    [isResizing, minWidth, maxWidth]
  );

  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', resize);
      window.addEventListener('mouseup', stopResizing);
    }

    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  return (
    <div
      className="flex-shrink-0 flex flex-col border-r border-gray-300 bg-white shadow-lg z-20 overflow-hidden relative"
      style={{ width }}
    >
      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {children}
      </div>

      {/* Resize Handle */}
      <div
        className={`absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-blue-400 transition-colors z-30 ${
          isResizing ? 'bg-blue-500' : 'bg-transparent hover:bg-blue-300'
        }`}
        onMouseDown={startResizing}
        style={{ touchAction: 'none' }}
      >
        {/* Visual indicator line */}
        <div className="absolute right-0 top-0 w-px h-full bg-gray-300" />
      </div>

      {/* Overlay to prevent iframe/canvas capturing events during resize */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </div>
  );
};
