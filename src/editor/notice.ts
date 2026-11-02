import './notice.css'

/** 読み終えるまで残す時間。 */
const VISIBLE_MS = 8000

export interface Notice {
  show(message: string): void
  destroy(): void
}

/** 画面の下に出す帯。エディタの外に置くので、エディタの更新が止まっても出る。 */
export function createNotice(host: HTMLElement): Notice {
  const element = document.createElement('div')
  element.className = 'app-notice'
  element.setAttribute('role', 'status')
  element.hidden = true
  host.appendChild(element)

  let timer: ReturnType<typeof setTimeout> | undefined

  function hide(): void {
    element.hidden = true
  }

  element.addEventListener('click', hide)

  return {
    show(message) {
      clearTimeout(timer)
      element.textContent = message
      element.hidden = false
      timer = setTimeout(hide, VISIBLE_MS)
    },
    destroy() {
      clearTimeout(timer)
      element.remove()
    }
  }
}
