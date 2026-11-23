import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { anycubicCatalog } from '../../apps/farm/app/utils/compatibility/anycubic'
import { bambuCatalog } from '../../apps/farm/app/utils/compatibility/bambu'
import { crealityCatalog } from '../../apps/farm/app/utils/compatibility/creality'
import { klipperCatalog } from '../../apps/farm/app/utils/compatibility/klipper'
import { lanCatalog } from '../../apps/farm/app/utils/compatibility/lan'
import { supportedAnycubicActions } from '../../packages/connector/src/anycubic/commands.ts'
import { buildAnycubicFilamentCommand } from '../../packages/connector/src/anycubic/filament.ts'
import {
  supportedBambuActions,
  buildBambuCommand,
} from '../../packages/connector/src/bambu/commands.ts'
import { buildBambuFilamentCommand } from '../../packages/connector/src/bambu/filament.ts'
import { selectBambuCamera } from '../../packages/connector/src/bambu/camera.ts'
import {
  supportedCrealityActions,
  buildCrealityCommand,
} from '../../packages/connector/src/creality/commands.ts'
import { buildCrealityFilamentCommand } from '../../packages/connector/src/creality/filament.ts'
import { createFileTargets } from '../../packages/connector/src/runtime/file-targets.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import { parseCollectorConfig as parseCrealityConfig } from '../../packages/connector/src/config/creality.ts'
import { parseCollectorConfig as parseAnycubicConfig } from '../../packages/connector/src/config/anycubic.ts'
import { parseRtcRuntimeConfig } from '../../packages/connector/src/config/rtc.ts'
import type { AgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { provisionBambuPrinter } from '../../packages/connector/src/control/printer-binding.ts'

/**
 * Cada status do catálogo precisa de uma prova: um caminho de código real do
 * conector ou um teste nomeado. Este arquivo amarra os dois lados — quando o
 * conector muda, o catálogo e este teste falham juntos.
 */

const repoFile = (relative: string) =>
  resolve(import.meta.dirname, '../../', relative)

const catalogById = new Map(
  [
    ...anycubicCatalog,
    ...bambuCatalog,
    ...crealityCatalog,
    ...klipperCatalog,
    ...lanCatalog,
  ].map((product) => [product.id, product]),
)

const statusOf = (id: string, capability: string) =>
  catalogById.get(id)?.capabilities[capability as 'telemetry'] as
    string | undefined

/**
 * Builds a runtime configuration through the real collector parser, so the
 * shape under test is the one the Connector actually accepts. Only the
 * sections that the file-target path reads are populated; the rest keep the
 * same optional/null shape the Connector returns.
 */
const runtimeConfigFor = (
  collection: Record<string, unknown>,
  bindingFor: AgentRuntimeConfig['bindingFor'] = () => undefined,
) =>
  ({
    camera: null,
    rtc: parseRtcRuntimeConfig(undefined),
    collection:
      collection.version === 4
        ? parseCrealityConfig(collection)
        : collection.version === 5
          ? parseAnycubicConfig(collection)
          : parseLocalCollectorConfig(collection),
    telemetry: {
      endpoint: 'https://telemetry.invalid',
      audience: 'openfarm-connector',
      timeoutMs: 5000,
      retryMinMs: 1000,
      retryMaxMs: 30000,
      idleMs: 500,
    },
    discovery: { enabled: true, intervalMs: 600_000 },
    renewal: undefined,
    assignments: [
      {
        assignment_id: 'a',
        farm_id: 'farm',
        agent_id: 'agent',
        printer_key: 'k',
        moonraker_origin: 'http://127.0.0.1:7125',
      },
    ],
    signalling: undefined,
    pause: null,
    bindingFor,
  }) satisfies AgentRuntimeConfig

const bambuBinding = {
  printerKey: 'k',
  host: '127.0.0.1',
  port: 8883,
  serial: 'SERIAL01',
  control: false,
  credentialFile: '/tmp/bambu-credential.json',
  caFile: '/tmp/bambu-ca.pem',
  allowedEndpoints: [{ host: '127.0.0.1', port: 8883 }],
}

describe('sincronização do catálogo de compatibilidade', () => {
  it('cobre todas as famílias de catálogo com produtos distintos', () => {
    expect(anycubicCatalog.length).toBe(5)
    expect(bambuCatalog.length).toBe(5)
    expect(crealityCatalog.length).toBe(5)
    expect(klipperCatalog.length).toBe(5)
    expect(lanCatalog.length).toBe(2)
    expect(catalogById.size).toBe(22)
  })

  it('mantém todo status simulado acompanhado de limitação em pt-BR', () => {
    for (const product of catalogById.values()) {
      for (const [capability, status] of Object.entries(product.capabilities)) {
        if (status !== 'simulated') continue
        expect(
          product.limitations.length,
          `${product.id}.${capability} simulado sem limitação`,
        ).toBeGreaterThan(0)
        expect(
          product.limitations.join(' '),
          `${product.id}.${capability} sem aviso de não comprovado em hardware`,
        ).toMatch(
          /não comprovad[oa] em hardware|nunca em hardware|não comprovado em hardware/,
        )
      }
    }
  })

  it('não promove nenhum item a documentado sem fonte', () => {
    for (const product of catalogById.values()) {
      for (const [capability, status] of Object.entries(product.capabilities)) {
        if (status !== 'documented') continue
        expect(
          product.sources.length,
          `${product.id}.${capability} documentado sem fonte`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('mantém os modelos Anycubic que o driver não reconhece desconhecidos', () => {
    // `supportedAnycubicActions` aceita somente o identificador de modelo
    // 20024; nenhum produto do catálogo Anycubic de base o declara. A Kobra X
    // fica de fora porque usa a ponte KobraLink, não este driver.
    expect(supportedAnycubicActions('20024').length).toBeGreaterThan(0)
    expect(supportedAnycubicActions('kobra-4').length).toBe(0)
    for (const product of anycubicCatalog) {
      if (product.id === 'anycubic-kobra-x') continue
      expect(product.model).not.toContain('20024')
      for (const [capability, status] of Object.entries(product.capabilities)) {
        expect(
          status,
          `${product.id}.${capability} não deveria ser conhecido sem driver`,
        ).toBe('unknown')
      }
    }
  })

  it('mantém a Kobra X simulada fora da telemetria comprovada em hardware', () => {
    const kobra = anycubicCatalog.find(
      (product) => product.id === 'anycubic-kobra-x',
    )!
    // Telemetria comprovada por leitura em um Kobra X real (relatório nativo).
    expect(kobra.capabilities.telemetry).toBe('hardware')
    for (const capability of ['files', 'pause', 'resume', 'cancel'] as const)
      expect(kobra.capabilities[capability]).toBe('simulated')
    // A câmera nativa não está ligada à sessão de mídia do produto.
    expect(kobra.capabilities.camera).toBe('unknown')
    // AMS/ACE aparecem na telemetria, mas fora do vocabulário de comandos assinados.
    expect(kobra.capabilities.materials).toBe('unknown')
  })

  it('liga a LAN Anycubic ao identificador aceito pelo driver', () => {
    const lan = lanCatalog.find(
      (product) => product.id === 'anycubic-kobra-3-lan',
    )!
    expect(lan.model).toContain('20024')
    for (const capability of [
      'telemetry',
      'files',
      'pause',
      'resume',
      'cancel',
    ] as const)
      expect(lan.capabilities[capability]).toBe('simulated')
    expect(supportedAnycubicActions('20024')).toContain('pause')
    expect(supportedAnycubicActions('20024')).toContain('resume')
    // O catálogo chama a ação de cancelamento de `cancel`; o driver LAN a
    // publica como `stop`.
    expect(supportedAnycubicActions('20024')).toContain('stop')
  })

  it('marca materiais da LAN Anycubic como não suportado porque o driver recusa', () => {
    const lan = lanCatalog.find(
      (product) => product.id === 'anycubic-kobra-3-lan',
    )!
    expect(lan.capabilities.materials).toBe('unsupported')
    expect(() => buildAnycubicFilamentCommand('load_filament', 0)).toThrow(
      /unsupported/,
    )
    expect(() => buildAnycubicFilamentCommand('unload_filament', 0)).toThrow(
      /unsupported/,
    )
  })

  it('marca materiais da LAN Creality como não suportado porque o driver recusa', () => {
    const lan = lanCatalog.find(
      (product) => product.id === 'creality-k1-stock-lan',
    )!
    expect(lan.capabilities.materials).toBe('unsupported')
    expect(supportedCrealityActions()).not.toContain('load_filament')
    expect(() => buildCrealityFilamentCommand('load_filament')).toThrow(
      /Unsupported Creality filament action/,
    )
  })

  it('mantém a câmera desconhecida onde o módulo de câmera não está ligado', () => {
    // `createCameraMediaFactory` recebe a configuração do agente sem os
    // mapas por fabricante, então nenhum produto pode declarar câmera
    // comprovada por esse caminho.
    for (const id of [
      'anycubic-kobra-3-lan',
      'creality-k1-stock-lan',
      ...anycubicCatalog.map((product) => product.id),
    ])
      expect(statusOf(id, 'camera')).toBe('unknown')
  })

  it('reflete o driver Creality agnóstico ao modelo em toda a família', () => {
    // `supportedCrealityActions` devolve as ações de controle do WebSocket
    // 9999 e ignora o modelo, o que sustenta o mesmo caminho para a família.
    const supported = supportedCrealityActions()
    for (const action of ['pause', 'resume', 'cancel', 'start_print'])
      expect(supported, `Creality não anuncia ${action}`).toContain(action)
    for (const product of crealityCatalog) {
      for (const capability of [
        'telemetry',
        'pause',
        'resume',
        'cancel',
      ] as const)
        expect(
          product.capabilities[capability],
          `${product.id}.${capability}`,
        ).toBe('simulated')
      // Arquivos: o caminho de estoque é o mesmo para a família e foi
      // exercitado contra o simulador. O Ender-3 V3 Mega mantém `documented`
      // porque o fabricante documenta a transferência por USB, Wi-Fi e nuvem.
      expect(product.capabilities.files, `${product.id}.files`).toBe(
        product.model === 'Ender-3 V3 Mega' ? 'documented' : 'simulated',
      )
      expect(product.capabilities.materials).toBe('unsupported')
      expect(product.capabilities.camera).toBe('unknown')
    }
    expect(() => buildCrealityCommand('pause')).not.toThrow()
    expect(() => buildCrealityCommand('resume')).not.toThrow()
    expect(() => buildCrealityCommand('cancel')).not.toThrow()
  })

  it('liga a câmera Bambu ao seletor de modelo do conector', () => {
    // `selectBambuCamera` aceita A1/P1 em JPEG :6000 e X1/H2/P2 em RTSPS :322.
    expect(
      selectBambuCamera({
        model: 'H2C',
        host: '192.168.1.10',
        accessCode: 'code',
      }),
    ).toMatchObject({ kind: 'rtsps', port: 322 })
    expect(
      selectBambuCamera({
        model: 'P2S',
        host: '192.168.1.10',
        accessCode: 'code',
      }),
    ).toMatchObject({ kind: 'rtsps', port: 322 })
    expect(
      selectBambuCamera({
        model: 'H2S',
        host: '192.168.1.10',
        accessCode: 'code',
      }),
    ).toMatchObject({ kind: 'rtsps', port: 322 })
    for (const model of ['A2L', 'X2D'])
      expect(() =>
        selectBambuCamera({
          model,
          host: '192.168.1.10',
          accessCode: 'code',
        }),
      ).toThrow(/Unsupported Bambu camera model/)
  })

  it('mantém câmera sem evidência simulada para modelos Bambu RTSPS e não mapeados', () => {
    for (const product of bambuCatalog) {
      expect(product.capabilities.camera, product.id).toBe('unknown')
      expect(product.controlAreas.webcams, product.id).toBe('unknown')
    }
  })

  it('liga materiais Bambu aos comandos AMS e à leitura de bandejas', () => {
    expect(supportedBambuActions('H2C')).toContain('load_filament')
    expect(supportedBambuActions('H2C')).toContain('unload_filament')
    expect(() => buildBambuFilamentCommand(0, 220)).not.toThrow()
    expect(() =>
      buildBambuCommand('load_filament', { tray: 0, target_c: 220 }),
    ).not.toThrow()
    for (const product of bambuCatalog)
      expect(product.capabilities.materials).toBe('simulated')
  })

  it('mantém materiais Klipper simulados pelo espelho Spoolman', () => {
    for (const product of klipperCatalog)
      expect(product.capabilities.materials).toBe('simulated')
    expect(
      klipperCatalog.every((product) =>
        product.limitations.join(' ').includes('Spoolman'),
      ),
    ).toBe(true)
  })

  it('mantém arquivos Klipper desconhecidos porque não há alvo Moonraker', () => {
    for (const product of klipperCatalog)
      expect(product.capabilities.files).toBe('unknown')
    // `createFileTargets` só monta alvo para as coleções 2, 4 e 5.
    const targets = createFileTargets({
      config: runtimeConfigFor({
        version: 1,
        printers: [{ printerKey: 'k', origin: 'http://127.0.0.1:7125' }],
        allowedOrigins: ['http://127.0.0.1:7125'],
      }),
      assignmentId: 'a',
      dataDirectory: '/tmp',
    })
    expect(targets.fileList.targetFor('k')).toBeUndefined()
    expect(targets.fileTransfer.targetFor('k')).toBeUndefined()
  })

  it('monta alvos Bambu FTPS com o binding e a credencial locais', async () => {
    // A listagem e o envio por FTPS passivo têm implementação e testes
    // próprios (`bambu/files.ts` e `bambu/ftps.ts`), então o status é
    // `simulated`.
    for (const product of bambuCatalog) {
      expect(product.capabilities.files).toBe('simulated')
      expect(product.limitations.join(' ')).toMatch(/FTPS passivo/)
    }
    const directory = await mkdtemp(join(tmpdir(), 'bambu-file-target-'))
    const credentialFile = join(directory, 'credential.json')
    await writeFile(credentialFile, JSON.stringify({ accessCode: 'secret' }), {
      mode: 0o600,
    })
    try {
      const localBinding = {
        ...bambuBinding,
        credentialFile,
        ftpsPort: 1990,
        pinSha256: 'a'.repeat(64),
        caFile: undefined,
      }
      const handle = provisionBambuPrinter(
        {
          assignment_id: '11111111-1111-4111-8111-111111111111',
          farm_id: '22222222-2222-4222-8222-222222222222',
          agent_id: '33333333-3333-4333-8333-333333333333',
          printer_key: 'k',
        },
        localBinding,
      )
      const targets = createFileTargets({
        config: runtimeConfigFor(
          {
            version: 3,
            printers: [],
            allowedOrigins: [],
            bambu: {
              printers: [
                {
                  ...localBinding,
                  allowedEndpoints: [{ host: '127.0.0.1', port: 8883 }],
                },
              ],
            },
          },
          () => handle,
        ),
        assignmentId: 'a',
        dataDirectory: directory,
      })
      expect(targets.fileTransfer.targetFor('k')).toMatchObject({
        backend: 'bambu',
        host: '127.0.0.1',
        serial: 'SERIAL01',
        port: 1990,
        accessCode: 'secret',
        trust: { pinSha256: 'a'.repeat(64) },
      })
      expect(targets.fileList.targetFor('k')).toMatchObject({
        backend: 'bambu',
        port: 1990,
      })
      expect(targets.fileTransfer.targetFor('foreign')).toBeUndefined()
    } finally {
      await unlink(credentialFile)
      await rmdir(directory)
    }
  })

  it('mantém arquivos Creality e Anycubic LAN simulados porque há alvo', () => {
    // As coleções 4 (Creality) e 5 (Anycubic LAN) produzem alvo de arquivos.
    const creality = createFileTargets({
      config: runtimeConfigFor({
        version: 4,
        printers: [],
        allowedOrigins: [],
        creality: {
          printers: [{ printerKey: 'k', host: '127.0.0.1', port: 9999 }],
        },
      }),
      assignmentId: 'a',
      dataDirectory: '/tmp',
    })
    expect(creality.fileList.targetFor('k')).toMatchObject({
      backend: 'creality',
    })
    expect(creality.fileTransfer.targetFor('k')).toMatchObject({
      backend: 'creality',
    })
    const anycubic = createFileTargets({
      config: runtimeConfigFor({
        version: 5,
        printers: [],
        allowedOrigins: [],
        anycubic: {
          printers: [
            {
              printerKey: 'k',
              host: '127.0.0.1',
              port: 9883,
              modelId: '20024',
              deviceId: 'device01',
              username: 'operator',
              passwordFile: '/tmp/anycubic-password.txt',
            },
          ],
        },
      }),
      assignmentId: 'a',
      dataDirectory: '/tmp',
    })
    expect(anycubic.fileList.targetFor('k')).toMatchObject({
      backend: 'anycubic',
    })
    expect(anycubic.fileTransfer.targetFor('k')).toMatchObject({
      backend: 'anycubic',
    })
    expect(statusOf('creality-k1-stock-lan', 'files')).toBe('simulated')
    expect(statusOf('anycubic-kobra-3-lan', 'files')).toBe('simulated')
  })

  it('não deixa nota de firmware sem versão verificada nem fonte', () => {
    for (const product of catalogById.values()) {
      for (const note of product.firmwareNotes ?? []) {
        expect(note.firmware.length).toBeGreaterThan(0)
        expect(note.note.length).toBeGreaterThan(0)
        expect(note.sources.length).toBeGreaterThan(0)
        expect(
          note.sources.every((source) => new URL(source).protocol === 'https:'),
        ).toBe(true)
        // Uma nota de firmware nomeia uma versão concreta ou declara
        // explicitamente que a versão não foi verificada.
        const namesAVersion = /^V\d/.test(note.firmware)
        const declaredUnverified = note.firmware
          .toLocaleLowerCase('pt-BR')
          .includes('não verificado')
        const namesUserFirmware = note.firmware
          .toLocaleLowerCase('pt-BR')
          .includes('do usuário')
        const namesOwnerFirmware = note.firmware
          .toLocaleLowerCase('pt-BR')
          .includes('do montador')
        const namesVendorFirmware = note.firmware
          .toLocaleLowerCase('pt-BR')
          .includes('firmware')
        expect(
          namesAVersion ||
            declaredUnverified ||
            namesUserFirmware ||
            namesOwnerFirmware ||
            namesVendorFirmware,
          `${product.id} ainda usa nota de firmware sem versão: ${note.firmware}`,
        ).toBe(true)
        // Uma nota que declara a versão não verificada precisa dizer isso no
        // texto, senão o leitor não sabe o que o rótulo significa.
        if (declaredUnverified)
          expect(note.note.toLocaleLowerCase('pt-BR')).toMatch(
            /não (verific|qualific|fixa)|nenhuma versão|não foi/i,
          )
      }
    }
  })

  it('não deixa nota de firmware com rótulo de versão não verificada', async () => {
    const files = [
      'apps/farm/app/utils/compatibility/anycubic.ts',
      'apps/farm/app/utils/compatibility/bambu.ts',
      'apps/farm/app/utils/compatibility/creality.ts',
      'apps/farm/app/utils/compatibility/klipper.ts',
      'apps/farm/app/utils/compatibility/lan.ts',
    ]
    for (const file of files) {
      const source = await readFile(repoFile(file), 'utf8')
      // O rótulo em português é a única forma de declarar que a versão não
      // foi verificada; nada mais pode ser usado como substituto.
      expect(source, `${file} ainda usa rótulo de firmware antigo`).not.toMatch(
        /firmware:\s*'[^']*(?:[Vv]ersão\s+desconhecida|[Dd]esconhecido)'/,
      )
      expect(source, `${file} ainda usa rótulo de firmware antigo`).not.toMatch(
        /firmwareStatus:\s*'[^']*[Dd]esconhecid[oa][^']*'/,
      )
    }
  })

  it('mantém o texto de firmwarestatus coerente com a nota mais recente', () => {
    for (const product of catalogById.values()) {
      const notes = product.firmwareNotes ?? []
      if (!notes.length) continue
      const hasUnverified = notes.some(
        (note) => note.firmware === 'não verificado',
      )
      if (hasUnverified)
        expect(
          product.firmwareStatus,
          `${product.id} declara firmwareStatus sem combinar com a nota`,
        ).toContain('não verificado')
    }
  })
})
