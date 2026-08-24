#!/usr/bin/env node
/**
 * Pack workspace Host Remote modules into this one bundle.
 * One npm package; Cordis still loads control → command → remote as three rows.
 */
import { mkdir, cp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '..', 'host-workspace', 'deepseek-harness')
const harness = join(repo, 'packages', 'host')
const out = join(root, 'runtime')

const alias = {
  '@deepseek-ai/dsh-host-remote-control': '@dsh-remote/host/control',
  '@deepseek-ai/dsh-host-remote-command': '@dsh-remote/host/command',
}

const external = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-host-apiproxy/api',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-connection',
  '@dsh-remote/host/control',
  '@dsh-remote/host/command',
  '@dsh-remote/host/remote',
  '@dsh-remote/host/admissions',
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  '@homebridge/ciao',
]

async function bundle(entry, outfile) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    alias,
    external,
    nodePaths: [join(repo, 'node_modules'), join(repo, 'vendor')],
    logLevel: 'info',
  })
  if (result.errors.length > 0) {
    throw new Error(`esbuild failed for ${entry}`)
  }
}

await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'control'), { recursive: true })
await mkdir(join(out, 'command'), { recursive: true })
await mkdir(join(out, 'remote'), { recursive: true })
await mkdir(join(out, 'admissions'), { recursive: true })
await mkdir(join(out, 'settings'), { recursive: true })
await mkdir(join(out, 'protocol', 'v1alpha'), { recursive: true })

await bundle(join(harness, 'remote-control', 'src', 'index.ts'), join(out, 'control', 'index.js'))
await bundle(join(harness, 'remote-command', 'src', 'index.ts'), join(out, 'command', 'index.js'))
await bundle(join(harness, 'remote', 'src', 'index.ts'), join(out, 'remote', 'index.js'))
await bundle(join(root, 'src', 'admissions.ts'), join(out, 'admissions', 'index.js'))
await bundle(
  join(repo, 'packages', 'client', 'ui-settings-remote', 'src', 'index.ts'),
  join(out, 'settings', 'index.js'),
)
await cp(
  join(repo, 'packages', 'client', 'ui-settings-remote', 'lib', 'client.js'),
  join(out, 'client.js'),
)

await cp(
  join(harness, 'remote', 'protocol', 'v1alpha', 'dsh_remote_v1alpha.proto'),
  join(out, 'protocol', 'v1alpha', 'dsh_remote_v1alpha.proto'),
)

console.log('packed runtime into', out)
