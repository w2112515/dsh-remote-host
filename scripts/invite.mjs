#!/usr/bin/env node
/**
 * Mint a five-minute host-supervisor invitation against loopback Settings.
 * Run on the Host (an SSH session is enough). Prints the URI and a terminal QR.
 * On a TTY, type the eight-digit code to confirm. --confirm skips the prompt.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import qrcode from 'qrcode'

const base = process.env.DSH_REMOTE_WEB ?? 'http://127.0.0.1:3180'
const autoConfirm = process.argv.includes('--confirm')
const profile = process.argv.slice(2).find((a) => a !== '--confirm') ?? 'host-supervisor'

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const created = await rpc('invitation/create', { profile })
const invitation = created.invitation
const uri = invitation.invitationUri
stdout.write(`${uri}\n`)
try {
  stderr.write(`${await qrcode.toString(uri, { type: 'terminal', small: true })}\n`)
} catch {
  stderr.write('qr: skipped (terminal encode failed)\n')
}
stderr.write(
  `profile=${invitation.profile} expires=${new Date(Number(invitation.expiresAtMs)).toISOString()}\n` +
    `Scan or paste that URI on the phone, then compare the eight-digit code.\n`,
)

const id = invitation.invitationId
let code
for (;;) {
  await sleep(1500)
  const snap = await rpc('snapshot', {})
  const pending = snap.pendingPairings?.find((row) => row.invitationId === id)
  if (pending?.verificationCode) {
    code = pending.verificationCode
    stderr.write(`phone code ${code}  (${pending.deviceName ?? 'device'})\n`)
    break
  }
  if (Date.now() > Number(invitation.expiresAtMs)) {
    throw new Error('invitation expired before the phone connected')
  }
}

if (autoConfirm) {
  await rpc('pairing/confirm', { invitationId: id })
  stderr.write('confirmed\n')
} else if (stdin.isTTY) {
  const rl = createInterface({ input: stdin, output: stderr })
  const typed = (await rl.question('Type those 8 digits to confirm (Ctrl-C to abort): ')).trim()
  rl.close()
  if (typed !== code) {
    throw new Error('code mismatch; pairing was not confirmed')
  }
  await rpc('pairing/confirm', { invitationId: id })
  stderr.write('confirmed\n')
} else {
  stderr.write('No TTY. Confirm in Settings → Mobile access, or rerun with --confirm after comparing codes.\n')
  for (;;) {
    await sleep(1500)
    const snap = await rpc('snapshot', {})
    const pending = snap.pendingPairings?.find((row) => row.invitationId === id)
    if (!pending) {
      stderr.write('pairing no longer pending (confirmed or dismissed)\n')
      break
    }
    if (Date.now() > Number(invitation.expiresAtMs)) {
      throw new Error('invitation expired before confirmation')
    }
  }
}
