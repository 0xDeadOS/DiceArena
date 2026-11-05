import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { craftDie, facePlay, masterFacetCost, masterFacetDie } from '@dicebound/game-core';
import type { DieDTO, HubDTO, InventoryResponse, SphereType } from '@dicebound/shared-types';
import { fixtureHub } from '../fixtures.js';
import { fixtureInventory } from '../inventory-fixtures.js';
import { authenticatedPage } from './helpers.js';
function changedDie(before: DieDTO, sphere: SphereType): DieDTO {
  const item = craftDie(before, sphere, () => 0);
  return {
    ...before,
    ...item,
    contentVersion: item.contentVersion!,
    effectiveFaces: item.faces.map((f) => ({ ...f, value: facePlay(item, f.face).value })),
  };
}
function craft(hub: HubDTO, sphere: SphereType): InventoryResponse {
  const before = hub.inventory.dice[0]!;
  const after = changedDie(before, sphere);
  const next = {
    ...hub,
    player: { ...hub.player, inventoryRevision: hub.player.inventoryRevision + 1 },
    inventory: {
      ...hub.inventory,
      dice: [after, ...hub.inventory.dice.slice(1)],
      spheres: hub.inventory.spheres.map((s) =>
        s.type === sphere ? { ...s, amount: s.amount - 1 } : s,
      ),
    },
  };
  return {
    inventory: fixtureInventory(next),
    result: { type: 'CRAFT', dieId: before.id, sphere, before, after },
  };
}
function faceted(hub: HubDTO, face: number, action: 'STRIKE' | 'GUARD' | 'PIERCE' | 'HEAL') {
  const before = hub.inventory.dice[0]!;
  const item = masterFacetDie(before, face, action, () => 2);
  const after: DieDTO = {
    ...before,
    ...item,
    contentVersion: item.contentVersion!,
    effectiveFaces: item.faces.map((f) => ({ ...f, value: facePlay(item, f.face).value })),
    masterCrafted: true,
  };
  const cost = masterFacetCost(before.ilvl);
  const next = {
    ...hub,
    player: {
      ...hub.player,
      facetDust: hub.player.facetDust - cost,
      inventoryRevision: hub.player.inventoryRevision + 1,
    },
    inventory: { ...hub.inventory, dice: [after, ...hub.inventory.dice.slice(1)] },
  };
  return {
    cost,
    response: {
      inventory: fixtureInventory(next),
      result: {
        type: 'MASTER_FACET' as const,
        dieId: before.id,
        face,
        action,
        dust: cost,
        before,
        after,
      },
    },
  };
}
async function workshop(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Мастерская', exact: true }).click();
}

test('workshop preview shows six read-only recipes, no protected API or horizontal overflow', async ({
  page,
}) => {
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await workshop(page);
  await expect(page.locator('.recipe-card')).toHaveCount(6);
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('Мастерская · только просмотр')).toBeVisible();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('craft requires consent, spends one sphere and restores the saved result after reload', async ({
  page,
}) => {
  const raw = await authenticatedPage(page);
  let hub = fixtureHub();
  let crafts = 0;
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/workshop/craft', (route) => {
    crafts++;
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    expect(route.request().postDataJSON()).toEqual({
      dieId: hub.inventory.dice[0]!.id,
      expectedRevision: 0,
      sphere: 'CASTING',
      confirmed: true,
    });
    const response = craft(hub, 'CASTING');
    hub = response.inventory.hub;
    return route.fulfill({ json: response });
  });
  await workshop(page);
  await page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Цена: 1 сфера');
  expect(crafts).toBe(0);
  await page.keyboard.press('Escape');
  expect(crafts).toBe(0);
  await page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить и потратить 1 сферу', exact: true }).click();
  await expect(page.getByText('Результат уже сохранён')).toBeVisible();
  await expect(page.locator('.craft-score-change')).toContainText('59');
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toContainText('×2');
  await expect(page.locator('.workpiece .affix-list')).toContainText('Атака');
  await page.reload();
  await page.getByRole('button', { name: 'Мастерская', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toContainText('×2');
  expect(crafts).toBe(1);
});

test('a lost craft response repeats exact consent/nonce and reloads the newer canonical inventory', async ({
  page,
}) => {
  await authenticatedPage(page);
  let hub = fixtureHub();
  let receipt: InventoryResponse | null = null;
  const sent: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/workshop/craft', async (route) => {
    sent.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (!receipt) {
      receipt = craft(hub, 'CASTING');
      hub = craft(receipt.inventory.hub, 'TEMPERING').inventory.hub;
      await route.abort('failed');
    } else await route.fulfill({ json: receipt });
  });
  await workshop(page);
  await page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить и потратить 1 сферу', exact: true }).click();
  await expect(page.getByText('Ответ не подтверждён')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Повторить запрос', exact: true }).click();
  await expect(page.getByText('Результат уже сохранён')).toBeVisible();
  await expect(page.locator('.workpiece .detail-stats')).toContainText('5%');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]!.key).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toContainText('×2');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('stale craft is not retried and committed protection disables all recipes', async ({
  page,
}) => {
  await authenticatedPage(page);
  let hub = fixtureHub();
  let calls = 0;
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/workshop/craft', (route) => {
    calls++;
    hub = {
      ...hub,
      player: { ...hub.player, inventoryRevision: 1 },
      inventory: {
        ...hub.inventory,
        dice: hub.inventory.dice.map((d) => ({ ...d, isLocked: true })),
      },
    };
    return route.fulfill({
      status: 409,
      json: {
        error: { code: 'STALE_INVENTORY', message: 'Инвентарь изменился.', requestId: 'test' },
      },
    });
  });
  await workshop(page);
  await page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить и потратить 1 сферу', exact: true }).click();
  await expect(page.locator('.workshop-locked')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Инвентарь обновлён');
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toBeDisabled();
  expect(calls).toBe(1);
});

test('equip/lock/unlock/dismantle are server-owned; Telegram Back cancels destructive consent', async ({
  page,
}) => {
  await authenticatedPage(page);
  let hub = fixtureHub();
  const item: DieDTO = {
    ...hub.inventory.dice[0]!,
    id: randomUUID(),
    baseType: 'IRON',
    isStarter: false,
    isEquipped: false,
    powerScore: 59,
  };
  item.effectiveFaces = item.faces.map((f) => ({ ...f, value: facePlay(item, f.face).value }));
  hub.inventory.dice.push(item);
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  let destroyed = 0;
  await page.route(/\/api\/inventory\/(equip|lock|dismantle)$/, (route) => {
    const body = route.request().postDataJSON();
    expect(body.expectedRevision).toBe(hub.player.inventoryRevision);
    hub = structuredClone(hub);
    hub.player.inventoryRevision++;
    const selected = hub.inventory.dice.find((d) => d.id === body.dieId)!;
    const path = route.request().url();
    let result: InventoryResponse['result'];
    if (path.endsWith('/equip')) {
      hub.player.equippedDieId = selected.id;
      hub.inventory.dice = hub.inventory.dice.map((d) => ({
        ...d,
        isEquipped: d.id === selected.id,
      }));
      result = { type: 'EQUIP', dieId: selected.id };
    } else if (path.endsWith('/lock')) {
      selected.isLocked = body.locked as boolean;
      result = { type: 'LOCK', dieId: selected.id };
    } else {
      expect(body.confirmed).toBe(true);
      destroyed++;
      hub.inventory.dice = hub.inventory.dice.filter((d) => d.id !== selected.id);
      hub.player.facetDust++;
      result = { type: 'DISMANTLE', dieId: selected.id, dust: 1 };
    }
    return route.fulfill({ json: { inventory: fixtureInventory(hub), result } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Инвентарь', exact: true }).click();
  await page.locator('.inventory-slot.filled').filter({ hasText: 'Железный кубик' }).click();
  await page.getByRole('button', { name: 'Защитить кубик', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Распылить кубик', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Экипировать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Уже в руке', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Снять защиту', exact: true }).click();
  await page.locator('.inventory-slot.filled').filter({ hasText: 'Костяной кубик' }).click();
  await page.getByRole('button', { name: 'Экипировать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Распылить кубик', exact: true })).toBeDisabled();
  await page.locator('.inventory-slot.filled').filter({ hasText: 'Железный кубик' }).click();
  await page.getByRole('button', { name: 'Распылить кубик', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { __testBack?: () => void }).__testBack?.();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Сумка искателя' })).toBeVisible();
  expect(destroyed).toBe(0);
  await page.getByRole('button', { name: 'Распылить кубик', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить распыление', exact: true }).click();
  await expect(page.locator('.inventory-slot.filled')).toHaveCount(1);
  expect(destroyed).toBe(1);
  await page.getByRole('button', { name: 'Сферы', exact: true }).click();
  await expect(page.getByText('1 пыли граней', { exact: true })).toBeVisible();
});

test('cleansing warns before losing affixes and preserves faces and quality', async ({ page }) => {
  await authenticatedPage(page);
  let hub = fixtureHub();
  let die = changedDie({ ...hub.inventory.dice[0]!, quality: 15 }, 'CASTING');
  die = changedDie(die, 'ASCENDANCE');
  hub.inventory.dice = [die];
  hub.inventory.spheres = hub.inventory.spheres.map((s) =>
    s.type === 'CLEANSING' ? { ...s, amount: 1 } : s,
  );
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/workshop/craft', (route) => {
    expect(route.request().postDataJSON().sphere).toBe('CLEANSING');
    const response = craft(hub, 'CLEANSING');
    hub = response.inventory.hub;
    return route.fulfill({ json: response });
  });
  await workshop(page);
  await page.getByRole('button', { name: 'Применить: Сфера Очищения', exact: true }).click();
  await expect(page.locator('.craft-warning')).toContainText('Отмена после выполнения невозможна');
  await page.getByRole('button', { name: 'Подтвердить и потратить 1 сферу', exact: true }).click();
  await expect(page.getByText('Результат уже сохранён')).toBeVisible();
  await expect(page.locator('.workpiece .detail-stats')).toContainText('15%');
  await expect(page.locator('.workpiece .no-affixes')).toContainText('без аффиксов');
  expect(hub.inventory.dice[0]!.faces).toEqual(die.faces);
});

test('failed policy reads cannot enable a craft from stale hub data', async ({ page }) => {
  await authenticatedPage(page);
  let reads = 0;
  await page.route('**/api/inventory', (route) =>
    ++reads === 1
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: 'UNAVAILABLE', message: 'Нет связи с Мастерской.', requestId: 'test' },
          },
        })
      : route.fulfill({ json: fixtureInventory() }),
  );
  await workshop(page);
  await expect(page.getByRole('alert')).toContainText('Нет связи');
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Обновить инвентарь', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Отливки', exact: true }),
  ).toBeEnabled();
});

test('active-run protection and quality cap are visible before confirmation', async ({ page }) => {
  await authenticatedPage(page);
  const hub = fixtureHub();
  hub.inventory.dice[0]!.quality = 20;
  await page.route('**/api/inventory', (route) =>
    route.fulfill({ json: fixtureInventory(hub, hub.inventory.dice[0]!.id) }),
  );
  await workshop(page);
  await expect(page.locator('.inventory-run-note')).toContainText('сохранённый снимок');
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Закалки', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Применить: Сфера Закалки', exact: true }),
  ).toContainText('20%');
});

test('master faceting needs dust, keeps the choice server-sided and saves one paid cut', async ({
  page,
}) => {
  const raw = await authenticatedPage(page);
  const poor = fixtureHub();
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(poor) }));
  await workshop(page);
  await expect(page.locator('.facet-panel')).toContainText('Мастер граней');
  await expect(page.locator('.facet-panel .facet-blocked')).toContainText('Нужно 5 пыли');
  await expect(page.getByRole('button', { name: /Огранить грань/ })).toBeDisabled();
  await page.locator('.facet-face').first().click();
  await expect(page.getByRole('button', { name: /Огранить грань/ })).toBeDisabled();

  let hub = { ...poor, player: { ...poor.player, facetDust: 12 } };
  const sent: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/inventory', (route) => route.fulfill({ json: fixtureInventory(hub) }));
  await page.route('**/api/workshop/master-facet', (route) => {
    sent.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    const { response } = faceted(hub, 4, 'PIERCE');
    hub = response.inventory.hub;
    return route.fulfill({ json: response });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Мастерская', exact: true }).click();
  await expect(page.locator('.facet-panel')).toContainText('12');
  await expect(page.getByRole('button', { name: /Огранить грань/ })).toBeDisabled();
  await page.locator('.facet-face').nth(3).click();
  await expect(page.getByRole('button', { name: 'Огранить грань 4', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Укол', exact: true }).last().click();
  await page.getByRole('button', { name: 'Огранить грань 4', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Цена: 5 пыли');
  await expect(page.getByRole('dialog')).toContainText('12 → 7');
  await expect(page.getByRole('dialog')).toContainText('Базовое значение определит сервер');
  expect(sent).toHaveLength(0);
  await page.keyboard.press('Escape');
  expect(sent).toHaveLength(0);
  await page.getByRole('button', { name: 'Огранить грань 4', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить и потратить 5 пыли', exact: true }).click();
  await expect(page.getByText('Огранка сохранена')).toBeVisible();
  await expect(page.locator('.craft-result')).toContainText(
    'Мастер огранел грань 4: Укол за 5 пыли',
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({
    dieId: poor.inventory.dice[0]!.id,
    expectedRevision: 0,
    face: 4,
    action: 'PIERCE',
    confirmed: true,
  });
  expect(sent[0]!.key).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  await expect(page.locator('.workshop-intro')).toContainText('7');
  await expect(page.locator('.workpiece .detail-stats')).toContainText('Да');
  await page.reload();
  await page.getByRole('button', { name: 'Мастерская', exact: true }).click();
  await expect(page.locator('.workshop-intro')).toContainText('7');
  expect(sent).toHaveLength(1);
});

test('locked dice and demo preview cannot start a faceting request', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(r.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Мастерская', exact: true }).click();
  await expect(page.locator('.facet-panel')).toContainText('только для просмотра');
  await expect(page.getByRole('button', { name: /Огранить грань/ })).toBeDisabled();
  await page.locator('.facet-face').first().click();
  await expect(page.getByRole('button', { name: /Огранить грань/ })).toBeDisabled();
  expect(calls.filter((url) => url.includes('master-facet'))).toHaveLength(0);

  await authenticatedPage(page);
  const hub = fixtureHub();
  const locked = {
    ...hub,
    inventory: {
      ...hub.inventory,
      dice: hub.inventory.dice.map((d, i) => (i === 0 ? { ...d, isLocked: true } : d)),
    },
    player: { ...hub.player, facetDust: 40 },
  };
  await page.route('**/api/inventory', (route) =>
    route.fulfill({ json: fixtureInventory(locked) }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Мастерская', exact: true }).click();
  await expect(page.locator('.facet-panel .facet-blocked')).toContainText('защит');
  await expect(page.getByRole('button', { name: /Огранить грань/ })).toBeDisabled();
});
