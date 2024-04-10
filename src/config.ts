import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { name } from '../package.json'
import { loaders } from './loaders'
import { logger } from './logger'

import type { Config, UserConfig } from './types'

/**
 * recursive 3-level search files in cwd and its parent directories
 * @param files filenames (relative or absolute)
 * @param cwd start directory
 * @param depth search depth
 * @returns filename first searched
 */
const searchFiles = async (files: string[], cwd: string = process.cwd(), depth: number = 3): Promise<string | undefined> => {
  for (const file of files) {
    try {
      const path = resolve(cwd, file)
      await access(path) // check file exists
      return path
    } catch {
      continue
    }
  }
  if (depth > 0 && !(cwd === '/' || cwd.endsWith(':\\'))) {
    return await searchFiles(files, dirname(cwd), depth - 1)
  }
}

/**
 * bundle and load user config file
 * @param path config file path
 * @returns user config module
 */
const loadConfig = async (path: string): Promise<UserConfig> => {
  // TODO: import js (mjs, cjs) config file directly without esbuild?
  if (!/\.(js|mjs|cjs|ts|mts|cts)$/.test(path)) {
    const ext = path.split('.').pop()
    throw new Error(`not supported config file with '${ext}' extension`)
  }

  const outfile = join(path, '../node_modules/.velite.config.compiled.mjs')

  await build({
    entryPoints: [path],
    outfile,
    bundle: true,
    write: true,
    format: 'esm',
    target: 'node18',
    platform: 'node',
    packages: 'external'
  })

  const configUrl = pathToFileURL(outfile)
  configUrl.searchParams.set('t', Date.now().toString()) // prevent import cache

  const mod = await import(configUrl.href)
  return mod.default ?? mod
}

/**
 * resolve config from user's project
 * @param path specific config file path (relative or absolute)
 * @param options.strict if true, throws error and terminates process if any schema validation fails
 * @param options.clean if true, clean output directories before build
 * @returns resolved config object with default values
 */
export const resolveConfig = async (path?: string, options: { strict?: boolean; clean?: boolean } = {}): Promise<Config> => {
  const begin = performance.now()

  // prettier-ignore
  const files = path != null ? [path] : [
    name + '.config.js',
    name + '.config.ts',
    name + '.config.mjs',
    name + '.config.mts',
    name + '.config.cjs',
    name + '.config.cts'
  ]

  const configPath = await searchFiles(files)
  if (configPath == null) throw new Error(`config file not found, create '${name}.config.ts' in your project root`)

  const loadedConfig = await loadConfig(configPath)

  if (loadedConfig.collections == null) throw new Error(`'collections' is required in '${configPath}'`)

  logger.log(`using config '${configPath}'`, begin)

  const cwd = dirname(configPath)

  return {
    ...loadedConfig,
    configPath,
    cache: new Map(),
    root: resolve(cwd, loadedConfig.root ?? 'content'),
    output: {
      data: resolve(cwd, loadedConfig.output?.data ?? '.velite'),
      assets: resolve(cwd, loadedConfig.output?.assets ?? 'public/static'),
      base: loadedConfig.output?.base ?? '/static/',
      name: loadedConfig.output?.name ?? '[name]-[hash:8].[ext]',
      clean: options.clean ?? loadedConfig.output?.clean ?? false
    },
    loaders: [...(loadedConfig.loaders ?? []), ...loaders],
    strict: options.strict ?? loadedConfig.strict ?? false
  }
}
