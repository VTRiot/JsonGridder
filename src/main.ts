import './main.css'
import { isTauri } from '@tauri-apps/api/core'
import { startApp } from './shell/app'
import { createDetachedPorts, createTauriPorts } from './shell/ports'

const target = document.getElementById('app')
if (!target) {
  throw new Error('#app not found')
}

// 窓は隠して始まる。ここまで来なければ Rust 側の見張りが終了させる。
void startApp(isTauri() ? createTauriPorts() : createDetachedPorts(), target)
