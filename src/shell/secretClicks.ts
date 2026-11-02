/** 隠しコマンドの的（メニューバーの右端の花びら）のクラス名と、動きのクラス名。 */
export const PETAL_CLASS = 'app-menubar-petal'
export const PETAL_WOBBLE_CLASS = 'is-wobble'
export const PETAL_SPIN_CLASS = 'is-spin'

/** 隠しコマンド: メニューバーの花びらを、この時間の内にこの回数だけ続けて押す。 */
export const SECRET_CLICK_COUNT = 8
export const SECRET_CLICK_WINDOW_MS = 2000

/** 押した時刻（ミリ秒）を渡す。窓の内に回数が揃った押下で true を返し、数え直す。 */
export function createSecretClickCounter(
  count: number = SECRET_CLICK_COUNT,
  windowMs: number = SECRET_CLICK_WINDOW_MS
): (at: number) => boolean {
  let times: number[] = []
  return (at) => {
    times = [...times.filter((time) => at - time <= windowMs), at]
    if (times.length >= count) {
      times = []
      return true
    }
    return false
  }
}
