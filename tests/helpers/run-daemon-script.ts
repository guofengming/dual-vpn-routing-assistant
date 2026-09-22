import { spawn } from 'node:child_process'
import path from 'node:path'

export interface ScriptResult {
  exitCode: number
  stdout: string
  stderr: string
  operations: string[][]
}

const projectRoot = path.resolve(import.meta.dirname, '../..')

export async function runDaemonScript(
  script: string,
  args: string[],
  fixture: string
): Promise<ScriptResult> {
  const scriptPath = path.join(projectRoot, 'resources/daemon', script)
  const fixturePath = path.join(projectRoot, 'tests/fixtures', fixture)

  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', [scriptPath, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DUALVPN_TEST_MODE: '1',
        DUALVPN_FIXTURE_DIR: fixturePath
      }
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      const operations = stdout
        .split('\n')
        .filter((line) => line.startsWith('operation='))
        .map((line) => line.slice('operation='.length).split('|'))
      resolve({ exitCode: code ?? 1, stdout, stderr, operations })
    })
  })
}

export function runProbeFixture(fixture: string): Promise<ScriptResult> {
  return runDaemonScript('lib/probe.sh', ['--print'], fixture)
}

export async function runRouteScenario(
  fixture: string
): Promise<ScriptResult & { finalManagedRoutes: string[] }> {
  const result = await runDaemonScript(
    'lib/routes.sh',
    ['--test-apply', 'en0', '172.19.132.1', 'utun4'],
    fixture
  )
  const finalManagedRoutes = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('final_route='))
    .map((line) => line.slice('final_route='.length))
  return { ...result, finalManagedRoutes }
}
