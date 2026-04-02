// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/react-react'

export default defineConfig({
  plugins: [react()],
  // If the environment is GitHub Actions, use the repo name, otherwise use root
  base: '/',
})
