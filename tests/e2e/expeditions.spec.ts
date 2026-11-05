import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { HubDTO, InventoryResponse, RunDTO } from '@dicebound/shared-types';
import { fixtureHub } from '../fixtures.js';
import { fixtureInventory } from '../inventory-fixtures.js';
import { fixtureRun } from '../game-fixtures.js';
import { authenticatedPage } from './helpers.js';

function tutorialHub(step: 'TRAINING' | 'REWARD' | 'CRAFT' | 'COMPLETE' | 'DONE'): HubDTO {
  const base = fixtureHub();
  const flags = {
    TRAINING: { trainingWon: false, crafted: false, rewardClaimed: false },
    REWARD: { trainingWon: true, crafted: false, rewardClaimed: false },
    CRAFT: { trainingWon: true, crafted: true, rewardClaimed: true },
    COMPLETE: { trainingWon: true, crafted: true, rewardClaimed: true },
    DONE: { trainingWon: true, crafted: true, rewardClaimed: true },
  }[step];
  return {
    ...base,
    player: {
      ...base.player,
      tutorialDone: step === 'DONE',
      highestExpeditionLevel: step === 'DONE' ? 2 : 0,
      tutorial: { ...flags, step },
    },
  };
}
function dropHub(): HubDTO {
  const hub = tutorialHub('DONE');
  const template = hub.inventory.dice[0]!;
  return {
    ...hub,
    player: { ...hub.player, inventoryRevision: 1 },
    inventory: {
      ...hub.inventory,
      pendingDrops: [
        {
          id: 'drop-1',
          runId: 'run-1',
          dust: 1,
          take: { allowed: false, reason: 'В сумке нет свободного слота.' },
          item: { ...template, id: 'drop-die', isStarter: false, isEquipped: false },
        },
      ],
    },
  };
}
async function expeditions(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
}

test('guided onboarding walks all four verified steps and unlocks ordinary runs', async ({
  page,
}) => {
  let hub = tutorialHub('REWARD');
  const raw = await authenticatedPage(page, hub);
  const bodies: unknown[] = [];
  await page.route('**/api/map/current', (route) => route.fulfill({ json: { run: null } }));
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/tutorial/reward', (route) => {
    bodies.push(route.request().postDataJSON());
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    const next = tutorialHub('COMPLETE');
    hub = {
      ...next,
      player: { ...next.player, inventoryRevision: 1 },
      inventory: {
        ...next.inventory,
        spheres: next.inventory.spheres.map((s) =>
          s.type === 'CASTING' ? { ...s, amount: s.amount + 1 } : s,
        ),
      },
    };
    return route.fulfill({
      json: {
        inventory: fixtureInventory(hub),
        result: { type: 'TUTORIAL_REWARD', sphere: 'CASTING', amount: 1 },
      } satisfies InventoryResponse,
    });
  });
  await page.route('**/api/tutorial/complete', (route) => {
    bodies.push(route.request().postDataJSON());
    const next = tutorialHub('DONE');
    hub = { ...next, player: { ...next.player, inventoryRevision: 2 } };
    return route.fulfill({
      json: {
        inventory: fixtureInventory(hub),
        result: { type: 'TUTORIAL_COMPLETE' },
      } satisfies InventoryResponse,
    });
  });
  await page.route('**/api/hub', (route) => route.fulfill({ json: hub }));
  await expeditions(page);
  await expect(page.locator('.tutorial-card')).toBeVisible();
  await expect(page.locator('.tutorial-steps li')).toHaveCount(4);
  await expect(page.locator('.tutorial-steps li.done')).toHaveCount(1);
  await expect(page.locator('.normal-expedition')).toHaveCount(0);
  await expect(
    page.locator('.tutorial-card').getByRole('button', { name: 'Забрать сферу', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Забрать сферу', exact: true }).click();
  await expect(page.getByText('Учебная Отливка получена: +1 сфера.')).toBeVisible();
  await expect(page.locator('.tutorial-steps li.done')).toHaveCount(3);
  await page.getByRole('button', { name: 'Завершить обучение', exact: true }).click();
  await expect(page.getByText('Обучение завершено. Обычные экспедиции открыты.')).toBeVisible();
  await expect(page.locator('.tutorial-card')).toHaveCount(0);
  await expect(page.locator('.normal-expedition')).toBeVisible();
  expect(bodies).toEqual([
    { expectedRevision: 0, confirmed: true },
    { expectedRevision: 1, confirmed: true },
  ]);
});

test('ordinary expedition confirms the vigor price and blocks while trophies wait', async ({
  page,
}) => {
  let hub = tutorialHub('DONE');
  const raw = await authenticatedPage(page, hub);
  let started = 0;
  await page.route('**/api/map/current', (route) => route.fulfill({ json: { run: null } }));
  await page.route('**/api/hub', (route) => route.fulfill({ json: hub }));
  await page.route('**/api/expedition/start', (route) => {
    started++;
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    expect(route.request().postDataJSON()).toEqual({
      level: 2,
      expectedInventoryRevision: 0,
      confirmed: true,
    });
    const run: RunDTO = { ...fixtureRun(), mode: 'EXPEDITION', level: 2 };
    hub = { ...hub, player: { ...hub.player, vigor: { ...hub.player.vigor, current: 2 } } };
    return route.fulfill({ json: { run } });
  });
  await expeditions(page);
  await expect(page.locator('.tutorial-card')).toHaveCount(0);
  await expect(page.locator('.normal-expedition')).toBeVisible();
  await expect(page.locator('.level-chip')).toHaveCount(3);
  await page.locator('.level-chip').nth(1).click();
  await expect(page.getByText('Стоимость: 1 бодрость из 3.')).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить спуск', exact: true }).click();
  await expect(page.locator('.run-summary')).toContainText('Экспедиция · уровень 2');
  expect(started).toBe(1);
  await expect(page.locator('.run-summary')).toContainText('сфер');
});

test('full bag keeps the trophy and offers an explicit salvage', async ({ page }) => {
  let hub = dropHub();
  const raw = await authenticatedPage(page, hub);
  const actions: unknown[] = [];
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/inventory/claim', (route) => {
    const body = route.request().postDataJSON();
    actions.push(body);
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    hub = {
      ...hub,
      player: { ...hub.player, inventoryRevision: 2, facetDust: hub.player.facetDust + 1 },
      inventory: { ...hub.inventory, pendingDrops: [] },
    };
    return route.fulfill({
      json: {
        inventory: fixtureInventory(hub),
        result: { type: 'SALVAGE_DROP', dieId: 'drop-1', dust: 1 },
      } satisfies InventoryResponse,
    });
  });
  await page.route('**/api/hub', (route) => route.fulfill({ json: hub }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Инвентарь', exact: true }).click();
  await expect(page.locator('.pending-drop')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'В сумку', exact: true })).toBeDisabled();
  await expect(page.getByText('В сумке нет свободного слота.')).toBeVisible();
  await page.getByRole('button', { name: 'Распылить', exact: true }).click();
  await expect(page.getByText('Без подтверждения трофей остаётся в списке')).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить распыление', exact: true }).click();
  await expect(page.locator('.pending-drop')).toHaveCount(0);
  expect(actions).toEqual([
    { dropId: 'drop-1', expectedRevision: 1, action: 'DUST', confirmed: true },
  ]);
});

test('preview mode shows onboarding read-only without protected calls', async ({ page }) => {
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) calls.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await expeditions(page);
  await expect(page.locator('.normal-expedition')).toBeVisible();
  await expect(page.locator('.level-chip')).toHaveCount(3);
  await expect(page.locator('.level-chip').first()).toBeDisabled();
  await expect(page.getByText('Пример боя · только просмотр')).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
});
