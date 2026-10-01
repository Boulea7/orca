import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it, vi } from 'vitest'
import {
  SERVE_SUPERVISOR_ENV,
  SERVE_SUPERVISOR_STOP_EXIT_CODE
} from '../../shared/serve-supervision'
import { superviseForegroundServe } from './serve-update-supervisor'

function compiledSource(path: string): string {
  return ts.transpileModule(readFileSync(join(process.cwd(), path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function childSource(): string {
  return `
  function load(source, imports = {}) {
    const exports = {}
    new Function('exports', 'require', source)(exports, (name) => imports[name] ?? require(name))
    return exports
  }
  const supervision = load(${JSON.stringify(compiledSource('src/shared/serve-supervision.ts'))})
  const messages = load(${JSON.stringify(compiledSource('src/shared/serve-update-handoff.ts'))})
  const sender = load(${JSON.stringify(compiledSource('src/main/serve-update-handoff.ts'))}, {
    electron: { app: { getVersion: () => '1.4.181' } },
    './persistence': { getCanonicalUserDataPath: () => '/fixture' },
    '../shared/serve-supervision': supervision,
    '../shared/serve-update-handoff': messages
  })
  function quit() {
    sender.markServeUserQuit()
    sender.notifyServeSupervisorUserQuit(true, false)
      .then(() => process.exit(0), () => process.exit(1))
  }
  process.on('message', (message) => {
    if (message === 'quit') quit()
  })
  if (process.env.ORCA_QUIT_FIXTURE_READY === '1') {
    sender.notifyServeSupervisorReady('runtime-ready', {
      websocket: 'ready', runtime: 'ready', graph: 'ready'
    })
  } else quit()
  `
}

describe('foreground serve user quit over IPC', () => {
  it.each([false, true])(
    'stops after production user quit IPC (ready=%s) and clean exit',
    async (ready) => {
      const childEnv = {
        ...process.env,
        [SERVE_SUPERVISOR_ENV]: '1',
        ORCA_QUIT_FIXTURE_READY: ready ? '1' : '0'
      }
      for (const key of ['HOME', 'CODEX_HOME']) {
        expect(key in childEnv).toBe(key in process.env)
        expect(childEnv[key]).toBe(process.env[key])
      }
      const child = spawn(process.execPath, ['-e', childSource()], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
      const closed = once(child, 'close')
      const healthProbe = vi.fn(async () => ({
        healthy: true as const,
        runtimeId: 'runtime-ready'
      }))
      const spawnChild = vi.fn(() => {
        throw new Error('User quit must not launch a replacement')
      })
      const sleep = vi.fn(async () => undefined)
      try {
        const result = superviseForegroundServe({
          child,
          executable: process.execPath,
          childArgs: [],
          spawnOptions: {},
          spawnChild,
          handoffPath: null,
          expectedHandoff: null,
          healthProbe,
          sleep,
          restartDelaysMs: [1],
          healthCheckIntervalMs: 60_000
        })
        if (ready) {
          await vi.waitFor(() => expect(healthProbe).toHaveBeenCalledOnce())
          await new Promise<void>((resolve, reject) => {
            child.send('quit', (error) => (error ? reject(error) : resolve()))
          })
        }

        await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
        expect(await closed).toEqual([0, null])
        expect(spawnChild).not.toHaveBeenCalled()
        expect(sleep).not.toHaveBeenCalled()
        if (!ready) {
          expect(healthProbe).not.toHaveBeenCalled()
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        await closed
      }
    },
    5_000
  )
})
