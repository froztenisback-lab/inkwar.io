﻿import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import App from './game'
import { io } from "socket.io-client";

export const socket = io("http://localhost:3000"); // Point this to your server.js port

socket.on("connect", () => {
  console.log("Connected to server with ID:", socket.id);
});
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
