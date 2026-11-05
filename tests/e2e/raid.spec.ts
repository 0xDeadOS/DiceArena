import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { HubDTO, LeaderboardDTO, RaidDTO } from '@dicebound/shared-types';
import { fixtureHub, fixtureLeaderboard, fixtureRaid } from '../fixtures.js';
import { authenticatedPage } from './helpers.js';

/** Экран рейда живёт только в Telegram-режиме, поэтому каждый тест входит через launch-параметры. */
async function raidPage(
  page: Page,
  overrides: { raid?: RaidDTO; leaderboard?: LeaderboardDTO; hub?: HubDTO } = {},
) {
  const hub = overrides.hub ?? fixtureHub();
  await authenticatedPage(page, hub);
  await page.route('**/api/raid', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: overrides.raid ?? fixtureRaid() })
      : route.fulfill({ json: overrides.raid ?? fixtureRaid() }),
  );
  await page.route('**/api/leaderboard', (route) =>
    route.fulfill({ json: overrides.leaderboard ?? fixtureLeaderboard() }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: /Рейд Обители/i })
    .first()
    .click();
  // Алтарь виден и до призыва, и после, поэтому ждём именно его.
  await expect(page.getByRole('heading', { name: /Алтарь печати/i })).toBeVisible();
}

test.describe('Рейд Обители', () => {
  test('показывает алтарь, лестницу раундов и вклад Обители', async ({ page }) => {
    await raidPage(page);
    await expect(page.getByRole('heading', { name: /Алтарь печати/i })).toBeVisible();
    await expect(page.getByText(/В алтаре 15 из 15/)).toBeVisible();
    await expect(page.getByText(/Личные фрагменты:/)).toBeVisible();
    // Шесть раундов, первый уже пройден.
    await expect(page.locator('.round-node')).toHaveCount(6);
    await expect(page.locator('.round-node.cleared')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: /Вклад Обители/i })).toBeVisible();
    await expect(page.locator('.contribution-list .name')).toHaveText('Алиса');
    await expect(page.locator('.contribution-list .damage')).toContainText('6');
  });

  test('даёт разыграть открытый удар и отправить решение', async ({ page }) => {
    const raid = fixtureRaid();
    await raidPage(page, { raid });
    await expect(page.getByText(/Удар по раунду 2/)).toBeVisible();
    await expect(page.getByText(/выпало 4/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Атака · 9$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Стойка · Щит · 5/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Переброс \(1\)/ })).toBeVisible();
    let sent: unknown = null;
    await page.route('**/api/raid/decide', (route) => {
      sent = route.request().postDataJSON();
      void route.fulfill({ json: raid });
    });
    await page.getByRole('button', { name: /^Атака · 9$/ }).click();
    await expect.poll(() => (sent as { action?: string } | null)?.action).toBe('DIRECT');
    expect(sent).toMatchObject({ raidId: raid.raid!.id, attackId: raid.raid!.attack!.id });
  });

  test('призыв рейда требует явного подтверждения', async ({ page }) => {
    // Алтарь полон, активного рейда нет — кнопка призыва доступна.
    const raid: RaidDTO = {
      ...fixtureRaid(),
      raid: null,
      canAttack: { allowed: false, reason: null },
      canSummon: { allowed: true, reason: null },
    };
    await raidPage(page, { raid });
    const summon = page.getByRole('button', { name: /Призвать рейд/ });
    await expect(summon).toBeVisible();
    let calls = 0;
    await page.route('**/api/raid/summon', (route) => {
      calls += 1;
      void route.fulfill({ json: raid });
    });
    await summon.click();
    await expect(page.getByRole('button', { name: /Подтвердите призыв/ })).toBeVisible();
    expect(calls).toBe(0);
    await page.getByRole('button', { name: /Подтвердите призыв/ }).click();
    await expect.poll(() => calls).toBe(1);
  });

  test('показывает причину блокировки удара и не даёт бить без рогов', async ({ page }) => {
    const base = fixtureRaid();
    const raid: RaidDTO = {
      ...base,
      hornsLeft: 0,
      raid: { ...base.raid!, attack: null },
      canAttack: { allowed: false, reason: 'Сегодня рога уже потрачены.' },
    };
    await raidPage(page, { raid });
    await expect(page.getByText('Сегодня рога уже потрачены.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Ударить рогом/ })).toBeDisabled();
  });

  test('зал славы показывает зачётное окно и лучшие кубики', async ({ page }) => {
    await raidPage(page);
    await page.getByRole('button', { name: /Зал славы/ }).click();
    await expect(page.getByRole('heading', { name: /Зал славы Обители/i })).toBeVisible();
    await expect(page.getByText(/Зачётное окно — 7 дней/)).toBeVisible();
    await expect(page.locator('.hall-list .owner')).toHaveText('Алиса');
    await expect(page.locator('.hall-list .ps')).toContainText('PS');
  });

  test('пустой зал славы объясняет, как в него попасть', async ({ page }) => {
    const empty: LeaderboardDTO = { ...fixtureLeaderboard(), entries: [] };
    await raidPage(page, { leaderboard: empty });
    await page.getByRole('button', { name: /Зал славы/ }).click();
    await expect(page.getByText(/Пока никто не отметился/)).toBeVisible();
  });

  test('показывает ошибку сервера и предлагает повторить', async ({ page }) => {
    const hub = fixtureHub();
    await authenticatedPage(page, hub);
    await page.route('**/api/raid', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 409,
            json: { error: { code: 'STALE_RAID', message: 'Рейд изменился.' } },
          })
        : route.fulfill({ json: fixtureRaid() }),
    );
    await page.route('**/api/leaderboard', (route) =>
      route.fulfill({ json: fixtureLeaderboard() }),
    );
    await page.goto('/');
    await page
      .getByRole('button', { name: /Рейд Обители/i })
      .first()
      .click();
    await expect(page.locator('.raid-warning')).toContainText('Рейд изменился.');
  });
});
