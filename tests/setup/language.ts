// The app starts in English when the settings choose no language. Most unit tests check the
// Japanese wording, so they run as if the settings chose "ja". The test of the default language
// loads a fresh copy of the dictionary module and does not see this choice.
import { setLanguage } from '../../src/i18n'

setLanguage('ja')
