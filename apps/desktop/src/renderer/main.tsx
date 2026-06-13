import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled (not loaded from a remote CDN) so the packaged desktop app
// works offline and needs no third-party network requests.
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { App } from './App.js';
import { createMockBridge } from './mock/mockBridge.js';
import './theme.css';

// Use the real preload bridge (`window.frontagent`) when running inside Electron;
// fall back to the in-browser mock under plain `vite dev` so the UI stays
// reviewable on its own.
const bridge = window.frontagent ?? createMockBridge();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} />
  </StrictMode>,
);
