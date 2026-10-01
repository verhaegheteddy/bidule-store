import type { ExtensionUi } from '@bidule/sdk'
import '../contract.ts'
import { Background } from './Background.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { TempsPage } from './TempsPage.tsx'

const ui: ExtensionUi = { pages: { temps: TempsPage }, background: Background, settings: SettingsPanel }
export default ui
