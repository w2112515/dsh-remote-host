import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import QRCode from 'qrcode/lib/browser.js'
import {
  Button,
  IconCheckOutline16,
  IconCloseOutline16,
  IconCopyOutline16,
  IconLinkOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  RiskConfirmation,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RemoteAdminSnapshot,
  RemoteInvitationView,
  RemotePairedDeviceView,
  RemotePendingPairingView,
  RemotePairingProfile,
} from '../types.js'
import type { RemoteAdminClient } from './remote-api.js'
import css from './RemoteSettingsSection.module.css'

export interface RemoteSettingsSectionInjected {
  admin: RemoteAdminClient
}

export type RemoteSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.remote'>
  & InjectFace<RemoteSettingsSectionInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: RemoteAdminSnapshot }

/** Render the Host-local pairing, confirmation, and revocation surface. */
export function RemoteSettingsSection({ admin, t }: RemoteSettingsSectionProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [invitation, setInvitation] = useState<RemoteInvitationView | undefined>()
  const [profile, setProfile] = useState<RemotePairingProfile>('read-only')
  const [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [revoking, setRevoking] = useState<RemotePairedDeviceView | undefined>()
  const [acknowledged, setAcknowledged] = useState(false)
  const pollingAvailable = state.status === 'ready' && state.snapshot.available

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setState({ status: 'loading' })
    try {
      const snapshot = await admin.snapshot()
      setState({ status: 'ready', snapshot })
    } catch {
      if (!quiet) setState({ status: 'error' })
    }
  }, [admin])

  useEffect(() => {
    let active = true
    void admin.snapshot().then(
      (snapshot) => { if (active) setState({ status: 'ready', snapshot }) },
      () => { if (active) setState({ status: 'error' }) },
    )
    return () => { active = false }
  }, [admin])

  useEffect(() => {
    if (!pollingAvailable) return
    const timer = globalThis.setInterval(() => { void load(true) }, 2_000)
    return () => { globalThis.clearInterval(timer) }
  }, [load, pollingAvailable])

  const commit = async (
    key: string,
    operation: () => Promise<RemoteAdminSnapshot>,
  ): Promise<boolean> => {
    setBusy(key)
    setActionError(false)
    try {
      setState({ status: 'ready', snapshot: await operation() })
      return true
    } catch {
      setActionError(true)
      await load(true)
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const createInvitation = async (): Promise<void> => {
    setBusy('invitation')
    setActionError(false)
    try {
      const result = await admin.createInvitation(profile)
      setInvitation(result.invitation)
      setProfile(result.invitation.profile)
      setState({ status: 'ready', snapshot: result.snapshot })
    } catch {
      setActionError(true)
      await load(true)
    } finally {
      setBusy(undefined)
    }
  }

  const confirmRevoke = (): void => {
    if (revoking === undefined) return
    const target = revoking
    void commit(`revoke:${target.deviceId}`, () => admin.revoke(target.deviceId)).then((completed) => {
      if (!completed) return
      setRevoking(undefined)
      setAcknowledged(false)
    })
  }

  return (
    <section className={css.page} aria-busy={state.status === 'loading'}>
      <header className={css.hero}>
        <div>
          <span className={css.eyebrow}>{t('eyebrow')}</span>
          <h2>{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>
        <span className={css.localBadge}><span aria-hidden="true" />{t('localOnly')}</span>
      </header>

      {state.status === 'loading' ? <p className={css.pageStatus}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure} role="alert">
          <p>{t('error')}</p>
          <Button variant="outline" size="sm" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          {actionError ? <p className={css.actionError} role="alert">{t('actionError')}</p> : null}
          {!state.snapshot.available ? <Unavailable t={t} /> : (
            <div className={css.content}>
              <DiscoveryPanel
                discovery={state.snapshot.discovery}
                busy={busy === 'discovery'}
                onToggle={(enabled) => { void commit('discovery', () => admin.setDiscovery(enabled)) }}
                t={t}
              />
              <InvitationPanel
                invitation={invitation}
                profile={profile}
                phoneReachable={state.snapshot.discovery.published}
                busy={busy === 'invitation'}
                onProfileChange={setProfile}
                onCreate={() => { void createInvitation() }}
                t={t}
              />
              <PendingPanel
                pending={state.snapshot.pendingPairings}
                busy={busy}
                onConfirm={(value) => { void commit(`confirm:${value.invitationId}`, () => admin.confirm(value.invitationId)) }}
                onReject={(value) => { void commit(`reject:${value.invitationId}`, () => admin.reject(value.invitationId)) }}
                t={t}
              />
              <DevicesPanel
                devices={state.snapshot.devices}
                busy={busy}
                onRevoke={(value) => { setRevoking(value); setAcknowledged(false) }}
                onRefresh={() => { void load(true) }}
                t={t}
              />
            </div>
          )}
        </>
      ) : null}

      <RiskConfirmation
        open={revoking !== undefined}
        title={t('revokeTitle')}
        description={t('revokeDescription')}
        acknowledgeLabel={t('revokeAcknowledge')}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirmRevoke')}
        acknowledged={acknowledged}
        disabled={revoking !== undefined && busy === `revoke:${revoking.deviceId}`}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setRevoking(undefined); setAcknowledged(false) }}
        onConfirm={confirmRevoke}
      />
    </section>
  )
}

type Translate = RemoteSettingsSectionProps['t']

function Unavailable({ t }: { t: Translate }): ReactNode {
  return (
    <div className={css.unavailable}>
      <span className={css.unavailableIcon} aria-hidden="true"><IconLinkOutline16 /></span>
      <div><h3>{t('unavailableTitle')}</h3><p>{t('unavailableBody')}</p></div>
    </div>
  )
}

function DiscoveryPanel({
  discovery,
  busy,
  onToggle,
  t,
}: {
  discovery: RemoteAdminSnapshot['discovery']
  busy: boolean
  onToggle: (enabled: boolean) => void
  t: Translate
}): ReactNode {
  const endpoint = discovery.address === undefined
    ? undefined
    : discovery.port === undefined
      ? discovery.address
      : `${discovery.address}:${String(discovery.port)}`
  return (
    <section className={css.panel}>
      <PanelHeading title={t('discoveryTitle')} body={t('discoveryBody')} />
      <label className={css.discoveryToggle}>
        <input
          type="checkbox"
          checked={discovery.intended}
          disabled={busy}
          onChange={(event) => { onToggle(event.target.checked) }}
        />
        <span>
          <strong>{t('discoveryEnable')}</strong>
          <small>{discovery.intended ? t('discoveryOn') : t('discoveryOff')}</small>
        </span>
      </label>
      {discovery.intended
        ? (
          <p className={css.discoveryStatus} data-published={discovery.published ? 'true' : undefined}>
            {discovery.published ? t('discoveryPublished') : t('discoveryPending')}
            {discovery.displayName === undefined ? null : ` · ${discovery.displayName}`}
            {endpoint === undefined ? null : ` · ${endpoint}`}
          </p>
        )
        : null}
    </section>
  )
}

function InvitationPanel({
  invitation,
  profile,
  phoneReachable,
  busy,
  onProfileChange,
  onCreate,
  t,
}: {
  invitation: RemoteInvitationView | undefined
  profile: RemotePairingProfile
  phoneReachable: boolean
  busy: boolean
  onProfileChange: (value: RemotePairingProfile) => void
  onCreate: () => void
  t: Translate
}): ReactNode {
  const [now, setNow] = useState(Date.now())
  const [qr, setQr] = useState<string | undefined>()
  const [qrFailed, setQrFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (invitation === undefined) return
    setNow(Date.now())
    const timer = globalThis.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { globalThis.clearInterval(timer) }
  }, [invitation])

  useEffect(() => {
    let active = true
    setQr(undefined)
    setQrFailed(false)
    if (invitation !== undefined) {
      void QRCode.toDataURL(invitation.invitationUri, {
        errorCorrectionLevel: 'M', margin: 2, width: 264,
      }).then(
        (value) => { if (active) setQr(value) },
        () => { if (active) setQrFailed(true) },
      )
    }
    return () => { active = false }
  }, [invitation])

  const expired = invitation !== undefined && Number(invitation.expiresAtMs) <= now
  const copy = (): void => {
    if (invitation === undefined) return
    void writeClipboard(invitation.invitationUri).then((ok) => {
      if (!ok) return
      setCopied(true)
      globalThis.setTimeout(() => { setCopied(false) }, 1_500)
    })
  }

  return (
    <section className={css.panel}>
      <PanelHeading title={t('invitationTitle')} body={t('invitationBody')} />
      <fieldset className={css.profilePicker} disabled={busy}>
        <legend>{t('profileLegend')}</legend>
        {([
          'read-only', 'approval-reviewer', 'session-control', 'session-operator', 'session-supervisor', 'host-supervisor',
        ] as const).map(value => (
          <label className={css.profileOption} data-selected={profile === value ? 'true' : undefined} key={value}>
            <input
              type="radio"
              name="remote-pairing-profile"
              value={value}
              checked={profile === value}
              onChange={() => { onProfileChange(value) }}
            />
            <span>
              <strong>{profileLabel(value, t)}</strong>
              <small>{profileDescription(value, t)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {phoneReachable ? null : <p className={css.invitationHint} role="status">{t('invitationLanRequired')}</p>}
      {invitation === undefined ? (
        <div className={css.invitationEmpty}>
          <div className={css.phoneGlyph} aria-hidden="true"><span /><i /></div>
          <Button variant="primary" disabled={busy || !phoneReachable} onClick={onCreate} icon={<IconLinkOutline16 />}>
            {createInvitationLabel(profile, t)}
          </Button>
        </div>
      ) : (
        <div className={css.invitationGrid} data-expired={expired ? 'true' : undefined}>
          <div className={css.qrFrame}>
            {qrFailed
              ? <span role="status">{t('qrError')}</span>
              : qr === undefined
                ? <span>{t('qrLoading')}</span>
                : <img src={qr} alt={t('qrAlt')} width="264" height="264" />}
          </div>
          <div className={css.invitationDetails}>
            <span className={expired ? css.expired : css.invitationStatus}>
              {expired ? t('expired') : `${t('expires')} ${formatTime(invitation.expiresAtMs)}`}
            </span>
            <Detail label={t('accessProfile')} value={profileLabel(invitation.profile, t)} />
            <Detail label={t('hostFingerprint')} value={invitation.hostFingerprint} mono />
            <div className={css.invitationActions}>
              <Button variant="outline" size="sm" onClick={copy} icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}>
                <span aria-live="polite">{copied ? t('copied') : t('copyInvitation')}</span>
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={onCreate}>
                {t('replaceInvitation')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function PendingPanel({
  pending,
  busy,
  onConfirm,
  onReject,
  t,
}: {
  pending: RemotePendingPairingView[]
  busy: string | undefined
  onConfirm: (value: RemotePendingPairingView) => void
  onReject: (value: RemotePendingPairingView) => void
  t: Translate
}): ReactNode {
  return (
    <section className={css.panel}>
      <PanelHeading title={t('pendingTitle')} body={t('pendingBody')} count={pending.length} />
      {pending.length === 0 ? <p className={css.empty}>{t('pendingEmpty')}</p> : (
        <ul className={css.pendingList}>
          {pending.map(value => (
            <li className={css.pendingCard} key={value.invitationId}>
              <div className={css.pendingIdentity}>
                <span className={css.deviceAvatar} aria-hidden="true">{initial(value.deviceName)}</span>
                <div><strong>{value.deviceName}</strong><small>{profileLabel(value.profile, t)}</small></div>
              </div>
              <div className={css.verification}>
                <span>{t('verificationCode')}</span>
                <strong translate="no">{value.verificationCode}</strong>
              </div>
              <Detail label={t('deviceFingerprint')} value={value.deviceFingerprint} mono />
              <div className={css.pendingActions}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => { onConfirm(value) }}
                  icon={<IconCheckOutline16 />}
                >
                  {allowProfileLabel(value.profile, t)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => { onReject(value) }}
                  icon={<IconCloseOutline16 />}
                >
                  {t('rejectDevice')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DevicesPanel({
  devices,
  busy,
  onRevoke,
  onRefresh,
  t,
}: {
  devices: RemotePairedDeviceView[]
  busy: string | undefined
  onRevoke: (value: RemotePairedDeviceView) => void
  onRefresh: () => void
  t: Translate
}): ReactNode {
  const ordered = useMemo(
    () => [...devices].sort((left, right) => Number(left.revokedAtMs !== undefined) - Number(right.revokedAtMs !== undefined)),
    [devices],
  )
  return (
    <section className={css.panel}>
      <div className={css.headingWithAction}>
        <PanelHeading title={t('devicesTitle')} body={t('devicesBody')} count={devices.length} />
        <Button variant="toolbar" size="sm" aria-label={t('refresh')} onClick={onRefresh} icon={<IconRefreshOutline16 />} />
      </div>
      {ordered.length === 0 ? <p className={css.empty}>{t('devicesEmpty')}</p> : (
        <ul className={css.deviceList}>
          {ordered.map(value => (
            <li className={css.deviceRow} key={value.deviceId} data-revoked={value.revokedAtMs === undefined ? undefined : 'true'}>
              <span className={css.deviceAvatar} aria-hidden="true">{initial(value.displayName)}</span>
              <div className={css.deviceMain}>
                <div className={css.deviceTitle}>
                  <strong>{value.displayName}</strong>
                  <span data-state={value.revokedAtMs === undefined ? 'active' : 'revoked'}>
                    {value.revokedAtMs === undefined ? t('active') : t('revoked')}
                  </span>
                </div>
                <code translate="no">{value.deviceFingerprint}</code>
                <div className={css.deviceMeta}>
                  <span>{profileLabel(value.profile, t)}</span>
                  <span>{t('created')} {formatDate(value.createdAtMs)}</span>
                  {value.revokedAtMs === undefined ? null : <span>{t('revokedAt')} {formatDate(value.revokedAtMs)}</span>}
                </div>
              </div>
              {value.revokedAtMs === undefined ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => { onRevoke(value) }}
                  icon={<IconTrashOutline16 />}
                >
                  {t('revoke')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PanelHeading({ title, body, count }: { title: string; body: string; count?: number }): ReactNode {
  return (
    <div className={css.panelHeading}>
      <div className={css.panelTitle}><h3>{title}</h3>{count === undefined ? null : <span>{count}</span>}</div>
      <p>{body}</p>
    </div>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className={css.detail}>
      <span>{label}</span>
      {mono ? <code translate="no">{value}</code> : <strong>{value}</strong>}
    </div>
  )
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(Number(value))
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(Number(value))
}

function initial(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function profileLabel(profile: RemotePairingProfile, t: Translate): string {
  switch (profile) {
    case 'read-only': return t('readOnly')
    case 'approval-reviewer': return t('approvalReviewer')
    case 'session-control': return t('sessionControl')
    case 'session-operator': return t('sessionOperator')
    case 'session-supervisor': return t('sessionSupervisor')
    case 'host-supervisor': return t('hostSupervisor')
  }
}

function profileDescription(profile: RemotePairingProfile, t: Translate): string {
  switch (profile) {
    case 'read-only': return t('readOnlyDescription')
    case 'approval-reviewer': return t('approvalReviewerDescription')
    case 'session-control': return t('sessionControlDescription')
    case 'session-operator': return t('sessionOperatorDescription')
    case 'session-supervisor': return t('sessionSupervisorDescription')
    case 'host-supervisor': return t('hostSupervisorDescription')
  }
}

function createInvitationLabel(profile: RemotePairingProfile, t: Translate): string {
  switch (profile) {
    case 'read-only': return t('createInvitation')
    case 'approval-reviewer': return t('createReviewerInvitation')
    case 'session-control': return t('createControlInvitation')
    case 'session-operator': return t('createOperatorInvitation')
    case 'session-supervisor': return t('createSupervisorInvitation')
    case 'host-supervisor': return t('createHostSupervisorInvitation')
  }
}

function allowProfileLabel(profile: RemotePairingProfile, t: Translate): string {
  switch (profile) {
    case 'read-only': return t('allowReadOnly')
    case 'approval-reviewer': return t('allowApprovalReviewer')
    case 'session-control': return t('allowSessionControl')
    case 'session-operator': return t('allowSessionOperator')
    case 'session-supervisor': return t('allowSessionSupervisor')
    case 'host-supervisor': return t('allowHostSupervisor')
  }
}
