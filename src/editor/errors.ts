/**
 * エディタの `onError` が届かない例外を受ける。表の描画と非同期の処理の例外はここへ来る。
 * 外す関数を返す。
 */
export function catchUnhandledErrors(report: (error: Error) => void): () => void {
  const onError = (event: ErrorEvent): void => {
    report(toError(event.error ?? event.message))
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    report(toError(event.reason))
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
