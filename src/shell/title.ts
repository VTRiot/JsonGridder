import { version } from '../../package.json'
import { format, t } from '../i18n'

/** タイトルの製品名。版は package.json から取る（gate がビルドの版との一致を検査する） */
export const appTitleWithVersion = (): string => `${t('app.title')} ${version}`

const PATH_SEPARATOR = /[\\/]/

export function documentName(path: string | null): string {
  return path === null ? t('app.window.untitled') : (path.split(PATH_SEPARATOR).at(-1) as string)
}

export function windowTitle(path: string | null, dirty: boolean): string {
  return format('app.window.title', {
    dirty: dirty ? t('app.window.dirtyMark') : '',
    name: documentName(path),
    app: appTitleWithVersion()
  })
}
