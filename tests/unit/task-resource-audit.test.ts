import { describe, expect, test } from 'bun:test'
import {
  classifyOwnership,
  EXIT_COMPLETE,
  EXIT_LEFTOVERS,
  EXIT_PARTIAL,
  EXIT_USAGE,
  parseAuditArgs,
  parseResourceLine,
  parseWorktreeList,
  partitionByOwnership,
  summarizeStatus,
  validateTaskLabel,
  type AuditEnvironment,
  type CommandRunner,
  type ResourceEntry,
} from '../../scripts/audit-task-resources.ts'

const TASK = 'o3dfm-task-alpha'

function container(id: string, name: string, taskLabel: string): ResourceEntry {
  return {
    kind: 'container',
    id,
    name,
    taskLabel,
    state: 'running',
    image: 'postgres:17',
    platform: 'linux/arm64',
    driver: null,
    createdAt: '2026-11-04T21:07:01Z',
  }
}

describe('task label validation', () => {
  test('accepts an ordinary opaque label value', () => {
    const result = validateTaskLabel(TASK)
    expect(result).toEqual({ ok: true, value: TASK })
  })

  test('rejects empty, padded, control-character and oversized values', () => {
    for (const invalid of [
      '',
      ' leading',
      'trailing ',
      'has\u0000null',
      'has\nnewline',
      'a'.repeat(129),
    ]) {
      const result = validateTaskLabel(invalid)
      expect(result.ok).toBe(false)
    }
  })
})

describe('CLI argument validation', () => {
  test('requires an explicit task label', () => {
    const result = parseAuditArgs([])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('--task-label')
  })

  test('rejects unknown arguments and missing values', () => {
    for (const argv of [
      ['--task-label', TASK, '--unknown'],
      ['--task-label'],
      ['--repo'],
      ['positional'],
    ]) {
      expect(parseAuditArgs(argv).ok).toBe(false)
    }
  })

  test('accepts both spellings of the label option and defaults the repository', () => {
    const spaced = parseAuditArgs(['--task-label', TASK])
    const equals = parseAuditArgs([`--task-label=${TASK}`])
    expect(spaced.ok).toBe(true)
    expect(equals.ok).toBe(true)
    if (!spaced.ok || !equals.ok) throw new Error('expected success')
    expect(spaced.value.taskLabel).toBe(TASK)
    expect(equals.value.taskLabel).toBe(TASK)
    expect(spaced.value.repository.length).toBeGreaterThan(0)
    expect(equals.value.repository.length).toBeGreaterThan(0)
  })

  test('honours an explicit repository and the help flag', () => {
    const withRepo = parseAuditArgs(['--task-label', TASK, '--repo', '/tmp/x'])
    expect(withRepo.ok).toBe(true)
    if (!withRepo.ok) throw new Error('expected success')
    expect(withRepo.value.repository).toBe('/tmp/x')

    const help = parseAuditArgs(['--help'])
    expect(help.ok).toBe(true)
    if (!help.ok) throw new Error('expected success')
    expect(help.value.help).toBe(true)
  })

  test('rejects a task label that fails validation', () => {
    expect(parseAuditArgs(['--task-label', ' padded ']).ok).toBe(false)
  })
})

describe('ownership classification', () => {
  test('requires an exact label value match', () => {
    expect(classifyOwnership(TASK, TASK)).toBe('task-owned')
    expect(classifyOwnership(`${TASK}-extra`, TASK)).toBe('other-task')
    expect(classifyOwnership('other', TASK)).toBe('other-task')
    expect(classifyOwnership(TASK.toUpperCase(), TASK)).toBe('other-task')
    expect(classifyOwnership('', TASK)).toBe('unlabeled')
  })

  test('never infers ownership from a name that contains the label text', () => {
    const labelled = container('abc123', `${TASK}-pg`, 'unrelated-label')
    const unlabelled = container('def456', `${TASK}-pg`, '')
    const partition = partitionByOwnership([labelled, unlabelled], TASK)
    expect(partition.owned).toHaveLength(0)
    expect(partition.otherTask).toEqual([labelled])
    expect(partition.unlabeled).toEqual([unlabelled])
  })

  test('separates owned, other-task and unlabeled resources', () => {
    const owned = container('a', 'owned-name', TASK)
    const other = container('b', 'other-name', 'someone-else')
    const plain = container('c', 'plain-name', '')
    const partition = partitionByOwnership([owned, other, plain], TASK)
    expect(partition.owned).toEqual([owned])
    expect(partition.otherTask).toEqual([other])
    expect(partition.unlabeled).toEqual([plain])
  })
})

describe('docker line parsing', () => {
  test('parses a container line and reads the task label as JSON', () => {
    const line = [
      '56b976dfedc9',
      'o3dfm-task-alpha-pg',
      'running',
      'postgres:17',
      'linux/arm64/v8',
      '2026-11-04T21:07:01Z',
      JSON.stringify(TASK),
    ].join('\x1f')
    const entry = parseResourceLine('container', line)
    expect(entry).not.toBeNull()
    expect(entry?.taskLabel).toBe(TASK)
    expect(entry?.name).toBe('o3dfm-task-alpha-pg')
    expect(entry?.state).toBe('running')
  })

  test('parses volume and network lines', () => {
    const volume = parseResourceLine(
      'volume',
      ['alpha-data', 'local', JSON.stringify(TASK)].join('\x1f'),
    )
    expect(volume?.taskLabel).toBe(TASK)
    expect(volume?.driver).toBe('local')

    const network = parseResourceLine(
      'network',
      [
        '61a8a4614af8',
        'alpha-net',
        'bridge',
        '2026-11-04T18:11:12Z',
        JSON.stringify(''),
      ].join('\x1f'),
    )
    expect(network?.taskLabel).toBe('')
    expect(network?.name).toBe('alpha-net')
  })

  test('rejects malformed lines instead of guessing', () => {
    expect(parseResourceLine('container', '')).toBeNull()
    expect(parseResourceLine('container', 'not-json\x1f"oops"')).toBeNull()
    expect(parseResourceLine('container', 'only-one-field')).toBeNull()
  })
})

describe('git worktree and status parsing', () => {
  test('parses worktree porcelain output', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/farm/task-resource-hygiene',
      '',
      'worktree /repo-wt',
      'HEAD def456',
      'detached',
      '',
    ].join('\n')
    const worktrees = parseWorktreeList(output)
    expect(worktrees).toHaveLength(2)
    expect(worktrees[0]?.branch).toBe('farm/task-resource-hygiene')
    expect(worktrees[0]?.head).toBe('abc123')
    expect(worktrees[1]?.detached).toBe(true)
    expect(worktrees[1]?.branch).toBeNull()
  })

  test('counts staged, modified, untracked and conflicted status entries', () => {
    const counts = summarizeStatus([
      ' M src/a.ts',
      'M  src/b.ts',
      '?? src/c.ts',
      'MM src/d.ts',
      'UU src/e.ts',
      'R  old.ts -> new.ts',
    ])
    expect(counts.staged).toBe(4)
    expect(counts.modified).toBe(3)
    expect(counts.untracked).toBe(1)
    expect(counts.renamed).toBe(1)
    expect(counts.conflicted).toBe(1)
  })
})

describe('report assembly', () => {
  const usage = {
    path: '/repo',
    device: '16777220',
    totalBytes: 1_000_000,
    freeBytes: 400_000,
    usedBytes: 600_000,
    usedPercent: 60,
  }

  function environment(
    run: CommandRunner,
    capacityOk = true,
  ): AuditEnvironment {
    return {
      run,
      capacity: async () => (capacityOk ? usage : null),
      now: () => new Date('2026-11-04T22:00:00.000Z'),
    }
  }

  const containerLine = [
    '56b976dfedc9',
    'o3dfm-task-alpha-pg',
    'running',
    'postgres:17',
    'linux/arm64/v8',
    '2026-11-04T21:07:01Z',
    JSON.stringify(TASK),
  ].join('\x1f')

  const dockerRunner: CommandRunner = async (file, args) => {
    if (file === 'docker') {
      if (args[0] === 'version')
        return {
          code: 0,
          stdout: '29.8.2\n',
          stderr: '',
          failed: false,
          error: null,
        }
      if (args[0] === 'ps')
        return {
          code: 0,
          stdout: containerLine + '\n',
          stderr: '',
          failed: false,
          error: null,
        }
      if (args[0] === 'volume')
        return { code: 0, stdout: '', stderr: '', failed: false, error: null }
      if (args[0] === 'network')
        return { code: 0, stdout: '', stderr: '', failed: false, error: null }
    }
    if (file === 'git') {
      if (args.includes('worktree'))
        return {
          code: 0,
          stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/farm/x\n',
          stderr: '',
          failed: false,
          error: null,
        }
      return { code: 0, stdout: '', stderr: '', failed: false, error: null }
    }
    return { code: 0, stdout: '', stderr: '', failed: false, error: null }
  }

  test('reports a complete audit with owned resources and a leftovers exit code', async () => {
    const { buildReport } = await import(
      '../../scripts/audit-task-resources.ts'
    )
    const report = await buildReport(
      { taskLabel: TASK, repository: '/repo', pretty: false },
      environment(dockerRunner),
    )
    expect(report.status).toBe('complete')
    expect(report.exitCode).toBe(EXIT_LEFTOVERS)
    expect(report.docker.owned.container.count).toBe(1)
    expect(report.docker.owned.container.items[0]?.taskLabel).toBe(TASK)
    expect(report.docker.owned.container.items[0]?.name).toBe(
      'o3dfm-task-alpha-pg',
    )
    expect(report.filesystem.capacity).toHaveLength(1)
    expect(report.git.worktrees).toHaveLength(1)
    expect(report.notes.join(' ')).toContain('Read-only')
  })

  test('returns a partial report and a nonzero exit when docker is unavailable', async () => {
    const { buildReport } = await import(
      '../../scripts/audit-task-resources.ts'
    )
    const failing: CommandRunner = async (file) => {
      if (file === 'docker')
        return {
          code: 1,
          stdout: '',
          stderr: 'Cannot connect to the Docker daemon',
          failed: true,
          error: 'spawn failed',
        }
      if (file === 'git')
        return {
          code: 0,
          stdout: 'worktree /repo\nHEAD abc123\n',
          stderr: '',
          failed: false,
          error: null,
        }
      return { code: 0, stdout: '', stderr: '', failed: false, error: null }
    }
    const report = await buildReport(
      { taskLabel: TASK, repository: '/repo', pretty: false },
      environment(failing),
    )
    expect(report.status).toBe('partial')
    expect(report.exitCode).toBe(EXIT_PARTIAL)
    expect(report.docker.status).toBe('unavailable')
    expect(report.docker.reason).toContain('Docker daemon unavailable')
    expect(report.docker.owned.container.count).toBe(0)
  })

  test('returns a complete report and a clean exit code with no owned resources', async () => {
    const { buildReport } = await import(
      '../../scripts/audit-task-resources.ts'
    )
    const empty: CommandRunner = async (file, args) => {
      if (file === 'docker' && args[0] === 'version')
        return {
          code: 0,
          stdout: '29.8.2\n',
          stderr: '',
          failed: false,
          error: null,
        }
      if (file === 'docker')
        return { code: 0, stdout: '', stderr: '', failed: false, error: null }
      if (file === 'git' && args.includes('worktree'))
        return {
          code: 0,
          stdout: 'worktree /repo\nHEAD abc123\n',
          stderr: '',
          failed: false,
          error: null,
        }
      return { code: 0, stdout: '', stderr: '', failed: false, error: null }
    }
    const report = await buildReport(
      { taskLabel: TASK, repository: '/repo', pretty: false },
      environment(empty),
    )
    expect(report.status).toBe('complete')
    expect(report.exitCode).toBe(EXIT_COMPLETE)
    expect(report.docker.owned.container.count).toBe(0)
  })

  test('exposes distinct exit codes for usage, partial and complete runs', () => {
    expect(EXIT_USAGE).toBe(1)
    expect(EXIT_PARTIAL).toBe(2)
    expect(EXIT_COMPLETE).toBe(0)
    expect(EXIT_LEFTOVERS).toBe(3)
  })

  test('keeps other projects resource details out of non-owned buckets', async () => {
    const { buildReport } = await import(
      '../../scripts/audit-task-resources.ts'
    )
    const foreignLine = [
      'aaa111bbb222',
      'other-project-app',
      'running',
      'private-image:1.2.3',
      'linux/amd64',
      '2026-11-01T10:00:00Z',
      JSON.stringify('another-task'),
    ].join('\x1f')
    const runner: CommandRunner = async (file, args) => {
      if (file === 'docker' && args[0] === 'version')
        return {
          code: 0,
          stdout: '29.8.2\n',
          stderr: '',
          failed: false,
          error: null,
        }
      if (file === 'docker' && args[0] === 'ps')
        return {
          code: 0,
          stdout: foreignLine + '\n',
          stderr: '',
          failed: false,
          error: null,
        }
      if (file === 'docker')
        return { code: 0, stdout: '', stderr: '', failed: false, error: null }
      if (file === 'git' && args.includes('worktree'))
        return {
          code: 0,
          stdout: 'worktree /repo\nHEAD abc123\n',
          stderr: '',
          failed: false,
          error: null,
        }
      return { code: 0, stdout: '', stderr: '', failed: false, error: null }
    }
    const report = await buildReport(
      { taskLabel: TASK, repository: '/repo', pretty: false },
      environment(runner),
    )
    expect(report.docker.owned.container.count).toBe(0)
    expect(report.docker.otherTask.container.count).toBe(1)
    const sample = report.docker.otherTask.container.sample[0]
    expect(sample?.name).toBe('other-project-app')
    expect(sample?.taskLabel).toBe('another-task')
    expect(Object.keys(sample ?? {}).sort()).toEqual([
      'id',
      'kind',
      'name',
      'taskLabel',
    ])
    expect(JSON.stringify(report)).not.toContain('private-image')
  })
})
