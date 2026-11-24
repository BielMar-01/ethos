import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { FeedbackHost } from './feedback'
import { registerServiceWorker } from './pwa'
import { installErrorReporting } from './errorReport'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <FeedbackHost />
  </StrictMode>,
)

registerServiceWorker()
installErrorReporting()
