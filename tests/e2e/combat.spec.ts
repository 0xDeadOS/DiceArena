import { test, expect } from '@playwright/test';
import { combatOptions, decideCombat, rollCombat } from '@dicebound/game-core';
import type { BattleDecision, CombatState, RunDTO } from '@dicebound/shared-types';
import { fixtureRun } from '../game-fixtures.js';
import { fixtureHub } from '../fixtures.js';
import { authenticatedPage } from './helpers.js';

test('training preview is explicitly read-only, makes no API calls and fits all screen sizes', async ({
  page,
}) => {
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await expect(page.getByText('Пример боя · только просмотр')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Гоблин-копейщик' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Разыграть/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Перебросить/ })).toBeDisabled();
  await expect(page.locator('.map-node')).toHaveCount(13);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
});

test('reopening resumes the saved face and never triggers another roll', async ({ page }) => {
  const raw = await authenticatedPage(page);
  let loads = 0;
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && !r.url().endsWith('/auth/session')) posts.push(r.url());
  });
  await page.route('**/api/map/current', (route) => {
    loads++;
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    return route.fulfill({ json: { run: fixtureRun() } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Грань 4');
  await expect(page.getByRole('button', { name: /^Перевернуть/ })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Грань 4');
  expect(loads).toBe(2);
  expect(posts).toEqual([]);
});

test('a lost roll response retries the original nonce/body and restores canonical state', async ({
  page,
}) => {
  const raw = await authenticatedPage(page);
  let server = fixtureRun(false);
  const requests: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/map/current', (route) => route.fulfill({ json: { run: server } }));
  await page.route('**/api/battle/roll', async (route) => {
    expect(route.request().headers().authorization).toBe(`tma ${raw}`);
    requests.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    server = fixtureRun();
    if (requests.length === 1) await route.abort('failed');
    else await route.fulfill({ json: { run: server } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await page.getByRole('button', { name: 'Бросить кубик', exact: true }).click();
  await expect(page.getByText('Есть неподтверждённое действие')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Бросить кубик', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Повторить запрос', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Грань 4');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]!.key).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(requests[0]!.body).toEqual({
    runId: server.id,
    battleId: server.battle!.id,
    expectedRevision: 1,
  });
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('start, adjacent step, roll, reroll and committing flip use server-provided options', async ({
  page,
}) => {
  await authenticatedPage(page);
  let server: RunDTO | null = null;
  let rolls = 0;
  await page.route('**/api/map/current', (route) => route.fulfill({ json: { run: server } }));
  await page.route('**/api/map/start', (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    server = {
      ...fixtureRun(false),
      revision: 0,
      currentNodeId: 'start',
      visitedNodeIds: ['start'],
      availableNodeIds: ['f1-0'],
      battle: null,
    };
    return route.fulfill({ json: { run: server } });
  });
  await page.route('**/api/map/step', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      runId: server!.id,
      expectedRevision: 0,
      nodeId: 'f1-0',
    });
    server = fixtureRun(false);
    return route.fulfill({ json: { run: server } });
  });
  const apply = (state: CombatState) => {
    server = {
      ...server!,
      revision: server!.revision + 1,
      playerHp: state.playerHp,
      battle: {
        id: server!.battle!.id,
        ...state,
        enemyName: server!.battle!.enemyName,
        options: combatOptions(state, server!.loadout),
      },
    };
  };
  await page.route('**/api/battle/roll', (route) => {
    const body = route.request().postDataJSON();
    expect(body.expectedRevision).toBe(server!.revision);
    expect(Object.keys(body).sort()).toEqual(['battleId', 'expectedRevision', 'runId']);
    apply(rollCombat(server!.battle!, ++rolls === 1 ? 4 : 1));
    return route.fulfill({ json: { run: server } });
  });
  const actions: string[] = [];
  await page.route('**/api/battle/decision', (route) => {
    const body = route.request().postDataJSON();
    expect(body.expectedRevision).toBe(server!.revision);
    actions.push(body.action as string);
    apply(decideCombat(server!.battle!, server!.loadout, body.action as BattleDecision, 6));
    return route.fulfill({ json: { run: server } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await page.getByRole('button', { name: 'Начать тренировку', exact: true }).click();
  await page.getByRole('button', { name: 'Дальше: Бой', exact: false }).click();
  await page.getByRole('button', { name: 'Бросить кубик', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Грань 4');
  await page.getByRole('button', { name: /^Перебросить/ }).click();
  await expect(page.getByRole('status')).toContainText('Грань 6');
  await expect(page.getByRole('button', { name: /^Перебросить/ })).toBeDisabled();
  await page.getByRole('button', { name: /^Разыграть/ }).click();
  await page.getByRole('button', { name: 'Бросить кубик', exact: true }).click();
  await page.getByRole('button', { name: /^Перевернуть/ }).click();
  await expect(page.getByRole('button', { name: 'Бросить кубик', exact: true })).toBeVisible();
  await expect(page.locator('.battle-resources')).toContainText('0 / 3');
  expect(actions).toEqual(['REROLL', 'DIRECT', 'FLIP']);
  expect(rolls).toBe(2);
});

test('a stale action loads the latest revision instead of replaying a second enemy turn', async ({
  page,
}) => {
  await authenticatedPage(page);
  let server = fixtureRun();
  let decisions = 0;
  await page.route('**/api/map/current', (route) => route.fulfill({ json: { run: server } }));
  await page.route('**/api/battle/decision', (route) => {
    decisions++;
    const state = decideCombat(server.battle!, server.loadout, 'DIRECT');
    server = {
      ...server,
      revision: 3,
      playerHp: state.playerHp,
      battle: { ...server.battle!, ...state, options: combatOptions(state, server.loadout) },
    };
    return route.fulfill({
      status: 409,
      json: { error: { code: 'STALE_STATE', message: 'Состояние изменилось.', requestId: 'test' } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await page.getByRole('button', { name: /^Разыграть/ }).click();
  await expect(page.getByRole('alert')).toContainText('Показано актуальное состояние');
  await expect(page.getByRole('button', { name: 'Бросить кубик', exact: true })).toBeEnabled();
  expect(decisions).toBe(1);
  await expect(page.getByRole('button', { name: 'Повторить запрос', exact: true })).toHaveCount(0);
});

test('retreat needs confirmation and displays the server-settled reward in the wallet', async ({
  page,
}) => {
  await authenticatedPage(page);
  let server = { ...fixtureRun(), loot: { gold: 11, dust: 3 } };
  let retreats = 0;
  await page.route('**/api/map/current', (route) => route.fulfill({ json: { run: server } }));
  await page.route('**/api/map/retreat', (route) => {
    retreats++;
    server = {
      ...server,
      revision: 3,
      status: 'DEFEAT',
      reward: { gold: 4, dust: 1 },
      battle: {
        ...server.battle!,
        state: 'FINISHED',
        outcome: 'DEFEAT',
        currentRolledFace: null,
        options: null,
      },
    };
    return route.fulfill({ json: { run: server } });
  });
  await page.route('**/api/hub', (route) =>
    route.fulfill({
      json: { ...fixtureHub(), player: { ...fixtureHub().player, gold: 154, facetDust: 1 } },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await page.getByRole('button', { name: 'Отступить в Обитель', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(retreats).toBe(0);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  expect(retreats).toBe(0);
  await page.getByRole('button', { name: 'Отступить в Обитель', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить отступление', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы снова у костра.' })).toBeVisible();
  await expect(page.getByText('+4 золота', { exact: true })).toBeVisible();
  expect(retreats).toBe(1);
  await page.getByRole('button', { name: 'Сферы', exact: true }).click();
  await expect(page.getByText('1 пыли граней', { exact: true })).toBeVisible();
});

test('a failed initial read never enables a fresh start on an unknown server state', async ({
  page,
}) => {
  await authenticatedPage(page);
  let calls = 0;
  await page.route('**/api/map/current', (route) =>
    ++calls === 1
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: 'UNAVAILABLE', message: 'Сервер недоступен.', requestId: 'test' },
          },
        })
      : route.fulfill({ json: { run: null } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Походы', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер недоступен.');
  await expect(page.getByRole('button', { name: 'Начать тренировку', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Обновить поход', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку', exact: true })).toBeEnabled();
});
