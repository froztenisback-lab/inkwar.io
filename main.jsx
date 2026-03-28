import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import App from './game' // Change 'WarPaint' to 'App'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App /> // Change 'WarPaint' back to 'App'
  </React.StrictMode>
)
