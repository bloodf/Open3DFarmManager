// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import { RAW_ERROR, rawFailure, visibleText } from '../page-harness'
import type { RegisterStates } from './types'

const TOKEN = 'A'.repeat(43)

type FormPage = {
  page: string
  endpoint: string
  fields: Record<string, string>
  submit: string
  /** Fixed pt-BR text shown when the server fails. */
  failure: RegExp
}

const forms: FormPage[] = [
  {
    page: 'entrar',
    endpoint: 'POST /api/auth/login',
    fields: { '#username': 'ana_01', '#password': 'senha-muito-longa-123' },
    submit: 'Entrar',
    failure: /Não foi possível entrar agora\. Tente novamente mais tarde\./,
  },
  {
    page: 'criar-conta',
    endpoint: 'POST /api/auth/register',
    fields: {
      '#account-token': TOKEN,
      '#account-username': 'ana_01',
      '#account-password': 'senha-muito-longa-123',
    },
    submit: 'Criar conta',
    failure: /Não foi possível criar a conta agora\./,
  },
  {
    page: 'primeiro-acesso',
    endpoint: 'POST /api/auth/bootstrap',
    fields: {
      '#account-token': TOKEN,
      '#account-username': 'ana_01',
      '#account-password': 'senha-muito-longa-123',
    },
    submit: 'Criar conta de proprietário',
    failure: /Não foi possível criar a conta agora\./,
  },
  {
    page: 'redefinir-senha',
    endpoint: 'POST /api/auth/password-reset-complete',
    fields: {
      '#reset-username': 'ana_01',
      '#reset-token': TOKEN,
      '#reset-password': 'senha-muito-longa-123',
    },
    submit: 'Redefinir senha',
    failure: /Não foi possível redefinir a senha\./,
  },
  {
    page: 'conta',
    endpoint: 'POST /api/auth/password',
    fields: {
      '#current-password': 'senha-antiga-123456',
      '#new-password': 'senha-muito-longa-123',
    },
    submit: 'Alterar senha',
    failure: /Não foi possível alterar a senha agora\./,
  },
]

const fill = async (page: Page, fields: Record<string, string>) => {
  for (const [selector, value] of Object.entries(fields))
    await page.fill(selector, value)
}
const noLoadingChrome = async (page: Page) => {
  expect(await page.locator('.skeleton, [aria-busy="true"]').count()).toBe(0)
  expect(await visibleText(page)).not.toMatch(RAW_ERROR)
}

export const register: RegisterStates = (harness) => {
  for (const form of forms) {
    describe(`${form.page} states`, () => {
      it(`${form.page}: loading`, async () => {
        const { page, close } = await harness().open(form.page, {
          [form.endpoint]: { hang: true },
        })
        try {
          const button = page.getByRole('button', { name: form.submit })
          await expect.poll(() => button.isEnabled()).toBe(true)
          await fill(page, form.fields)
          await button.click()
          await page.locator('form[aria-busy="true"]').waitFor()
          await expect
            .poll(() =>
              page.locator('form button[type="submit"]').first().isDisabled(),
            )
            .toBe(true)
          expect(await visibleText(page)).not.toMatch(RAW_ERROR)
        } finally {
          await close()
        }
      })

      it(`${form.page}: empty`, async () => {
        // n/a: a form lists nothing. It opens blank, with no alert and no skeleton.
        const { page, close } = await harness().open(form.page)
        try {
          await page.getByRole('button', { name: form.submit }).waitFor()
          for (const selector of Object.keys(form.fields))
            expect(await page.inputValue(selector)).toBe('')
          expect(
            (await page.locator('[role="alert"]').allInnerTexts())
              .join('')
              .trim(),
          ).toBe('')
          await noLoadingChrome(page)
        } finally {
          await close()
        }
      })

      it(`${form.page}: error`, async () => {
        const { page, close } = await harness().open(form.page, {
          [form.endpoint]: rawFailure(),
        })
        try {
          await expect
            .poll(() =>
              page.getByRole('button', { name: form.submit }).isEnabled(),
            )
            .toBe(true)
          await fill(page, form.fields)
          await page.getByRole('button', { name: form.submit }).click()
          const alert = page
            .getByRole('alert')
            .filter({ hasText: form.failure })
          // redefinir-senha reports through its live status region.
          const target =
            form.page === 'redefinir-senha'
              ? page.getByText(form.failure)
              : alert
          await target.first().waitFor()
          expect(await visibleText(page)).not.toMatch(RAW_ERROR)
        } finally {
          await close()
        }
      })

      it(`${form.page}: stale`, async () => {
        // n/a: no cached data. After a failure no secret from the failed attempt stays in a field.
        const { page, close } = await harness().open(form.page, {
          [form.endpoint]: rawFailure(),
        })
        try {
          await expect
            .poll(() =>
              page.getByRole('button', { name: form.submit }).isEnabled(),
            )
            .toBe(true)
          await fill(page, form.fields)
          await page.getByRole('button', { name: form.submit }).click()
          await page.getByText(form.failure).first().waitFor()
          for (const selector of Object.keys(form.fields))
            if (/password|senha/.test(selector))
              expect(await page.inputValue(selector)).toBe('')
          await expect
            .poll(() =>
              page.getByRole('button', { name: form.submit }).isEnabled(),
            )
            .toBe(true)
        } finally {
          await close()
        }
      })
    })
  }

  describe('sair states', () => {
    it('sair: loading', async () => {
      const { page, close } = await harness().open('sair', {
        'POST /api/auth/logout': { hang: true },
      })
      try {
        await page.getByRole('button', { name: 'Sair da conta' }).click()
        await page.locator('form[aria-busy="true"]').waitFor()
        await page.getByText('Encerrando sua sessão.').waitFor()
        await expect
          .poll(() =>
            page.getByRole('button', { name: 'Saindo…' }).isDisabled(),
          )
          .toBe(true)
      } finally {
        await close()
      }
    })
    it('sair: empty', async () => {
      // n/a: nothing to list; the page offers both exits and shows no alert text.
      const { page, close } = await harness().open('sair')
      try {
        await page.getByRole('button', { name: 'Sair da conta' }).waitFor()
        await page
          .getByRole('button', { name: 'Sair de todos os dispositivos' })
          .waitFor()
        expect(
          (await page.locator('[role="alert"]').allInnerTexts())
            .join('')
            .trim(),
        ).toBe('')
        await noLoadingChrome(page)
      } finally {
        await close()
      }
    })
    it('sair: error', async () => {
      const { page, close } = await harness().open('sair', {
        'POST /api/auth/logout': rawFailure(),
        'POST /api/auth/sessions/revoke': rawFailure(502),
      })
      try {
        await page.getByRole('button', { name: 'Sair da conta' }).click()
        await page
          .getByRole('alert')
          .filter({ hasText: 'Não foi possível sair agora.' })
          .waitFor()
        expect(await visibleText(page)).not.toMatch(RAW_ERROR)
        await page
          .getByRole('button', { name: 'Sair de todos os dispositivos' })
          .click()
        await page
          .getByRole('alert')
          .filter({ hasText: 'Não foi possível encerrar todas as sessões.' })
          .waitFor()
        expect(await visibleText(page)).not.toMatch(RAW_ERROR)
      } finally {
        await close()
      }
    })
    it('sair: stale', async () => {
      // A failed logout warns that the session may still be active, then allows a retry.
      const { page, close } = await harness().open('sair', {
        'POST /api/auth/logout': rawFailure(),
      })
      try {
        await page.getByRole('button', { name: 'Sair da conta' }).click()
        await page.getByText('Sua sessão pode continuar ativa.').waitFor()
        await expect
          .poll(() =>
            page.getByRole('button', { name: 'Sair da conta' }).isEnabled(),
          )
          .toBe(true)
      } finally {
        await close()
      }
    })
  })

  describe('index states', () => {
    // The home page is static: it fetches nothing, so every state is the same calm page.
    for (const state of ['loading', 'empty', 'error', 'stale'] as const)
      it(`index: ${state}`, async () => {
        const { page, calls, close } = await harness().open('index')
        try {
          await page
            .getByRole('heading', {
              name: 'Sua farm de impressão, em um só lugar.',
            })
            .waitFor()
          expect(calls('GET', '/api')).toBe(0)
          await page.getByText('Recursos ainda indisponíveis').waitFor()
          await noLoadingChrome(page)
        } finally {
          await close()
        }
      })
  })
}
