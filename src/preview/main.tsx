import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installPreviewBackend } from './sim'
import { App } from '../App'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '../index.css'

installPreviewBackend()
;(window as unknown as { __RL_PREVIEW__: boolean }).__RL_PREVIEW__ = true

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
