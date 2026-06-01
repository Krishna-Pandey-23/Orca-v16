import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Initialize orbs background before React renders
function initializeOrbsBackground() {
  // Remove static background from body
  document.body.style.backgroundImage = "none";
  document.body.style.backgroundColor = "#000";
  
  // Create orbs background container
  const orbsContainer = document.createElement("div");
  orbsContainer.className = "orbs-background";
  
  // Create 6 orb elements
  for (let i = 1; i <= 6; i++) {
    const orb = document.createElement("div");
    orb.className = `orb orb-${i}`;
    orbsContainer.appendChild(orb);
  }
  
  // Insert container as first child of body
  document.body.insertBefore(orbsContainer, document.body.firstChild);
}

// Initialize orbs background
initializeOrbsBackground();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
