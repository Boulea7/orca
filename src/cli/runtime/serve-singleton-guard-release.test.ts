import { EventEmitter } from 'node:events'
import { readlinkSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import type * as Filesystem from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SERVE_ALREADY_RUNNING_EXIT_CODE,
  SERVE_SUPERVISOR_STOP_EXIT_CODE
} from '../../shared/serve-supervision'
import {
  recoverStaleServeSingleton,
  type ServeSingletonRecoveryResult
} from './serve-singleton-recovery'
import { superviseForegroundServe } from './serve-update-supervisor'

const guardFault = vi.hoisted(() => ({
  path: '',
  companionPath: '',
  armed: false,
  unlinkCode: null as string | null,
  readlinkCode: null as string | null,
  renameCode: null as string | null,
  afterMove: null as 'remove' | 'replace' | null,
  replacementTarget: ''
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const filesystem = await importOriginal<typeof Filesystem>()
  return {
    ...filesystem,
    unlink: async (...args: Parameters<typeof filesystem.unlink>) => {
      if (guardFault.armed && String(args[0]) === guardFault.path && guardFault.unlinkCode) {
        if (guardFault.unlinkCode === 'ENOENT') {
          await filesystem.unlink(...args)
        }
        throw Object.assign(new Error('guard unlink failed'), { code: guardFault.unlinkCode })
      }
      return filesystem.unlink(...args)
    },
    readlink: (...args: Parameters<typeof filesystem.readlink>) => {
      if (guardFault.armed && String(args[0]) === guardFault.path && guardFault.readlinkCode) {
        return Promise.reject(
          Object.assign(new Error('guard readlink failed'), { code: guardFault.readlinkCode })
        )
      }
      return filesystem.readlink(...args)
    },
    rename: async (...args: Parameters<typeof filesystem.rename>) => {
      const movingCompanion = String(args[0]) === guardFault.companionPath
      if (movingCompanion && guardFault.renameCode) {
        throw Object.assign(new Error('companion rename failed'), { code: guardFault.renameCode })
      }
      await filesystem.rename(...args)
      if (movingCompanion && guardFault.afterMove) {
        await filesystem.unlink(guardFault.path)
        if (guardFault.afterMove === 'replace') {
          await filesystem.symlink(guardFault.replacementTarget, guardFault.path)
        }
      }
    }
  }
})

class ServeChild extends EventEmitter {
  pid = 4101
  kill = vi.fn()
}

describe.skipIf(process.platform === 'win32')('serve singleton guard release', () => {
  const roots: string[] = []

  afterEach(async () => {
    Object.assign(guardFault, {
      path: '',
      companionPath: '',
      armed: false,
      unlinkCode: null,
      readlinkCode: null,
      renameCode: null,
      afterMove: null,
      replacementTarget: ''
    })
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createProfile(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-singleton-guard-'))
    roots.push(root)
    guardFault.path = join(root, 'SingletonLock')
    guardFault.companionPath = join(root, 'SingletonCookie')
    await symlink(`${hostname()}-987654`, guardFault.path)
    await symlink('stale-cookie', join(root, 'SingletonCookie'))
    return root
  }

  function recoverProfile(root: string): Promise<ServeSingletonRecoveryResult> {
    return recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => false,
      wait: async () => undefined,
      quarantineSuffix: 'guard-test',
      createRecoveryGuardLink: async (target, path) => {
        await symlink(target, path)
        guardFault.armed = true
      }
    })
  }

  it('refuses replacement when its live recovery guard cannot be removed', async () => {
    const root = await createProfile()
    guardFault.unlinkCode = 'EPERM'
    const recoveries: ServeSingletonRecoveryResult[] = []
    const recoverSingleton = async (): Promise<ServeSingletonRecoveryResult> => {
      const recovery = await recoverProfile(root)
      recoveries.push(recovery)
      return recovery
    }
    const child = new ServeChild()
    const spawnChild = vi.fn(() => {
      const replacement = new ServeChild()
      setTimeout(() => replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null), 0)
      return replacement as never
    })
    const sleep = vi.fn(async () => undefined)
    const result = superviseForegroundServe({
      executable: '/opt/orca/orca',
      childArgs: ['--serve'],
      spawnOptions: {},
      spawnChild,
      handoffPath: null,
      child: child as never,
      expectedHandoff: null,
      recoverSingleton,
      sleep
    })
    child.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)
    const code = await result

    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
    expect(recoveries).toEqual([
      { state: 'not-recoverable', reason: 'quarantine_failed', errorCode: 'EPERM' }
    ])
    expect(code).toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(spawnChild).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('refuses recovery when it cannot verify that its guard was released', async () => {
    const root = await createProfile()
    guardFault.readlinkCode = 'EACCES'

    await expect(recoverProfile(root)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EACCES'
    })
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
  })

  it('preserves a foreign owner that replaces its recovery guard', async () => {
    const root = await createProfile()
    guardFault.afterMove = 'replace'
    guardFault.replacementTarget = `${hostname()}-123456`

    await expect(recoverProfile(root)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'owner_changed'
    })
    expect(readlinkSync(guardFault.path)).toBe(guardFault.replacementTarget)
  })

  it('accepts a guard that disappeared before its release check', async () => {
    const root = await createProfile()
    guardFault.afterMove = 'remove'

    await expect(recoverProfile(root)).resolves.toMatchObject({ state: 'recovered' })
    expect(() => readlinkSync(guardFault.path)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('accepts a guard that disappeared during unlink', async () => {
    const root = await createProfile()
    guardFault.unlinkCode = 'ENOENT'

    await expect(recoverProfile(root)).resolves.toMatchObject({ state: 'recovered' })
    expect(() => readlinkSync(guardFault.path)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('keeps the original move error when releasing the guard also fails', async () => {
    const root = await createProfile()
    guardFault.renameCode = 'EIO'
    guardFault.unlinkCode = 'EPERM'
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(recoverProfile(root)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EIO'
    })
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
    expect(diagnostic).toHaveBeenCalledWith(
      '[serve] could not release singleton recovery guard (EPERM).\n'
    )
  })
})
