import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { setupFormsBundle } from './mount-setup-forms.ts'

let certDir = ''
let validKeySnippet = ''

test.beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'openfarm-e2e-kobra-cert-'))
  const run = (args: string[]) =>
    execFileSync('openssl', args, { encoding: 'utf8' })

  const validKey = join(certDir, 'valid.key')
  const validCert = join(certDir, 'valid.crt')
  run([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=AnycubicSlicer',
    '-days',
    '30',
    '-keyout',
    validKey,
    '-out',
    validCert,
  ])
  const validKeyText = readFileSync(validKey, 'utf8')
  const validCertText = readFileSync(validCert, 'utf8')
  validKeySnippet =
    validKeyText
      .split('\n')
      .find((line) => line && !line.startsWith('-----')) ?? ''
  writeFileSync(
    join(certDir, 'valid-bundle.pem'),
    `${validCertText}\n${validKeyText}`,
  )
  run([
    'pkcs12',
    '-export',
    '-in',
    validCert,
    '-inkey',
    validKey,
    '-passout',
    'pass:slicer-test-pass',
    '-out',
    join(certDir, 'valid.p12'),
  ])

  const wrongKey = join(certDir, 'wrong.key')
  const wrongCert = join(certDir, 'wrong.crt')
  run([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=WrongOperator',
    '-days',
    '30',
    '-keyout',
    wrongKey,
    '-out',
    wrongCert,
  ])
  writeFileSync(
    join(certDir, 'wrong-subj.pem'),
    `${readFileSync(wrongCert, 'utf8')}\n${readFileSync(wrongKey, 'utf8')}`,
  )

  // Expired certificate signed with a disposable local CA
  const caKey = join(certDir, 'ca.key')
  const caCert = join(certDir, 'ca.crt')
  run([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=TestCA',
    '-days',
    '3650',
    '-keyout',
    caKey,
    '-out',
    caCert,
  ])
  const expKey = join(certDir, 'expired.key')
  const expCsr = join(certDir, 'expired.csr')
  const expCert = join(certDir, 'expired.crt')
  run([
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=AnycubicSlicer',
    '-keyout',
    expKey,
    '-out',
    expCsr,
  ])
  const caDb = join(certDir, 'index.txt')
  const caSerial = join(certDir, 'serial')
  const caNewCerts = join(certDir, 'newcerts')
  const caCnf = join(certDir, 'ca.cnf')
  mkdirSync(caNewCerts)
  writeFileSync(caDb, '')
  writeFileSync(caSerial, '01\n')
  writeFileSync(
    caCnf,
    `[ ca ]\ndefault_ca = CA_default\n[ CA_default ]\nnew_certs_dir = ${caNewCerts}\ndatabase = ${caDb}\nserial = ${caSerial}\ncertificate = ${caCert}\nprivate_key = ${caKey}\ndefault_md = sha256\npolicy = policy_any\n[ policy_any ]\ncommonName = optional\n`,
  )
  run([
    'ca',
    '-batch',
    '-config',
    caCnf,
    '-in',
    expCsr,
    '-out',
    expCert,
    '-startdate',
    '20200101000000Z',
    '-enddate',
    '20210101000000Z',
  ])
  writeFileSync(
    join(certDir, 'expired.pem'),
    `${readFileSync(expCert, 'utf8')}\n${readFileSync(expKey, 'utf8')}`,
  )
  writeFileSync(
    join(certDir, 'corrupt.pem'),
    'not valid pem certificate material',
  )
})

test.afterAll(() => {
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

// Nuxt normally supplies these routing auto-imports. Keep them tied to the
// browser URL when mounting the page outside Nuxt, including after reloads.
async function mountForms(page: Page, revision: number | null = 1) {
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="fixture"></div>'
    const route = {
      get path() {
        return location.pathname
      },
      get query() {
        return Object.fromEntries(new URLSearchParams(location.search))
      },
      get hash() {
        return location.hash
      },
    }
    Object.assign(window, {
      useRoute: () => route,
      useRouter: () => ({
        replace: ({
          path,
          query,
          hash,
        }: {
          path: string
          query: Record<string, string | null>
          hash: string
        }) => {
          const url = new URL(path, location.origin)
          for (const [key, value] of Object.entries(query)) {
            if (value != null) url.searchParams.set(key, value)
          }
          url.hash = hash
          history.replaceState(null, '', url)
          return Promise.resolve()
        },
      }),
    })
  })
  await page.addScriptTag({ content: await setupFormsBundle(revision) })
  await page.evaluate(() =>
    (window as any).mountSetupForms(document.querySelector('#fixture')),
  )
}

test.beforeEach(async ({ page }) => {
  await page.goto('/healthz')
  await mountForms(page)
})

test('forms expose unique labelled controls and validate each family', async ({
  page,
}) => {
  const family = page.getByLabel('Família da impressora')
  for (const [value, label, invalid] of [
    [
      'klipper-moonraker',
      'Origem HTTP(S) do Moonraker',
      'http://example.com/path',
    ],
    ['bambu-lan', 'Endereço IPv4 da Bambu Lab na LAN', 'bad'],
    ['creality-native', 'Endereço IPv4 da Creality na LAN', 'bad'],
    ['anycubic-lan', 'Endereço IPv4 na LAN', 'bad'],
  ] as const) {
    await family.selectOption(value)
    const ids = await page
      .locator('[id]')
      .evaluateAll((nodes) => nodes.map((node) => node.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const input of await page.locator('input, select').all()) {
      expect(
        await input.evaluate(
          (node) => (node as HTMLInputElement).labels?.length,
        ),
      ).toBeGreaterThan(0)
    }
    await page.getByLabel(label, { exact: true }).fill(invalid)
    if (value === 'bambu-lan') {
      await page.getByLabel('Número de série').fill('ABC123')
      await page.getByLabel('Código de acesso LAN').fill('secret123')
    }
    if (value === 'anycubic-lan') {
      await page.getByLabel('Identificador do modelo').fill('model')
      await page.getByLabel('Identificador do dispositivo').fill('device')
      await page.getByLabel('Usuário LAN').fill('user')
      await page.getByLabel('Senha LAN').fill('secret123')
    }
    await page.getByRole('button', { name: /^Preparar/ }).click()
    const messages: Record<string, string> = {
      'klipper-moonraker': 'Informe uma origem HTTP(S)',
      'bambu-lan': 'Informe o endereço IPv4 da impressora',
      'creality-native': 'Informe o endereço IPv4 da Creality',
      'anycubic-lan':
        'Informe IPv4, porta, modelo, identidade e credenciais LAN válidos.',
    }
    await expect(page.getByRole('alert')).toContainText(messages[value]!)
    await expect(page.getByRole('alert')).not.toContainText('secret123')
  }
})

test('Kobra X setup form validates PEM and PKCS#12 client certificate import, shows subject and expiry, and surfaces clear errors', async ({
  page,
}) => {
  await page
    .getByLabel('Família da impressora')
    .selectOption('anycubic-kobra-x')

  const ids = await page
    .locator('[id]')
    .evaluateAll((nodes) => nodes.map((node) => node.id))
  expect(new Set(ids).size).toBe(ids.length)
  for (const input of await page.locator('input, select').all()) {
    expect(
      await input.evaluate((node) => (node as HTMLInputElement).labels?.length),
    ).toBeGreaterThan(0)
  }

  await page.getByLabel('Endereço IPv4 da Kobra X na LAN').fill('192.168.1.50')

  // 0. A new setup is native by default; the KobraLink bridge is an explicit legacy choice
  const prepareKobraX = page.getByRole('button', {
    name: 'Preparar Anycubic Kobra X',
  })
  await expect(page.locator('#kobra-mode-native')).toBeChecked()
  await expect(page.locator('#kobra-mode-native-help')).toContainText(
    'sem Docker e sem ponte',
  )
  await expect(page.locator('#kobra-mode-bridge')).not.toBeChecked()
  await expect(prepareKobraX).toBeEnabled()
  await expect(page.locator('main')).not.toContainText(
    /conectad[ao] com sucesso/i,
  )

  // 1. Missing certificate on submit
  await prepareKobraX.click()
  await expect(page.getByRole('alert')).toContainText(
    /client certificate missing/i,
  )

  const fileInput = page.locator('#kobra-cert-file')
  const passphraseInput = page.locator('#kobra-cert-passphrase')
  await expect(passphraseInput).toHaveAttribute('type', 'password')

  // 2. Unreadable corrupt PEM
  await fileInput.setInputFiles(join(certDir, 'corrupt.pem'))
  await expect(page.getByRole('alert')).toContainText(/unreadable/i)
  await expect(page.locator('dl')).toHaveCount(0)

  // 3. Wrong subject (CN != AnycubicSlicer)
  await fileInput.setInputFiles(join(certDir, 'wrong-subj.pem'))
  await expect(page.getByRole('alert')).toContainText(/wrong subject/i)
  await expect(page.getByRole('alert')).toContainText('WrongOperator')
  await expect(page.locator('dl')).toHaveCount(0)

  // 4. Expired certificate
  await fileInput.setInputFiles(join(certDir, 'expired.pem'))
  await expect(page.getByRole('alert')).toContainText(/expired/i)
  await expect(page.locator('dl')).toHaveCount(0)

  // 5. Success with split PEM (.crt + .key): shows subject and expiry, hides key material
  await fileInput.setInputFiles([
    join(certDir, 'valid.crt'),
    join(certDir, 'valid.key'),
  ])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('dl')).toContainText('PEM')
  await expect(page.locator('dl')).toContainText('AnycubicSlicer')
  await expect(page.locator('dl')).toContainText(/\d{4}-\d{2}-\d{2}T/)
  if (validKeySnippet) {
    await expect(page.locator('main')).not.toContainText(validKeySnippet)
  }

  // 6. PKCS#12 wrong passphrase -> unreadable -> correct passphrase -> valid PKCS12 summary
  await passphraseInput.fill('wrong-pass')
  await fileInput.setInputFiles(join(certDir, 'valid.p12'))
  await expect(page.getByRole('alert')).toContainText(/unreadable/i)
  await expect(page.locator('dl')).toHaveCount(0)

  await passphraseInput.fill('slicer-test-pass')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('dl')).toContainText('PKCS12')
  await expect(page.locator('dl')).toContainText('AnycubicSlicer')
  await expect(page.locator('main')).not.toContainText('slicer-test-pass')

  // 7. Install-path mode explains typical Slicer Next locations and rejects empty path
  await page
    .getByLabel('Certificado de cliente MQTT do Anycubic Slicer Next')
    .selectOption('install-path')
  await expect(page.locator('#kobra-cert-locations')).toContainText(
    '/Applications/AnycubicSlicerNext.app/Contents/Resources',
  )
  await expect(page.locator('#kobra-cert-locations')).toContainText(
    'Program Files\\AnycubicSlicerNext\\resources',
  )
  await expect(page.locator('#kobra-cert-locations')).toContainText(
    '/opt/AnycubicSlicerNext/resources',
  )
  await page.getByRole('button', { name: 'Preparar Anycubic Kobra X' }).click()
  await expect(page.getByRole('alert')).toContainText(
    /client certificate missing/i,
  )

  // 8. Full submit path passes validation without storing private key or passphrase in sessionStorage
  await page.reload()
  await mountForms(page, null)
  await page
    .getByLabel('Família da impressora')
    .selectOption('anycubic-kobra-x')
  await page.getByLabel('Endereço IPv4 da Kobra X na LAN').fill('192.168.1.50')
  await expect(
    page.getByRole('button', { name: 'Preparar Anycubic Kobra X' }),
  ).toBeEnabled()
  await expect(page.locator('#kobra-mode-native')).toBeChecked()
  await page
    .locator('#kobra-cert-file')
    .setInputFiles(join(certDir, 'valid-bundle.pem'))
  await expect(page.locator('dl')).toContainText('AnycubicSlicer')
  await page.getByRole('button', { name: 'Preparar Anycubic Kobra X' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Configuração não disponível neste Connector.',
  )
  const storedText = await page.evaluate(() => JSON.stringify(sessionStorage))
  if (validKeySnippet) {
    expect(storedText).not.toContain(validKeySnippet)
  }
  expect(storedText).not.toContain('slicer-test-pass')
})

test('Moonraker rejects mixed credentials and secrets stay out of rendered text', async ({
  page,
}) => {
  await page
    .getByLabel('Família da impressora')
    .selectOption('klipper-moonraker')
  await page
    .getByLabel('Origem HTTP(S) do Moonraker')
    .fill('http://192.168.1.20:7125')
  await page.getByLabel('Chave de API (opcional)').fill('secret-key')
  await page.getByLabel('Usuário (alternativa à chave)').fill('operator')
  await page.getByLabel('Senha', { exact: true }).fill('secret-password')
  await page
    .getByRole('button', { name: 'Preparar Klipper / Moonraker' })
    .click()
  await expect(page.getByRole('alert')).toHaveText(
    'Informe uma origem HTTP(S), sem credenciais, caminho, consulta ou fragmento. A chave opcional aceita até 256 letras, números, sublinhados ou hífens.',
  )
  await expect(page.locator('main')).not.toContainText('secret-key')
  await expect(page.locator('main')).not.toContainText('secret-password')
  await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute(
    'type',
    'password',
  )
  await page.reload()
  await mountForms(page, null)
  await page
    .getByLabel('Família da impressora')
    .selectOption('klipper-moonraker')
  await page
    .getByLabel('Origem HTTP(S) do Moonraker')
    .fill('http://192.168.1.20:7125')
  await page.getByLabel('Chave de API (opcional)').fill('secret-key')
  await page.getByLabel('Usuário (alternativa à chave)').clear()
  await page.getByLabel('Senha', { exact: true }).clear()
  await page
    .getByRole('button', { name: 'Preparar Klipper / Moonraker' })
    .click()
  await expect(page.getByRole('alert')).toHaveText(
    'Configuração não disponível neste Connector.',
  )
  await page.getByLabel('Chave de API (opcional)').clear()
  await page.getByLabel('Usuário (alternativa à chave)').fill('operator')
  await page.getByLabel('Senha', { exact: true }).fill('secret-password')
  await page
    .getByRole('button', { name: 'Preparar Klipper / Moonraker' })
    .click()
  await expect(page.getByRole('alert')).toHaveText(
    'Configuração não disponível neste Connector.',
  )
})

test('discovery selection and probe prefill the form and keyboard can select', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Procurar impressoras' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Selecionar Bambu' }).click()
  await expect(
    page.getByLabel('Endereço IPv4 da Bambu Lab na LAN'),
  ).toHaveValue('192.168.1.21')
  await expect(page.getByLabel('Número de série')).toHaveValue('ABC123')
  await page.getByLabel('Endereço IPv4 da impressora').fill('192.168.1.22')
  await page.getByRole('button', { name: 'Identificar' }).click()
  await expect(page.getByLabel('Endereço IPv4 da Creality na LAN')).toHaveValue(
    '192.168.1.22',
  )
})
