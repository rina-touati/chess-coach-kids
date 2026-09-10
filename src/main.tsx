import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const productionUrl = 'https://chess-coach-kids-one.vercel.app/'

if (window.location.hostname === 'rina-touati.github.io' && window.location.pathname.startsWith('/chess-coach-kids')) {
  window.location.replace(productionUrl)
} else {
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
}
