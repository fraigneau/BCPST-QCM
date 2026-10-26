import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readBackendMode } from './src/services/backend-mode'
import { readSupabaseConfiguration } from './src/services/supabase-config'

export default defineConfig({
  plugins: [vue(), {
    name: 'validate-backend-configuration',
    configResolved(configuration) {
      if (configuration.command === 'build' && readBackendMode(configuration.env) === 'supabase') readSupabaseConfiguration(configuration.env)
    },
  }],
  server: { host: '0.0.0.0', watch: { ignored: ['**/.qa/**', '**/data/**'] } },
  build: { target: 'es2022' },
})
