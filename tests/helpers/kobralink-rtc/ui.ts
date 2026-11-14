import { expect, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'

export const SYNTHETIC_IP = '172.30.78.3'
export const SYNTHETIC_DEVICE_ID = 'OPENFARM_SYNTHETIC_KOBRA_X_001'
export const TEXT = {
  kobraHeading: 'Adicionar Anycubic Kobra X',
  verify: 'Verificar capacidade do Connector',
  ip: 'Endereço IPv4 da Kobra X na LAN',
  nickname: 'Apelido local para identificação (opcional)',
  prepare: 'Preparar Anycubic Kobra X',
  commit: 'Confirmar e ativar Kobra X',
  reconcileHeading: 'Estado da operação não confirmado — reconciliação segura',
  reconcile: 'Consultar e reconciliar operação',
  cancelRemote: 'Solicitar cancelamento no Connector',
  cancelPrepared: 'Cancelar preparação',
  confirmedHeading:
    'Anycubic Kobra X confirmada e ativa em modo somente leitura',
  viewerNotice:
    'Somente proprietários e administradores podem cadastrar, adicionar uma Anycubic Kobra X ou revogar atribuições.',
  liveAuthenticated: 'Conexão direta autenticada',
  liveUnavailableLast:
    'Conexão direta indisponível. Exibindo a última observação.',
  idle: 'Ociosa',
  offline: 'Indisponível segundo o Connector',
  noState: 'Nenhum estado recebido',
  staleNotice: 'Dados desatualizados. A impressora pode ter mudado de estado.',
} as const

export type Stage =
  'form' | 'prepared' | 'reconcile' | 'recovery' | 'confirmed' | 'absent'

export function kobraSection(page: Page): Locator {
  return page.locator('section[aria-labelledby="kobra-x-heading"]')
}
export function kobraAlert(page: Page): Locator {
  return kobraSection(page).locator('p.kobra-alert')
}

/** Which onboarding card the real page currently renders. */
export async function currentStage(page: Page): Promise<Stage> {
  if (!(await kobraSection(page).count())) return 'absent'
  if (await page.locator('#kobra-confirmed-heading').count()) return 'confirmed'
  if (await page.locator('#kobra-recovery-heading').count()) return 'recovery'
  if (await page.locator('#kobra-reconcile-heading').count()) return 'reconcile'
  if (await page.locator('#kobra-prepared-heading').count()) return 'prepared'
  return 'form'
}

/** Waits until the page is idle in one of the stages (not busy). */
export async function settledStage(
  page: Page,
  timeoutMs = 30_000,
): Promise<Stage> {
  await expect(kobraSection(page)).toHaveAttribute('aria-busy', 'false', {
    timeout: timeoutMs,
  })
  return currentStage(page)
}

export async function openPrinters(page: Page, origin: string, farmId: string) {
  await page.goto(origin + '/impressoras')
  await page.getByLabel('Farm', { exact: true }).selectOption(farmId)
  await expect(page.locator('#assignment-heading')).toBeVisible()
}

export async function selectKobraContext(
  page: Page,
  agentId: string,
  keyId: string,
) {
  await page
    .getByLabel('Connector aprovado para a Kobra X')
    .selectOption(agentId)
  await page
    .getByLabel('Dispositivo aprovado deste navegador', { exact: true })
    .selectOption(keyId)
}

/** Accepted helper: repeat the real capability check until the form unlocks. */
export async function waitFormReady(page: Page, timeoutMs = 30_000) {
  await expect
    .poll(
      async () => {
        if (await page.getByLabel(TEXT.ip).isEnabled()) return true
        await page.getByRole('button', { name: TEXT.verify }).click()
        return expect(page.getByLabel(TEXT.ip))
          .toBeEnabled({ timeout: 3000 })
          .then(
            () => true,
            () => false,
          )
      },
      { timeout: timeoutMs, intervals: [500, 1000, 2000] },
    )
    .toBe(true)
}

export async function fillTarget(page: Page, ip: string, nickname: string) {
  await page.getByLabel(TEXT.ip).fill(ip)
  await page.getByLabel(TEXT.nickname).fill(nickname)
}

export async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).replace(/\s+/g, ' ').trim()
}

export async function alertText(page: Page): Promise<string> {
  const alert = kobraAlert(page)
  return (await alert.count())
    ? (await alert.innerText()).replace(/\s+/g, ' ').trim()
    : ''
}

export async function shot(page: Page, evidence: string, name: string) {
  await page.screenshot({ path: join(evidence, name), fullPage: true })
  return name
}

/** Horizontal overflow of the document or of any element inside `main`. */
export async function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const offenders: string[] = []
    for (const element of document.querySelectorAll('main *')) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.right > width + 1 || rect.left < -1)
        offenders.push(
          `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}`,
        )
      if (offenders.length >= 8) break
    }
    return {
      viewport: width,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    }
  })
}

/** Interactive controls inside `main` without an accessible name. */
export async function unlabelled(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const missing: string[] = []
    const text = (id: string) =>
      document.getElementById(id)?.textContent?.trim() ?? ''
    for (const element of document.querySelectorAll<HTMLElement>(
      'main input, main select, main textarea, main button, main a[href]',
    )) {
      const labels =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
          ? [...(element.labels ?? [])]
              .map((label) => label.textContent?.trim() ?? '')
              .join(' ')
          : ''
      const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map(text)
        .join(' ')
      const name =
        labels ||
        labelledBy ||
        (element.getAttribute('aria-label') ?? '').trim() ||
        (element instanceof HTMLButtonElement ||
        element instanceof HTMLAnchorElement
          ? (element.textContent ?? '').trim()
          : '')
      if (!name)
        missing.push(
          `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}`,
        )
    }
    return missing
  })
}

/** The focused element and whether the browser draws a visible focus ring. */
export async function focusState(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || element === document.body)
      return { id: '', tag: '', name: '', visible: false, keyboard: false }
    const style = getComputedStyle(element)
    const outline =
      style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1
    const shadow = style.boxShadow !== 'none' && style.boxShadow !== ''
    return {
      id: element.id,
      tag: element.tagName.toLowerCase(),
      name: (element.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60),
      visible: outline || shadow,
      keyboard: element.matches(':focus-visible'),
    }
  })
}

/**
 * Keyboard-only navigation: press Tab until `target` holds focus. Returns the
 * number of presses and whether every stop on the way drew a focus ring.
 */
export async function tabTo(page: Page, target: Locator, maxPresses = 80) {
  const invisible: string[] = []
  for (let presses = 0; presses <= maxPresses; presses++) {
    const focused = await target
      .evaluate((element) => element === document.activeElement)
      .catch(() => false)
    if (focused) {
      const state = await focusState(page)
      if (!state.visible || !state.keyboard)
        invisible.push(`${state.tag}#${state.id}`)
      return { reached: true, presses, invisible }
    }
    await page.keyboard.press('Tab')
    const state = await focusState(page)
    if (state.tag && (!state.visible || !state.keyboard))
      invisible.push(`${state.tag}#${state.id}`)
  }
  return { reached: false, presses: maxPresses, invisible }
}

export async function liveArticle(page: Page) {
  const articles = page.getByRole('article')
  return {
    count: await articles.count(),
    text: (await articles.count())
      ? (await articles.first().innerText()).replace(/\s+/g, ' ').trim()
      : '',
  }
}
