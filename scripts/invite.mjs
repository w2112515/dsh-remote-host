#!/usr/bin/env node
/**
 * Mint a five-minute host-supervisor invitation against the loopback
 * Settings channel. Run on the Host machine (or an SSH tunnel to 3180).
 * Prints the URI and waits until you confirm or the invitation expires.
 */
const base = process.env.DSH_REMOTE_WEB ?? 'http://127.0.0.1:3180'
const profile = process.argv[2] ?? 'host-supervisor'

async function rpc(endpoint, payload) {
  const res = await fetch(`${base}/remote-admin/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `invite-${Date.now()}`,
      method: endpoint,
      payload,
    }),
  })
  const body = await res.text()
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`remote-admin ${endpoint} ${res.status}: ${body.slice(0, 200)}`)
  }
  if (!parsed.result?.ok) {
    throw new Error(parsed.result?.error?.message ?? body.slice(0, 200))
  }
  return parsed.result.value
}

const created = await rpc('invitation/create', { profile })
const invitation = created.invitation
process.stdout.write(`${invitation.invitationUri}\n`)
process.stderr.write(
  `profile=${invitation.profile} expires=${new Date(Number(invitation.expiresAtMs)).toISOString()}\n` +
    `Open that URI on the phone, then confirm here if the 8-digit codes match.\n`,
)

const id = invitation.invitationId
for (;;) {
  await new Promise((r) => setTimeout(r, 1500))
  const snap = await rpc('snapshot', {})
  const pending = snap.pendingPairings?.find((row) => row.invitationId === id)
  if (pending?.verificationCode) {
    process.stderr.write(`phone code ${pending.verificationCode}  (${pending.deviceName ?? 'device'})\n`)
    if (process.argv.includes('--confirm')) {
      await rpc('pairing/confirm', { invitationId: id })
      process.stderr.write('confirmed\n')
    }
    break
  }
  if (Date.now() > Number(invitation.expiresAtMs)) {
    throw new Error('invitation expired before the phone connected')
  }
}
