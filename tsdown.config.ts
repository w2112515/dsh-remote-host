import { readFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_ID = '@w2112515/dsh-remote-host'
const CSS_PREFIX = '\0remote-css:'
const CSS_SUFFIX = '.mjs'

const HOST_EXTERNALS = [
  '@w2112515/dsh-remote-host/command',
  '@w2112515/dsh-remote-host/control',
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  '@homebridge/ciao',
  'zod',
  /^@deepseek-ai\//,
] as const

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
] as const

const host: UserConfig = {
  name: PACKAGE_ID,
  entry: {
    index: 'src/host/index.ts',
    command: 'src/command/index.ts',
    control: 'src/control/index.ts',
    settings: 'src/settings/index.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: true,
  deps: { neverBundle: [...HOST_EXTERNALS] },
}

const client: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/settings/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: { neverBundle: [...CLIENT_EXTERNALS] },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'remote-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const pathname = new URL(source, `file:///${importer.replace(/\\/g, '/')}`).pathname
      const absolute = process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname
      return `${CSS_PREFIX}${relative(process.cwd(), absolute).replace(/\\/g, '/')}${CSS_SUFFIX}`
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const stableName = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      const file = resolve(process.cwd(), stableName)
      this.addWatchFile(file)
      const result = transform({
        filename: stableName,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classes = Object.fromEntries(
        Object.entries(result.exports ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, value.name]),
      )
      const tagId = `${PACKAGE_ID}/${basename(file)}`
      return [
        `const css = ${JSON.stringify(result.code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
