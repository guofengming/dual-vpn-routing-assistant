import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function projectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('release assets', () => {
  it('publishes only the universal DMG without a checksum artifact', () => {
    const workflow = projectFile('.github/workflows/release.yml')
    const verifier = projectFile('scripts/verify-universal.sh')

    expect(workflow).toContain('dist/*-universal.dmg')
    expect(workflow).not.toContain('SHA256SUMS')
    expect(verifier).not.toContain('SHA256SUMS')
    expect(verifier).not.toContain('shasum')
  })
})
