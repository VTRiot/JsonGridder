import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { sveltePreprocess } from 'svelte-preprocess'

const root = path.dirname(fileURLToPath(import.meta.url))
const editorRoot = path.join(root, 'vendor/svelte-jsoneditor')
const editorLib = path.join(editorRoot, 'src/lib')

export default defineConfig({
  plugins: [
    svelte({
      preprocess: sveltePreprocess(),
      compilerOptions: {
        // 上流のスナップショットはスコープのハッシュを含む。ハッシュはファイルの
        // パスから作られるので、取り込む前と同じ相対パスで計算する。
        cssHash: ({ hash, filename }) => {
          const absolute = path.resolve(root, filename ?? '')
          const base = absolute.startsWith(editorRoot) ? editorRoot : root
          return `svelte-${hash(path.relative(base, absolute).replaceAll('\\', '/'))}`
        }
      }
    })
  ],
  resolve: {
    conditions: ['browser'],
    alias: { $lib: editorLib, 'svelte-jsoneditor': editorLib }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'vendor/**/*.test.ts'],
    globals: true,
    environment: 'jsdom',
    setupFiles: ['tests/setup/jsdom.ts', 'tests/setup/language.ts'],
    // 実物のエディタを描く試験を並べて回す。遅さは合否に関わらないので、負荷でも足りる長さにする
    testTimeout: 30000
  }
})
