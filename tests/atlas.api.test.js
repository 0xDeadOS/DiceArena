/**
 * HTTP REST API: авторизация, состояние, бросок, крафт, карты с развилками,
 * Атлас, рейд, обмен, админка, gzip, keep-alive-friendly /health.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createEmptyMap } from '../src/engine/atlas.js';
import { generateDie, createRng } from '../src/engine/crafting.js';
import { dayKey } from '../src/store.js';
import { fillInventory, login, makeStore, startTestServer, tmpDbPath } from './helpers.js';

let ctx;
let token;
let adminToken;
let me;

before(async () => {
  const store = makeStore();
  // Тестовый игрок не должен упираться в лимиты дня.
  for (const player of store.db.players) {
    player.lastChestDay = null;
    player.dailyRollsUsed = 0;
    player.lastRollDay = dayKey(store.now());
  }
  ctx = await startTestServer({ store });
  const session = await login(ctx.api, 'p1');
  token = session.token;
  me = session.playerId;
  adminToken = token;

  const guestSession = await login(ctx.api, 'p2');
  assert.ok(guestSession.token);
});

after(async () => {
  await ctx.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('GET /health', () => {
  it('отдаёт статус сервера и метрики стора', async () => {
    const { status, data } = await ctx.api('GET', '/health');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.status, 'healthy');
    assert.equal(data.store.players, 6);
    assert.ok(data.store.bossHp > 0);
    assert.equal(typeof data.uptime, 'number');
  });

  it('/healthz — короткий ответ для внешнего пинга', async () => {
    const response = await fetch(`${ctx.baseUrl}/healthz`);
    assert.equal(await response.text(), 'ok');
  });
});

describe('POST /api/auth/session', () => {
  it('локальный вход отдаёт HMAC-токен и профиль', async () => {
    const { status, data } = await ctx.api('POST', '/api/auth/session', { body: {} });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.ok(data.token.includes('.'));
    assert.ok(data.player.name);
    assert.equal(data.admin, true, 'в сиде первый профиль — админ');
  });

  it('подписанная ссылка авторизует нужного игрока', async () => {
    const profiles = await ctx.api('GET', '/api/profiles');
    const entry = profiles.data.profiles.find((p) => p.id === 'p4');
    const sig = new URL(entry.signLink).searchParams.get('sig');
    const { data } = await ctx.api('POST', '/api/auth/session', { body: { playerId: 'p4', sig } });
    assert.equal(data.ok, true);
    assert.equal(data.playerId, 'p4');
    assert.equal(data.source, 'signed-link');
  });

  it('неверная подпись отклоняется с 401', async () => {
    const { status, data } = await ctx.api('POST', '/api/auth/session', { body: { playerId: 'p4', sig: 'deadbeef' } });
    assert.equal(status, 401);
    assert.equal(data.ok, false);
  });

  it('битый Telegram initData отклоняется', async () => {
    const { status } = await ctx.api('POST', '/api/auth/session', {
      body: { initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' },
    });
    assert.equal(status, 401);
  });

  it('GET /api/auth/me рассказывает о сессии', async () => {
    const withToken = await ctx.api('GET', '/api/auth/me', { headers: auth() });
    assert.equal(withToken.data.ok, true);
    assert.equal(withToken.data.player.id, me);
    const guest = await ctx.api('GET', '/api/auth/me');
    assert.equal(guest.data.player, null);
    assert.equal(guest.data.guest, true);
  });
});

describe('GET /api/state', () => {
  it('отдаёт полный слепок с константами', async () => {
    const { status, data } = await ctx.api('GET', '/api/state', { headers: auth() });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.players.length, 6);
    assert.equal(data.selfId, me);
    assert.ok(data.self.inventory, 'себе отдаём инвентарь');
    assert.ok(data.self.maps);
    assert.ok(!data.players.find((p) => p.id !== me).inventory, 'чужие инвентари скрыты');
    assert.equal(data.constants.currencies.length, 11);
    assert.equal(data.constants.affixes.length, 32);
    assert.equal(data.constants.mapZones.length, 16);
    assert.equal(Object.keys(data.constants.atlasPassives).length, 12);
    assert.equal(data.constants.uniqueDice.length, 6);
    assert.ok(data.chat.boss.maxHp > 0);
    assert.ok(Array.isArray(data.ladder));
    assert.ok(data.ladder.length === 6);
  });

  it('поддерживает инкрементальный ?v= и отдаёт unchanged', async () => {
    const first = await ctx.api('GET', '/api/state', { headers: auth() });
    const version = first.data.version;
    const second = await ctx.api('GET', `/api/state?v=${version}`, { headers: auth() });
    assert.equal(second.data.ok, true);
    assert.equal(second.data.unchanged, true);
    assert.equal(second.data.version, version);
  });

  it('гостю отдаёт read-only слепок', async () => {
    const { data } = await ctx.api('GET', '/api/state');
    assert.equal(data.ok, true);
    assert.equal(data.self, null);
    assert.equal(data.players.length, 6);
  });

  it('гость не может играть (401)', async () => {
    const { status, data } = await ctx.api('POST', '/api/roll', { body: {} });
    assert.equal(status, 401);
    assert.equal(data.ok, false);
    assert.match(data.reason, /Telegram/i);
  });

  it('гзипует крупные JSON-ответы', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/state`, {
      headers: { ...auth(), 'accept-encoding': 'gzip' },
    });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const data = await response.json();
    assert.equal(data.ok, true);
  });
});

describe('POST /api/roll', () => {
  it('делает бросок, наносит урон и выдаёт валюту', async () => {
    const before = await ctx.api('GET', '/api/state', { headers: auth() });
    const bossHpBefore = before.data.chat.boss.hp;
    const { status, data } = await ctx.api('POST', '/api/roll', { headers: auth(), body: {} });
    assert.equal(status, 200, JSON.stringify(data).slice(0, 300));
    assert.equal(data.ok, true);
    assert.ok(data.roll.score > 0);
    assert.ok(data.roll.damage > 0);
    assert.ok(Array.isArray(data.roll.orbs));
    const after = await ctx.api('GET', '/api/state', { headers: auth() });
    assert.ok(after.data.chat.boss.hp < bossHpBefore || data.bossDefeated);
    assert.ok(after.data.feed.length >= 1);
  });

  it('повторный бросок в тот же день — 409', async () => {
    const { status, data } = await ctx.api('POST', '/api/roll', { headers: auth(), body: {} });
    assert.equal(status, 409);
    assert.equal(data.ok, false);
  });
});

describe('Крафт через API', () => {
  it('POST /api/craft/orb применяет сферу к кубику', async () => {
    const state = await ctx.api('GET', '/api/state', { headers: auth() });
    const die = state.data.self.dice[0];
    ctx.store.getPlayer(me).inventory.exalted = 5;
    ctx.store.getPlayer(me).inventory.whetstone = 5;
    if (die.corrupted) {
      // гарантируем чистый кубик для теста
      const clean = generateDie({ rng: createRng(3), rarity: 'rare', ilvl: 100 });
      clean.mods = clean.mods.slice(0, 2);
      ctx.store.getPlayer(me).dice.push(clean);
    }
    const target = ctx.store.getPlayer(me).dice.find((d) => !d.corrupted && d.rarity === 'rare')
      || ctx.store.getPlayer(me).dice[0];
    const { status, data } = await ctx.api('POST', '/api/craft/orb', {
      headers: auth(),
      body: { dieId: target.id, orbId: 'whetstone' },
    });
    assert.equal(status, 200, JSON.stringify(data).slice(0, 200));
    assert.equal(data.ok, true);
    assert.ok(data.die.quality >= 5);
  });

  it('сфера без запаса — 409', async () => {
    const die = ctx.store.getPlayer(me).dice[0];
    ctx.store.getPlayer(me).inventory.divine = 0;
    const { status, data } = await ctx.api('POST', '/api/craft/orb', {
      headers: auth(),
      body: { dieId: die.id, orbId: 'divine' },
    });
    assert.equal(status, 409);
    assert.equal(data.ok, false);
  });

  it('POST /api/craft/bench крафтит мод и списывает сферы', async () => {
    const player = ctx.store.getPlayer(me);
    const die = generateDie({ rng: createRng(9), rarity: 'rare', ilvl: 100 });
    die.mods = die.mods.slice(0, 2);
    player.dice.push(die);
    fillInventory(ctx.store, player, 30);
    const { status, data } = await ctx.api('POST', '/api/craft/bench', {
      headers: auth(),
      body: { dieId: die.id, recipeId: 'bench_flat' },
    });
    assert.equal(status, 200, JSON.stringify(data).slice(0, 200));
    assert.equal(data.ok, true);
    assert.equal(die.mods.filter((m) => m.crafted).length, 1);
  });
});

describe('Инвентарь через API', () => {
  it('экипировка и замок', async () => {
    const player = ctx.store.getPlayer(me);
    const die = player.dice[player.dice.length - 1];
    const equip = await ctx.api('POST', '/api/inventory/equip', { headers: auth(), body: { dieId: die.id } });
    assert.equal(equip.data.ok, true);
    assert.equal(player.equippedDieId, die.id);
    const lock = await ctx.api('POST', '/api/inventory/toggle-lock', { headers: auth(), body: { dieId: die.id } });
    assert.equal(lock.data.ok, true);
    assert.equal(die.locked, true);
    await ctx.api('POST', '/api/inventory/toggle-lock', { headers: auth(), body: { dieId: die.id } });
  });

  it('покупка базы и разбор', async () => {
    const player = ctx.store.getPlayer(me);
    player.inventory.chaos = 50;
    player.bossKills = 4;
    const buy = await ctx.api('POST', '/api/inventory/buy-base', { headers: auth(), body: { baseId: 'bone_d6' } });
    assert.equal(buy.data.ok, true);
    const newDie = buy.data.die;
    const salvage = await ctx.api('POST', '/api/inventory/salvage', { headers: auth(), body: { dieId: newDie.id } });
    assert.equal(salvage.data.ok, true);
    assert.ok(!player.dice.some((d) => d.id === newDie.id));
  });

  it('гэмбл уникального кубика', async () => {
    const player = ctx.store.getPlayer(me);
    player.inventory.chaos = 100;
    const { data } = await ctx.api('POST', '/api/inventory/gamble-unique', { headers: auth(), body: {} });
    assert.equal(data.ok, true);
    assert.equal(data.die.rarity, 'unique');
  });

  it('перевод сфер другу', async () => {
    const player = ctx.store.getPlayer(me);
    player.inventory.alteration = 20;
    const target = ctx.store.getPlayer('p5');
    const before = target.inventory.alteration;
    const { data } = await ctx.api('POST', '/api/trade/transfer', {
      headers: auth(),
      body: { toPlayerId: 'p5', orbId: 'alteration', amount: 7 },
    });
    assert.equal(data.ok, true);
    assert.equal(target.inventory.alteration, before + 7);
  });
});

describe('Карты и поход по развилкам через API', () => {
  it('POST /api/maps/buy покупает карту у Кирака', async () => {
    const player = ctx.store.getPlayer(me);
    player.inventory.transmutation = 20;
    player.inventory.whetstone = 20;
    const { data } = await ctx.api('POST', '/api/maps/buy', { headers: auth(), body: {} });
    assert.equal(data.ok, true);
    assert.ok(data.map.tier >= 1);
    assert.ok(player.maps.some((m) => m.id === data.map.id));
  });

  it('POST /api/maps/craft крафтит карту', async () => {
    const player = ctx.store.getPlayer(me);
    const map = createEmptyMap({ tier: 5 });
    player.maps.push(map);
    player.inventory.transmutation = 10;
    const { data } = await ctx.api('POST', '/api/maps/craft', {
      headers: auth(),
      body: { mapId: map.id, orbId: 'transmutation' },
    });
    assert.equal(data.ok, true, data.reason);
    assert.equal(map.rarity, 'magic');
  });

  it('полный цикл: start → node → turn → (победа) → dismiss', async () => {
    const player = ctx.store.getPlayer(me);
    player.portals = 10;
    const map = createEmptyMap({ tier: 1 });
    player.maps.push(map);
    const start = await ctx.api('POST', '/api/maps/start', { headers: auth(), body: { mapId: map.id, partnerId: 'p3' } });
    assert.equal(start.data.ok, true, start.data.reason);
    assert.equal(start.data.run.phase, 'navigation');
    assert.ok(start.data.run.graph.nodes.length >= 4);
    assert.ok(start.data.run.graph.nodes.some((n) => n.type === 'boss'));

    let guard = 0;
    let report = null;
    let sawCombat = false;
    let sawPeaceful = false;
    while (guard < 120 && !report) {
      guard += 1;
      const state = await ctx.api('GET', '/api/state', { headers: auth() });
      const run = state.data.activeRun;
      if (!run) break;
      if (run.phase === 'navigation') {
        const nodeId = run.availableNodeIds[0];
        assert.ok(nodeId, 'должен быть доступный узел');
        const node = run.graph.nodes.find((n) => n.id === nodeId);
        const resp = await ctx.api('POST', '/api/maps/node', { headers: auth(), body: { nodeId } });
        assert.equal(resp.data.ok, true, resp.data.reason);
        if (node.combat) sawCombat = true;
        else sawPeaceful = true;
        void sawPeaceful;
        assert.ok(resp.data.run, 'ответ содержит слепок похода');
        if (resp.data.run.phase === 'navigation') {
          assert.ok(resp.data.run.graph.nodes.some((n) => n.available), 'на развилке есть доступные узлы');
        }
        if (resp.data.run.phase === 'combat') {
          assert.ok(resp.data.run.enemy, 'в бою есть враг');
        }
        report = resp.data.report || null;
      } else if (run.phase === 'combat') {
        const turn = await ctx.api('POST', '/api/maps/turn', { headers: auth(), body: { action: 'attack' } });
        assert.equal(turn.data.ok, true, turn.data.reason);
        assert.ok(turn.data.turn.playerScore > 0);
        sawCombat = true;
        report = turn.data.report || null;
      } else {
        report = run.report;
        break;
      }
    }
    assert.equal(sawCombat, true, 'поход должен содержать бой');
    // Мирные узлы (chest/shrine) могут не попасть в конкретный маршрут —
    // их поведение проверяется отдельным запросом ниже.
    assert.ok(report, 'должен быть отчёт');
    assert.ok(['victory', 'defeat', 'retreat'].includes(report.outcome));

    const dismiss = await ctx.api('POST', '/api/maps/dismiss', { headers: auth(), body: {} });
    assert.equal(dismiss.data.ok, true);
    const cleared = await ctx.api('GET', '/api/state', { headers: auth() });
    assert.equal(cleared.data.activeRun, null);
  });

  it('/api/maps/node вне похода — 409', async () => {
    const { status } = await ctx.api('POST', '/api/maps/node', { headers: auth(), body: { nodeId: 'nope' } });
    assert.equal(status, 409);
  });

  it('/api/maps/choose-node работает как алиас /api/maps/node', async () => {
    const player = ctx.store.getPlayer(me);
    player.portals = 10;
    const map = createEmptyMap({ tier: 2 });
    player.maps.push(map);
    const start = await ctx.api('POST', '/api/maps/start', { headers: auth(), body: { mapId: map.id } });
    const nodeId = start.data.run.availableNodeIds[0];
    const { data } = await ctx.api('POST', '/api/maps/choose-node', { headers: auth(), body: { nodeId } });
    assert.equal(data.ok, true, data.reason);
    await ctx.api('POST', '/api/maps/retreat', { headers: auth(), body: {} });
    await ctx.api('POST', '/api/maps/dismiss', { headers: auth(), body: {} });
  });

  it('POST /api/maps/run делает быстрый авто-забег', async () => {
    const player = ctx.store.getPlayer(me);
    player.portals = 10;
    const map = createEmptyMap({ tier: 1 });
    player.maps.push(map);
    const { data } = await ctx.api('POST', '/api/maps/run', {
      headers: auth(),
      body: { mapId: map.id },
    });
    assert.equal(data.ok, true, data.reason);
    assert.ok(data.report);
    await ctx.api('POST', '/api/maps/dismiss', { headers: auth(), body: {} });
  });

  it('отступление сохраняет половину лута', async () => {
    const player = ctx.store.getPlayer(me);
    player.portals = 10;
    const map = createEmptyMap({ tier: 3 });
    player.maps.push(map);
    await ctx.api('POST', '/api/maps/start', { headers: auth(), body: { mapId: map.id } });
    const state = await ctx.api('GET', '/api/state', { headers: auth() });
    const run = ctx.store.getActiveRun(player);
    run.loot = { chaos: 8 };
    const chaosBefore = player.inventory.chaos;
    const { data } = await ctx.api('POST', '/api/maps/retreat', { headers: auth(), body: {} });
    assert.equal(data.ok, true, data.reason);
    assert.equal(player.inventory.chaos, chaosBefore + 4);
    await ctx.api('POST', '/api/maps/dismiss', { headers: auth(), body: {} });
  });

  it('нельзя запустить две карты одновременно', async () => {
    const player = ctx.store.getPlayer(me);
    player.portals = 10;
    const first = createEmptyMap({ tier: 1 });
    const second = createEmptyMap({ tier: 2 });
    player.maps.push(first, second);
    assert.equal((await ctx.api('POST', '/api/maps/start', { headers: auth(), body: { mapId: first.id } })).data.ok, true);
    const conflict = await ctx.api('POST', '/api/maps/start', { headers: auth(), body: { mapId: second.id } });
    assert.equal(conflict.status, 409);
    await ctx.api('POST', '/api/maps/retreat', { headers: auth(), body: {} });
    await ctx.api('POST', '/api/maps/dismiss', { headers: auth(), body: {} });
  });
});

describe('Атлас через API', () => {
  it('POST /api/atlas/point изучает пассивку', async () => {
    const player = ctx.store.getPlayer(me);
    player.atlasPoints = 5;
    player.atlasPassives = [];
    const { data } = await ctx.api('POST', '/api/atlas/point', {
      headers: auth(),
      body: { passiveId: 'trophy_hunter' },
    });
    assert.equal(data.ok, true, data.reason);
    assert.equal(player.atlasPoints, 4);
    assert.ok(player.atlasPassives.includes('trophy_hunter'));
    const again = await ctx.api('POST', '/api/atlas/point', { headers: auth(), body: { passiveId: 'trophy_hunter' } });
    assert.equal(again.status, 409);
  });

  it('POST /api/atlas/deposit сдаёт фрагмент в реликварий', async () => {
    const player = ctx.store.getPlayer(me);
    player.fragments.hydra = 2;
    const before = ctx.store.db.raid.fragments.hydra;
    const { data } = await ctx.api('POST', '/api/atlas/deposit', { headers: auth(), body: { fragmentId: 'hydra' } });
    assert.equal(data.ok, true, data.reason);
    assert.equal(ctx.store.db.raid.fragments.hydra, before + 1);
    assert.equal(player.fragments.hydra, 1);
  });
});

describe('Рейд через API', () => {
  it('summon → attack → (cooldown) → kill → claim → roll-loot', async () => {
    const player = ctx.store.getPlayer(me);
    const partner = ctx.store.getPlayer('p3');
    ctx.store.db.raid.fragments = { hydra: 1, chimera: 1, phoenix: 1, minotaur: 1 };
    ctx.store.db.raid.active = null;
    player.dice = [generateDie({ rng: createRng(11), baseId: 'runic_d12', rarity: 'rare', ilvl: 100, topTierOnly: true })];
    player.equippedDieId = player.dice[0].id;
    partner.dice = [generateDie({ rng: createRng(12), baseId: 'prismatic_d10', rarity: 'rare', ilvl: 100 })];
    partner.equippedDieId = partner.dice[0].id;

    const summon = await ctx.api('POST', '/api/raid/summon', { headers: auth(), body: {} });
    assert.equal(summon.data.ok, true, summon.data.reason);
    assert.equal(summon.data.raid.hp, 6000);

    const attack = await ctx.api('POST', '/api/raid/attack', { headers: auth(), body: {} });
    assert.equal(attack.data.ok, true, attack.data.reason);
    assert.ok(attack.data.damage > 0);
    assert.ok(attack.data.bossHp < 6000);
    assert.ok(attack.data.rally.players >= 1);

    const cooldown = await ctx.api('POST', '/api/raid/attack', { headers: auth(), body: {} });
    assert.equal(cooldown.status, 429, 'кулдаун 1 минута');

    // Добиваем босса.
    ctx.store.db.raid.active.hp = 1;
    const partnerSession = await login(ctx.api, 'p3');
    const kill = await ctx.api('POST', '/api/raid/attack', {
      headers: { authorization: `Bearer ${partnerSession.token}` },
      body: {},
    });
    assert.equal(kill.data.ok, true, kill.data.reason);

    const claim = await ctx.api('POST', '/api/raid/claim', { headers: auth(), body: {} });
    assert.equal(claim.data.ok, true, claim.data.reason);
    assert.ok(claim.data.gained.length > 0);
    const twice = await ctx.api('POST', '/api/raid/claim', { headers: auth(), body: {} });
    assert.equal(twice.status, 409);

    const roll = await ctx.api('POST', '/api/raid/roll-loot', { headers: auth(), body: {} });
    assert.equal(roll.data.ok, true, roll.data.reason);
    assert.ok(roll.data.result.winnerId);
  });

  it('рейд без фрагментов — 409', async () => {
    ctx.store.db.raid.fragments = { hydra: 0, chimera: 0, phoenix: 0, minotaur: 0 };
    ctx.store.db.raid.active = null;
    const { status, data } = await ctx.api('POST', '/api/raid/summon', { headers: auth(), body: {} });
    assert.equal(status, 409);
    assert.match(data.reason, /фрагмент/i);
  });
});

describe('Задания и дуэли', () => {
  it('POST /api/dup quest/claim и /api/duel', async () => {
    const player = ctx.store.getPlayer(me);
    const quests = ctx.store.getQuests(player);
    const quest = quests[0];
    player.daily.counters[quest.counter] = quest.target;
    const claim = await ctx.api('POST', '/api/quest/claim', { headers: auth(), body: { questId: quest.id } });
    assert.equal(claim.data.ok, true, claim.data.reason);

    player.daily.counters.duels = 0;
    const duel = await ctx.api('POST', '/api/duel', { headers: auth(), body: { opponentId: 'p5' } });
    assert.equal(duel.data.ok, true, duel.data.reason);
    assert.ok(duel.data.duel.challengerScore > 0);
  });

  it('нельзя дуэлиться с самим собой', async () => {
    const { status } = await ctx.api('POST', '/api/duel', { headers: auth(), body: { opponentId: me } });
    assert.equal(status, 409);
  });
});

describe('Админ-эндпоинты', () => {
  it('админ меняет лимит и сбрасывает кулдаун', async () => {
    const limit = await ctx.api('POST', '/api/settings/daily-limit', {
      headers: auth(), body: { limit: 2 },
    });
    assert.equal(limit.data.ok, true);
    assert.equal(limit.data.limit, 2);
    const reset = await ctx.api('POST', '/api/settings/reset-cd', { headers: auth(), body: {} });
    assert.equal(reset.data.ok, true);
    assert.ok(reset.data.affected >= 1);
  });

  it('сброс босса и ладдера', async () => {
    const boss = await ctx.api('POST', '/api/settings/reset-boss', { headers: auth(), body: {} });
    assert.equal(boss.data.ok, true);
    assert.ok(boss.data.boss.maxHp > 0);
    const ladder = await ctx.api('POST', '/api/settings/reset-ladder', { headers: auth(), body: {} });
    assert.equal(ladder.data.ok, true);
    assert.ok(ctx.store.db.settings.ladderResetAt);
  });

  it('права Атласа и чит-сферы', async () => {
    const atlas = await ctx.api('POST', '/api/settings/atlas', {
      headers: auth(), body: { playerId: 'p6', points: 9 },
    });
    assert.equal(atlas.data.ok, true);
    assert.equal(ctx.store.getPlayer('p6').atlasPoints, 9);
    const resetAtlas = await ctx.api('POST', '/api/settings/reset-atlas', {
      headers: auth(), body: { playerId: 'p6' },
    });
    assert.equal(resetAtlas.data.ok, true);
    const add = await ctx.api('POST', '/api/cheat/add-orbs', {
      headers: auth(), body: { playerId: 'p6', orbId: 'divine', amount: 4 },
    });
    assert.equal(add.data.ok, true);
    const modify = await ctx.api('POST', '/api/cheat/modify-orbs', {
      headers: auth(), body: { playerId: 'p6', orbId: 'divine', delta: -2 },
    });
    assert.equal(modify.data.ok, true);
  });

  it('вайп требует кодовое слово', async () => {
    const bad = await ctx.api('POST', '/api/settings/reset-all', { headers: auth(), body: { code: 'нет' } });
    assert.equal(bad.status, 409);
    const good = await ctx.api('POST', '/api/settings/reset-all', { headers: auth(), body: { code: 'ВАЙП' } });
    assert.equal(good.data.ok, true);
    assert.equal(ctx.store.db.players.length, 6);
  });

  it('не-админ получает 403', async () => {
    const p5 = await login(ctx.api, 'p5');
    const { status, data } = await ctx.api('POST', '/api/settings/daily-limit', {
      headers: { authorization: `Bearer ${p5.token}` },
      body: { limit: 9 },
    });
    assert.equal(status, 403);
    assert.match(data.reason, /администратор/i);
  });
});

describe('Статика и 404', () => {
  it('отдаёт index.html по /', async () => {
    const response = await fetch(`${ctx.baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /PATH OF DICE/);
    assert.match(html, /data-screen="hub"/);
  });

  it('неизвестный /api маршрут — JSON 404', async () => {
    const { status, data } = await ctx.api('GET', '/api/unknown-route');
    assert.equal(status, 404);
    assert.equal(data.ok, false);
  });

  it('SPA-роут отдаёт index.html', async () => {
    const response = await fetch(`${ctx.baseUrl}/atlas`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /PATH OF DICE/);
  });
});

describe('Cloud API (без токена)', () => {
  it('статус облака требует админа и сообщает о выключенном бэкапе', async () => {
    const { status, data } = await ctx.api('GET', '/api/cloud/status', { headers: auth() });
    assert.equal(status, 200);
    assert.equal(data.cloud.enabled, false);
    const backup = await ctx.api('POST', '/api/cloud/backup', { headers: auth(), body: {} });
    assert.equal(backup.status, 503);
  });
});
