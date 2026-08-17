/** Host-local DSH Remote device administration registered into Web Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RemoteSettingsSection, type RemoteSettingsSectionInjected } from './RemoteSettingsSection.js'
import { createRemoteAdminClient } from './remote-api.js'
import { en, zh, type RemoteSettingsLocaleKey } from './locales.js'

export type { RemoteSettingsSectionInjected, RemoteSettingsSectionProps } from './RemoteSettingsSection.js'
export type { RemoteSettingsLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.remote': RemoteSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.remote'
/** Services required by the Settings registration and local Connection face. */
export const inject = ['slots', 'locale', 'connection']

/** Register the page only when this browser itself is running on the Host. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-remote: dictionaries')
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  if (!connection.isLoopback) return

  const t = ctx.locale.bind(NS)
  const admin = createRemoteAdminClient(connection.rpc)
  const injected = (): RemoteSettingsSectionInjected => ({ admin })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, RemoteSettingsSection))
}
