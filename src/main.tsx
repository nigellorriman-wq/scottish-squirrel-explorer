import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Safe global monkeypatches for preventing iframe performance measuring and alert re-entrancy crashes
if (typeof window !== 'undefined') {
  if (window.performance && window.performance.measure) {
    const originalMeasure = window.performance.measure;
    window.performance.measure = function (name, ...args) {
      try {
        return originalMeasure.apply(this, [name, ...args]);
      } catch (e) {
        console.warn('[Performance Patch] Suppressed measure clone/oom error:', e);
        try {
          return originalMeasure.call(this, name);
        } catch {
          return null as any;
        }
      }
    };
  }

  // Override standard synchronous alert to avoid halting the JS thread and breaking React Scheduler
  if (typeof window.alert === 'function') {
    const originalAlert = window.alert;
    window.alert = function (message) {
      console.warn('[Alert Deferral] Postponing alert to prevent scheduler blocking:', message);
      setTimeout(() => {
        try {
          originalAlert(message);
        } catch (e) {
          console.error('Async alert call failed in sandbox:', e);
        }
      }, 0);
    };
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

