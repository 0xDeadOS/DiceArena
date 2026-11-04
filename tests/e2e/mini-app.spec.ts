import { test, expect } from '@playwright/test';
import { telegramLaunch } from './helpers.js';
import { fixtureHub } from '../fixtures.js';

test('browser preview is explicit and never calls protected API', async ({ page }) => {
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) calls.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'У костра' })).toBeVisible();
  await expect(page.getByText('Демонстрационные данные · прогресс не сохраняется')).toBeVisible();
  await expect(page.getByText('150', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Как играть', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Бросок сохраняется на сервере.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('inventory inspects opposing faces without a pretend combat roll', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Осмотреть снаряжение' }).click();
  await expect(page.getByRole('heading', { name: 'Сумка искателя' })).toBeVisible();
  await expect(page.locator('.inventory-slot')).toHaveCount(12);
  await expect(page.locator('.inventory-slot.filled')).toHaveCount(1);
  const guard = page.getByRole('button', { name: 'Грань 2: Щит 5' });
  await guard.click();
  await expect(guard).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pair-preview')).toContainText('Грань 5');
  await expect(page.locator('.pair-preview')).toContainText('Исцеление 3');
  await expect(page.getByText('Ваш первый кубик защищён от распыления.')).toBeVisible();
});

test('all six v2 spheres have accessible descriptions and no spend action', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Сферы', exact: true }).click();
  await expect(page.locator('.wallet-card')).toHaveCount(6);
  await page.getByRole('button', { name: /Сфера Возвышения/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/В КОШЕЛЬКЕ 0/)).toBeVisible();
  await expect(page.getByText(/Сейчас ресурсы не расходуются/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Сфера Возвышения/ })).toBeFocused();
});

test('Telegram mode sends raw initData in the header and refreshes real server data', async ({
  page,
}) => {
  const raw = await telegramLaunch(page);
  const hub = fixtureHub();
  let sessionCalls = 0;
  await page.route('**/api/auth/session', async (route) => {
    sessionCalls++;
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    expect(route.request().postDataJSON()).toEqual({});
    await route.fulfill({ json: { hub, authExpiresAt: '2026-11-05T12:00:00Z' } });
  });
  await page.route('**/api/hub', async (route) => {
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    await route.fulfill({ json: { ...hub, player: { ...hub.player, gold: 151 } } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'У костра' })).toBeVisible();
  await expect(page.getByText('Демонстрационные данные · прогресс не сохраняется')).toHaveCount(0);
  await page.getByRole('button', { name: 'Обновить хаб' }).click();
  await expect(page.getByText('151', { exact: true })).toBeVisible();
  expect(sessionCalls).toBe(1); // React StrictMode must not duplicate authorization.
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('denied Telegram login fails visibly, with no silent fallback to a fake profile', async ({
  page,
}) => {
  await telegramLaunch(page);
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: 'NOT_A_ROOM_MEMBER',
          message: 'Нет доступа к этой Обители.',
          requestId: 'test',
        },
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveText('Нет доступа к этой Обители.');
  await expect(page.getByRole('heading', { name: 'У костра' })).toHaveCount(0);
  await expect(page.getByText('Демонстрационные данные · прогресс не сохраняется')).toHaveCount(0);
  await page.getByRole('button', { name: 'Посмотреть интерфейс без входа' }).click();
  await expect(page.getByText('Демонстрационные данные · прогресс не сохраняется')).toBeVisible();
});

test('hub fits narrow and wide viewports without horizontal scrolling', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'У костра' })).toBeVisible();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.width);
  }
});
