import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src', 'integrations', 'she')

describe('SHE integration dependency boundary', () => {
  it('imports only public @she packages and never dsh/bridge/secretary internals', async () => {
    const files = (await readdir(root)).filter(file => file.endsWith('.ts'))
    const source = await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))
    const all = source.join('\n')
    expect(all).toMatch(/@she\/(client|protocol)/)
    expect(all).not.toMatch(/@she\/(core|control|store|agent|sandbox)/)
    expect(all).not.toMatch(/from ['"](?:\.\.\/)+(?:bridge|runtime)\.js['"]/)
    expect(all).not.toMatch(/secretary/)
  })
})
