import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'prebuilds.json'), 'utf8'))
if (manifest.platform !== `${process.platform}-${process.arch}`) {
  throw new Error(`DSH Remote security core does not support ${process.platform}-${process.arch}`)
}
for (const artifact of manifest.artifacts) {
  const digest = createHash('sha256').update(readFileSync(join(root, artifact.path))).digest('hex')
  if (digest !== artifact.sha256) throw new Error(`DSH Remote security artifact integrity failed: ${artifact.path}`)
}
const require = createRequire(import.meta.url)
export default require('./dsh_remote_security_core.node')
