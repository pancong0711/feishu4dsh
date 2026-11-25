import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SheConfigError,
  defaultSheSocketPath,
  defaultSheTokenFile,
  readSheTokenFile,
  resolveSheIntegrationConfig,
} from '../src/integrations/she/index.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SHE integration config', () => {
  it('is disabled by default and resolves documented paths', () => {
    const config = resolveSheIntegrationConfig({}, { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/demo' })
    expect(config).toEqual({
      enabled: false,
      socketPath: '/run/user/1000/she/control.sock',
      tokenFile: '/home/demo/.config/she/token',
      timeoutMs: 30_000,
    })
    expect(defaultSheSocketPath({ HOME: '/home/demo' })).toBe('/home/demo/.local/run/she/control.sock')
    expect(defaultSheTokenFile({ HOME: '/home/demo' })).toBe('/home/demo/.config/she/token')
  })

  it('accepts explicit opt-in paths and rejects unsafe values', () => {
    expect(resolveSheIntegrationConfig({
      enabled: true,
      socketPath: '/tmp/custom.sock',
      tokenFile: '/tmp/custom.token',
      timeoutMs: 1_500,
    })).toMatchObject({ enabled: true, socketPath: '/tmp/custom.sock', timeoutMs: 1_500 })
    expect(() => resolveSheIntegrationConfig({ socketPath: 'relative.sock' })).toThrow(SheConfigError)
    expect(() => resolveSheIntegrationConfig({ tokenFile: 'relative.token' })).toThrow(SheConfigError)
    expect(() => resolveSheIntegrationConfig({ timeoutMs: 0 })).toThrow(SheConfigError)
  })

  it('reads a private token file and fails closed on loose permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'she-config-'))
    cleanup.push(dir)
    const path = join(dir, 'token')
    await writeFile(path, 'secret-token\n', { mode: 0o600 })
    expect(await readSheTokenFile(path)).toBe('secret-token')
    await chmod(path, 0o644)
    await expect(readSheTokenFile(path)).rejects.toThrow('must not be readable by group/others')
    await expect(readSheTokenFile(join(dir, 'missing'))).resolves.toBeUndefined()
  })
})
