// 起動画面の文言と配色。辞書から引いた文言と設定のテーマは、Rust 側が初期化スクリプトで渡す。直書きしない。
declare global {
  interface Window {
    __SPLASH_TEXT?: string
    __SPLASH_THEME?: string
  }
}

const target = document.getElementById('opening')
if (target) target.textContent = window.__SPLASH_TEXT ?? ''
// 渡されなかったときは、既存の見た目（ダーク）のまま出す
document.documentElement.dataset.theme = window.__SPLASH_THEME === 'light' ? 'light' : 'dark'

export {}
