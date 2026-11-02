import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { sveltePreprocess } from 'svelte-preprocess'

const root = path.dirname(fileURLToPath(import.meta.url))
const editorLib = path.join(root, 'vendor/svelte-jsoneditor/src/lib')

/**
 * 主画面に加えて、直接の起動のときだけ出す起動画面（splash.html）のページを作る。
 * 試験が別の root（tests/browser/fixture）でこの設定を使うので、その root に splash.html があるときだけ足す。
 */
function splashPage(): Plugin {
  return {
    name: 'jgv-splash-page',
    config(inline) {
      const base = path.resolve(inline.root ?? process.cwd())
      const splash = path.join(base, 'splash.html')
      if (!fs.existsSync(splash)) return
      return { build: { rollupOptions: { input: { main: path.join(base, 'index.html'), splash } } } }
    }
  }
}

export default defineConfig(({ command }) => {
  // vite build は環境の NODE_ENV をそのまま使う。development が入った環境では
  // Svelte の開発用コードが配布物に混ざるので、ビルドでは本番に固定する。
  if (command === 'build') {
    process.env.NODE_ENV = 'production'
  }

  return {
    plugins: [svelte({ preprocess: sveltePreprocess() }), splashPage()],
    resolve: { alias: { $lib: editorLib, 'svelte-jsoneditor': editorLib } },
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    build: { sourcemap: false, target: 'es2022' }
  }
})
