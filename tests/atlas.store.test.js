/**
 * GameStore + движок броска: суточный лимит, ауры пати, лут, крафт,
 * карты, дерево Атласа, рейд, фрагменты, дуэли, задания и админка.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { CloudBackup } from '../src/cloudStorage.js';
import { buildSignedLink, signHmac, signToken, verifySignedLink, verifyToken, validateInitData } from '../src/auth.js';
import {
  applyBossDamage,
  getPartyAuras,
  rollDailyDie,
  rollOrbDrop,
} from '../src/engine/roll.js';
import { applyOrbToDie, createRng, generateDie, getDieAggregatedStats } from '../src/engine/crafting.js';
import { createEmptyMap, getAtlasEffects, getFragmentsSummary } from '../src/engine/atlas.js';
import { GameStore, SCHEMA_VERSION, dayKey, levelFromXp, xpForLevel } from '../src/store.js';
import { fillInventory, makeStore, seeded, tmpDbPath } from './helpers.js';

function strongPlayer(store, id = 'p1') {
  const player = store.getPlayer(id);
  const die = generateDie({ rng: seeded(7), baseId: 'runic_d12', rarity: 'rare', ilvl: 100, topTierOnly: true });
  player.dice = [die];
  player.equippedDieId = die.id;
  fillInventory(store, player, 40);
  return { player, die };
}

describe('GameStore: сид и миграции', () => {
  it('сид на 6 друзей, у каждого свой кубик и инвентарь', () => {
    const store = makeStore();
    assert.equal(store.db.players.length, 6);
    for (const player of store.db.players) {
      assert.ok(player.id && player.name && player.avatar);
      assert.ok(player.dice.length >= 1);
      assert.equal(player.equippedDieId, player.dice[0].id);
      assert.ok(player.inventory.whetstone >= 0);
      assert.ok(player.maps.length >= 1);
    }
    assert.equal(store.db.players.filter((p) => p.isAdmin).length, 1);
  });

  it('миграция чинит битые поля и поднимает schema', () => {
    const store = makeStore();
    const broken = {
      players: [
        { id: 'x1', name: 'Тест', inventory: { chaos: -5, divine: 'oops' }, dice: [], maps: [{ tier: 99 }] },
        { id: 'x2', inventory: null, atlasPoints: -3, fragments: { hydra: 2 } },
      ],
    };
    const migrated = store.migrate(broken);
    assert.equal(migrated.schema, SCHEMA_VERSION);
    const player = migrated.players[0];
    assert.ok(player.dice.length >= 1, 'кубик создаётся автоматически');
    assert.equal(player.inventory.chaos, 0);
    assert.equal(player.inventory.divine, 0);
    assert.ok(player.inventory.vaal >= 0);
    assert.equal(player.maps[0].tier, 16, 'тир ограничен 16');
    assert.equal(migrated.players[1].atlasPoints, 0);
    assert.equal(migrated.raid.fragments.hydra, 0);
    assert.ok(migrated.chat.boss.maxHp > 0);
  });

  it('migrate добавляет недостающие верхнеуровневые секции', () => {
    const store = makeStore();
    const migrated = store.migrate({ players: [] });
    assert.ok(migrated.settings);
    assert.ok(migrated.chat);
    assert.deepEqual(migrated.atlas.activeRuns, {});
    assert.ok(Array.isArray(migrated.feed));
    assert.equal(migrated.raid.bossIndex, 0);
  });

  it('persist: запись на диск и восстановление', () => {
    const dbPath = tmpDbPath('persist');
    const store = new GameStore({ dbPath, quiet: true, persist: true });
    store.load();
    const player = store.db.players[0];
    player.inventory.chaos += 5;
    store.touch({ immediate: true });
    assert.ok(fs.existsSync(dbPath));

    const reloaded = new GameStore({ dbPath, quiet: true, persist: true });
    reloaded.load();
    assert.equal(reloaded.getPlayer(player.id).inventory.chaos, player.inventory.chaos);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}.tmp`, { force: true });
  });

  it('version растёт при изменении и state умеет отдавать unchanged', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    player.lastChestDay = '2026-01-01';
    store.touch();
    const version = store.version;
    store.touch();
    assert.ok(store.version > version);
    const unchanged = store.getState(player, { sinceVersion: store.version });
    assert.equal(unchanged.unchanged, true);
    const fresh = store.getState(player, { sinceVersion: 0 });
    assert.equal(fresh.unchanged, undefined);
    assert.ok(fresh.constants.affixes.length === 32);
  });
});

describe('уровни и опыт', () => {
  it('кривая XP монотонна и levelFromXp корректен', () => {
    assert.equal(xpForLevel(1), 0);
    assert.ok(xpForLevel(10) > xpForLevel(9));
    assert.equal(levelFromXp(0), 1);
    assert.ok(levelFromXp(xpForLevel(5)) >= 5);
    assert.ok(levelFromXp(xpForLevel(5) - 1) < 5);
  });

  it('grantXp поднимает уровень и выдаёт награды', () => {
    const store = makeStore();
    const player = store.getPlayer('p6');
    player.xp = 0;
    const before = { ...player.inventory };
    const result = store.grantXp(player, 5000, { rng: seeded(3) });
    assert.equal(result.levelUp, true);
    assert.ok(result.level > 1);
    assert.ok(Object.values(player.inventory).reduce((a, b) => a + b, 0)
      > Object.values(before).reduce((a, b) => a + b, 0));
  });
});

describe('ежедневный бросок (store.roll)', () => {
  it('лимит по умолчанию — 1 бросок в день', () => {
    const store = makeStore();
    const player = store.getPlayer('p2');
    player.lastRollDay = null;
    player.dailyRollsUsed = 0;
    const first = store.roll(player);
    assert.equal(first.ok, true, first.reason);
    assert.ok(first.roll.score > 0);
    assert.ok(first.roll.damage > 0);
    const second = store.roll(player);
    assert.equal(second.ok, false);
    assert.match(second.reason, /уже сделан/i);
  });

  it('кредитует валюту и бьёт по общему боссу чата', () => {
    const store = makeStore();
    const player = store.getPlayer('p3');
    player.lastRollDay = null;
    player.dailyRollsUsed = 0;
    const bossHpBefore = store.db.chat.boss.hp;
    const orbsBefore = Object.values(player.inventory).reduce((a, b) => a + b, 0);
    const result = store.roll(player);
    assert.equal(result.ok, true);
    assert.ok(store.db.chat.boss.hp < bossHpBefore);
    assert.ok(Object.values(player.inventory).reduce((a, b) => a + b, 0) > orbsBefore);
    assert.ok(store.db.feed[0].text.length > 0);
    assert.ok(player.stats.totalRolls >= 1);
  });

  it('кулдаун блокирует бросок', () => {
    const store = makeStore();
    const player = store.getPlayer('p4');
    player.lastRollDay = null;
    player.dailyRollsUsed = 0;
    player.cooldownUntil = Date.now() + 60000;
    const blocked = store.roll(player);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /Кулдаун/i);
    store.resetCooldown(store.getPlayer('p1'), player.id);
    const allowed = store.roll(player);
    assert.equal(allowed.ok, true);
  });

  it('админский лимит расширяет количество бросков', () => {
    const store = makeStore();
    const admin = store.getPlayer('p1');
    assert.equal(store.setDailyLimit(admin, 3).ok, true);
    const player = store.getPlayer('p5');
    player.lastRollDay = null;
    player.dailyRollsUsed = 0;
    for (let i = 0; i < 3; i += 1) {
      assert.equal(store.roll(player).ok, true, `бросок ${i + 1}`);
    }
    assert.equal(store.roll(player).ok, false);
    const stranger = store.getPlayer('p2');
    assert.equal(store.setDailyLimit(stranger, 5).ok, false, 'не админ не может');
  });

  it('добивание босса спавнит следующего и даёт бонус', () => {
    const store = makeStore();
    const { player } = strongPlayer(store);
    player.lastRollDay = null;
    player.dailyRollsUsed = 0;
    store.db.chat.boss.hp = 1;
    const result = store.roll(player);
    assert.equal(result.ok, true);
    assert.ok(result.bossDefeated, 'босс должен быть добит');
    assert.ok(result.bossDefeated.next.maxHp > 0);
    assert.equal(player.bossKills, 1);
    assert.ok(store.db.chat.defeatedBosses >= 1);
    assert.ok(store.db.feed.some((entry) => entry.kind === 'boss'));
  });
});

describe('движок броска (roll.js)', () => {
  const die = () => generateDie({
    rng: seeded(99), baseId: 'diamond_d4', rarity: 'rare', ilvl: 100, topTierOnly: true,
  });

  it('Lucky берёт лучший из двух бросков', () => {
    const d = die();
    d.mods.push({
      id: 'm_lucky', affixId: 'lucky', name: 'Lucky', type: 'suffix', key: 'luckyChance',
      unit: 'pct', stat: 'Lucky', tier: 'T1', value: 100, crafted: false,
    });
    const roll = rollDailyDie({ die: d, rng: seeded(5) });
    assert.equal(roll.lucky, true);
    assert.ok(roll.luckyAlternate !== null);
    assert.ok(roll.events.some((e) => e.kind === 'lucky'));
  });

  it('noLucky отключает Lucky и снижает результат', () => {
    const d = die();
    d.mods.push({
      id: 'm_lucky2', affixId: 'lucky', name: 'Lucky', type: 'suffix', key: 'luckyChance',
      unit: 'pct', stat: 'Lucky', tier: 'T1', value: 100, crafted: false,
    });
    const normal = rollDailyDie({ die: d, rng: seeded(11) });
    const blocked = rollDailyDie({ die: d, rng: seeded(11), modifiers: { noLucky: true } });
    assert.equal(normal.lucky, true);
    assert.equal(blocked.lucky, false);
    assert.equal(blocked.luckyAlternate, null);
  });

  it('крит умножается на critMulti, крит x2.02 для Алмазного тетраэдра', () => {
    const d = generateDie({ rng: seeded(1), baseId: 'diamond_d4', rarity: 'normal', ilvl: 1 });
    const stats = getDieAggregatedStats(d);
    assert.equal(stats.baseCrit, 30);
    assert.ok(stats.critMultiTotal >= 185, `critMultiTotal: ${stats.critMultiTotal}`);
    let crits = 0;
    for (let i = 0; i < 40; i += 1) {
      const roll = rollDailyDie({ die: d, rng: seeded(i) });
      if (roll.crit) {
        crits += 1;
        assert.ok(roll.score >= Math.round(roll.scoreBeforeCrit * 1.8));
      }
    }
    assert.ok(crits > 3, `должно быть достаточно критов, было ${crits}`);
  });

  it('Эхо Броска добавляет грани и увеличивает счёт', () => {
    const d = die();
    d.mods.push({
      id: 'm_echo', affixId: 'multistrike', name: 'Эхо', type: 'prefix', key: 'multistrikeChance',
      unit: 'pct', stat: 'Эхо', tier: 'T0', value: 100, crafted: false,
    });
    const roll = rollDailyDie({ die: d, rng: seeded(3) });
    assert.ok(roll.echoes >= 1);
    assert.ok(roll.echoFaces.length === roll.echoes);
    assert.ok(roll.sumFaces > roll.firstFace);
  });

  it('minFaceBonus поднимает минимальную грань', () => {
    const d = generateDie({ rng: seeded(1), baseId: 'bone_d6', rarity: 'normal', ilvl: 1 });
    for (let i = 0; i < 60; i += 1) {
      const roll = rollDailyDie({ die: d, rng: seeded(i) });
      assert.ok(roll.primaryFace >= 2, `грань ${roll.primaryFace} должна быть ≥ 2`);
    }
  });

  it('групповые ауры пати суммируются без самого игрока', () => {
    const store = makeStore();
    store.db.players.forEach((p) => {
      p.atlasPassives = [];
      // Убираем случайные ауры из сида, чтобы проверить ровно наш кубик.
      for (const seedDie of p.dice) {
        seedDie.mods = seedDie.mods.filter(
          (mod) => !['party_aura_inc', 'party_aura_crit'].includes(mod.affixId),
        );
      }
    });
    const dieWithAura = generateDie({ rng: seeded(1), rarity: 'rare', ilvl: 100 });
    dieWithAura.mods = [
      { id: 'a1', affixId: 'party_aura_inc', name: 'Аура', type: 'suffix', key: 'partyAuraInc', unit: 'pct', stat: 'аура', tier: 'T0', value: 30, crafted: false },
      { id: 'a2', affixId: 'party_aura_crit', name: 'Аура', type: 'suffix', key: 'partyAuraCrit', unit: 'pct', stat: 'аура', tier: 'T0', value: 7, crafted: false },
    ];
    const host = store.getPlayer('p1');
    host.dice = [dieWithAura];
    host.equippedDieId = dieWithAura.id;

    const party = getPartyAuras(store.db.players, { excludeId: 'p2' });
    assert.equal(party.inc, 30);
    assert.equal(party.crit, 7);
    assert.deepEqual(party.contributors, ['Ксандр']);

    const self = getPartyAuras(store.db.players, { excludeId: 'p1' });
    assert.equal(self.inc, 0);
  });

  it('applyBossDamage уважает щит и Culling Strike', () => {
    const shieldedBoss = { hp: 1000, maxHp: 1000 };
    const shielded = applyBossDamage(shieldedBoss, 100, { shieldActive: true, shieldReduction: 0.65 });
    assert.equal(shielded.applied, 35);
    assert.equal(shielded.killed, false);
    assert.equal(shieldedBoss.hp, 965);

    // Порог казни — 5% HP: сначала опускаем цель, затем пробуем добить.
    const wounded = { hp: 40, maxHp: 1000 };
    const culling = applyBossDamage(wounded, 10, { culling: 100, rng: () => 0 });
    assert.equal(culling.culled, true);
    assert.equal(wounded.hp, 0);
    assert.equal(culling.killed, true);

    const unlucky = { hp: 40, maxHp: 1000 };
    const miss = applyBossDamage(unlucky, 10, { culling: 50, rng: () => 0.99 });
    assert.equal(miss.culled, false);
    assert.equal(unlucky.hp, 30);
  });

  it('rollOrbDrop отдаёт 2–5+ сфер и уважает количество', () => {
    const bag = rollOrbDrop({ rng: seeded(4), count: 4, quantityPct: 50 });
    const total = bag.reduce((sum, orb) => sum + orb.count, 0);
    assert.equal(total, 6);
    assert.ok(bag.every((orb) => orb.count > 0 && orb.icon));
    const doubled = rollOrbDrop({ rng: seeded(4), count: 3, doubleOrbs: true });
    assert.equal(doubled.reduce((a, b) => a + b.count, 0), 6);
  });
});

describe('крафт через стор', () => {
  it('craftOrb списывает сферу и меняет кубик', () => {
    const store = makeStore();
    const player = store.getPlayer('p2');
    const die = generateDie({ rng: seeded(1), rarity: 'normal', ilvl: 50 });
    player.dice = [die];
    player.equippedDieId = die.id;
    player.inventory.transmutation = 2;
    const result = store.craftOrb(player, { dieId: die.id, orbId: 'transmutation' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(die.rarity, 'magic');
    assert.ok(player.inventory.transmutation <= 2);
    player.inventory.divine = 0;
    const none = store.craftOrb(player, { dieId: die.id, orbId: 'divine' });
    assert.equal(none.ok, false, 'дивайнов нет в тайнике');
  });

  it('craftBench берёт сферы и требует разблокированный слот', () => {
    const store = makeStore();
    const player = store.getPlayer('p3');
    const die = generateDie({ rng: seeded(2), rarity: 'rare', ilvl: 100 });
    die.mods = die.mods.slice(0, 2);
    player.dice = [die];
    player.equippedDieId = die.id;
    player.atlasPassives = ['golden_rush', 'exalted_trove', 'generous_bench'];
    fillInventory(store, player, 20);
    const result = store.craftBench(player, { dieId: die.id, recipeId: 'bench_flat' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(die.mods.filter((m) => m.crafted).length, 1);
    assert.ok(getAtlasEffects(player).benchDiscount === 20);
  });

  it('экипировка, замок и разбор кубика', () => {
    const store = makeStore();
    const player = store.getPlayer('p4');
    const second = generateDie({ rng: seeded(4), rarity: 'rare', ilvl: 80 });
    player.dice.push(second);
    assert.equal(store.equipDie(player, second.id).ok, true);
    assert.equal(player.equippedDieId, second.id);
    assert.equal(store.toggleLock(player, second.id).ok, true);
    assert.equal(second.locked, true);
    assert.equal(store.salvage(player, second.id).ok, false, 'запертый не разбирается');
    store.toggleLock(player, second.id);
    const salvaged = store.salvage(player, second.id);
    assert.equal(salvaged.ok, true);
    assert.ok(!player.dice.some((d) => d.id === second.id));
  });

  it('покупка базы уважает требования боссов', () => {
    const store = makeStore();
    const player = store.getPlayer('p5');
    player.bossKills = 0;
    player.inventory.chaos = 100;
    assert.equal(store.buyBase(player, 'runic_d12').ok, false, 'нужно 4 босса');
    assert.equal(store.buyBase(player, 'bone_d6').ok, true);
    player.bossKills = 4;
    assert.equal(store.buyBase(player, 'runic_d12').ok, true);
  });

  it('гэмбл уникального кубика стоит 20 Хаоса', () => {
    const store = makeStore();
    const player = store.getPlayer('p6');
    player.inventory.chaos = 19;
    assert.equal(store.gambleUnique(player).ok, false);
    player.inventory.chaos = 25;
    const result = store.gambleUnique(player);
    assert.equal(result.ok, true);
    assert.equal(player.inventory.chaos, 5);
    assert.equal(result.die.rarity, 'unique');
  });
});

describe('карты и походы через стор', () => {
  it('ежедневный сундук выдаёт карты и порталы один раз в день', () => {
    const store = makeStore();
    const player = store.getPlayer('p2');
    player.lastChestDay = null;
    const first = store.ensureDailyChest(player);
    assert.equal(first.granted, true);
    assert.ok(first.maps.length >= 3);
    assert.ok(player.portals >= 5);
    const second = store.ensureDailyChest(player);
    assert.equal(second.granted, false);
  });

  it('пассивка endless_trails даёт +1 портал, cartographer_stash +1 карту', () => {
    const store = makeStore();
    const player = store.getPlayer('p6');
    player.lastChestDay = null;
    player.atlasPassives = ['endless_trails', 'rich_veins', 'tier_boost', 'cartographer_stash'];
    const chest = store.ensureDailyChest(player);
    assert.equal(player.portals, 6);
    assert.ok(chest.maps.length >= 4);
  });

  it('покупка карты у Кирака за 3 Трансмутки + 3 Точилки', () => {
    const store = makeStore();
    const player = store.getPlayer('p3');
    player.inventory.transmutation = 2;
    player.inventory.whetstone = 10;
    assert.equal(store.buyMap(player).ok, false);
    player.inventory.transmutation = 5;
    const result = store.buyMap(player);
    assert.equal(result.ok, true);
    assert.equal(player.inventory.transmutation, 2);
    assert.equal(player.inventory.whetstone, 7);
  });

  it('крафт карты сферой через стор', () => {
    const store = makeStore();
    const player = store.getPlayer('p4');
    const map = createEmptyMap({ tier: 7 });
    player.maps.push(map);
    player.inventory.transmutation = 5;
    const result = store.craftMapOrb(player, { mapId: map.id, orbId: 'transmutation' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(map.rarity, 'magic');
    assert.ok(player.inventory.transmutation <= 5);
  });

  it('startMap расходует портал и карту, создаёт граф', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    player.lastChestDay = null;
    store.ensureDailyChest(player);
    const map = createEmptyMap({ tier: 5 });
    player.maps.push(map);
    const portalsBefore = player.portals;
    const result = store.startMap(player, { mapId: map.id });
    assert.equal(result.ok, true, result.reason);
    assert.equal(player.portals, portalsBefore - 1);
    assert.ok(!player.maps.some((m) => m.id === map.id));
    assert.ok(store.getActiveRun(player));
    assert.equal(store.startMap(player, { mapId: player.maps[0].id }).ok, false, 'второй поход запрещён');
  });

  it('полный проход: node → turn → victory → dismiss', () => {
    const store = makeStore();
    const { player } = strongPlayer(store);
    player.lastChestDay = null;
    store.ensureDailyChest(player);
    const map = createEmptyMap({ tier: 2 });
    player.maps.push(map);
    store.startMap(player, { mapId: map.id });

    let guard = 0;
    let report = null;
    while (guard < 120 && !report) {
      guard += 1;
      const run = store.getActiveRun(player);
      if (!run) break;
      if (run.phase === 'navigation') {
        const options = run.graph.nodes.filter(
          (n) => run.graph.nodes.find((x) => x.id === run.currentNodeId)?.nextIds.includes(n.id),
        );
        const target = options[0];
        assert.ok(target, 'должна быть доступная развилка');
        const step = store.chooseNode(player, { nodeId: target.id });
        assert.equal(step.ok, true, step.reason);
        report = step.report || null;
      } else if (run.phase === 'combat') {
        const turn = store.mapTurn(player, { action: 'attack' });
        assert.equal(turn.ok, true, turn.reason);
        report = turn.report || null;
      } else {
        break;
      }
    }
    assert.ok(report, 'отчёт должен быть получен');
    const run = store.getActiveRun(player);
    assert.ok(['victory', 'defeat', 'retreat'].includes(run.phase));
    const dismissed = store.dismiss(player);
    assert.equal(dismissed.ok, true, dismissed.reason);
    assert.equal(store.getActiveRun(player), null);
    assert.ok(store.db.atlas.history.length >= 1);
  });

  it('авто-забег распределяет долю напарнику', () => {
    const store = makeStore();
    const { player } = strongPlayer(store, 'p2');
    const partner = store.getPlayer('p4');
    player.lastChestDay = null;
    store.ensureDailyChest(player);
    const map = createEmptyMap({ tier: 1 });
    player.maps.push(map);
    const partnerOrbsBefore = Object.values(partner.inventory).reduce((a, b) => a + b, 0);
    const result = store.autoRun(player, { mapId: map.id, partnerId: partner.id });
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.report);
    const partnerOrbsAfter = Object.values(partner.inventory).reduce((a, b) => a + b, 0);
    assert.ok(partnerOrbsAfter >= partnerOrbsBefore);
  });

  it('победа начисляет очки Атласа за bonus objective', () => {
    const store = makeStore();
    const { player } = strongPlayer(store, 'p3');
    player.atlasCompleted = [];
    player.atlasPoints = 0;
    player.lastChestDay = null;
    store.ensureDailyChest(player);
    const map = createEmptyMap({ tier: 1 });
    map.rarity = 'magic';
    player.maps.push(map);
    const result = store.autoRun(player, { mapId: map.id });
    assert.equal(result.ok, true);
    if (result.report.outcome === 'victory') {
      assert.ok(player.atlasPoints >= 0);
    }
  });
});

describe('дерево Атласа через стор', () => {
  it('изучение пассивки тратит очки и пишет ленту', () => {
    const store = makeStore();
    const player = store.getPlayer('p6');
    player.atlasPoints = 3;
    player.atlasPassives = [];
    const result = store.learnAtlasPassive(player, 'golden_rush');
    assert.equal(result.ok, true, result.reason);
    assert.equal(player.atlasPoints, 2);
    assert.ok(store.db.feed[0].text.includes('пассивку'));
    assert.deepEqual(getAtlasEffects(player), {
      alterToChaos: 15,
      bossExaltChance: 0,
      benchDiscount: 0,
      topTierDrops: false,
      extraPortals: 0,
      quantity: 0,
      plusTwoChance: 0,
      extraMaps: 0,
      fragmentBonus: 0,
      battleCry: 0,
      bossDamage: 0,
      raidSpoils: 0,
    });
  });

  it('богатые жилы усиливают количество валюты', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    player.atlasPassives = ['endless_trails', 'rich_veins'];
    const effects = getAtlasEffects(player);
    assert.equal(effects.quantity, 15);
    assert.equal(effects.extraPortals, 1);
  });
});

describe('реликвий и рейд через стор', () => {
  it('сдача фрагментов, призыв, атака, лут и розыгрыш уникального кубика', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    const second = store.getPlayer('p2');
    player.fragments = { hydra: 1, chimera: 1, phoenix: 1, minotaur: 1 };
    player.dice = [generateDie({ rng: seeded(3), baseId: 'runic_d12', rarity: 'rare', ilvl: 100, topTierOnly: true })];
    player.equippedDieId = player.dice[0].id;
    second.dice = [generateDie({ rng: seeded(4), baseId: 'prismatic_d10', rarity: 'rare', ilvl: 100 })];
    second.equippedDieId = second.dice[0].id;

    for (const id of ['hydra', 'chimera', 'phoenix', 'minotaur']) {
      const deposit = store.depositFragment(player, id);
      assert.equal(deposit.ok, true, deposit.reason);
    }
    const summary = getFragmentsSummary(store.db.raid);
    assert.equal(summary.total, 4);
    assert.equal(summary.ready, true);

    const summon = store.summonRaid(player);
    assert.equal(summon.ok, true, summon.reason);
    assert.equal(store.db.raid.active.hp, 6000);

    const firstHit = store.raidAttack(player);
    assert.equal(firstHit.ok, true, firstHit.reason);
    assert.ok(firstHit.damage > 0);

    // Мгновенно завершаем бой, чтобы проверить лут.
    store.db.raid.active.hp = 1;
    store.db.raid.active.attacks[second.id] = 0;
    const killing = store.raidAttack(second);
    assert.equal(killing.ok, true, killing.reason);
    assert.equal(killing.killed, true);
    assert.ok(store.db.raid.history.length >= 1);

    const claim = store.raidClaim(player);
    assert.equal(claim.ok, true, claim.reason);
    assert.ok(claim.gained.length > 0);
    assert.equal(store.raidClaim(player).ok, false, 'повторно нельзя');

    const roll = store.raidRollLoot(player);
    assert.equal(roll.ok, true, roll.reason);
    assert.ok(roll.result.winnerId);
    assert.equal(store.raidRollLoot(player).ok, false, 'розыгрыш один раз');
  });

  it('призыв без фрагментов невозможен', () => {
    const store = makeStore();
    const player = store.getPlayer('p4');
    store.db.raid.fragments = { hydra: 0, chimera: 0, phoenix: 0, minotaur: 0 };
    store.db.raid.active = null;
    const result = store.summonRaid(player);
    assert.equal(result.ok, false);
    assert.match(result.reason, /фрагмент/i);
  });
});

describe('дуэли, задания, обмен и лента', () => {
  it('дуэль даёт приз победителю и лимит 3 в сутки', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    store.ensureDay(player);
    player.daily.counters.duels = 0;
    player.daily.counters.duelWins = 0;
    const opponent = store.getPlayer('p2');
    const result = store.duel(player, { opponentId: opponent.id });
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.duel.challengerScore > 0);
    assert.ok(store.db.duels.length >= 1);
    for (let i = 0; i < 3; i += 1) store.duel(player, { opponentId: opponent.id });
    const blocked = store.duel(player, { opponentId: opponent.id });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /Лимит/i);
  });

  it('задания дня: 3 штуки, прогресс и награда', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    store.ensureDay(player);
    const quests = store.getQuests(player);
    assert.equal(quests.length, 3);
    const quest = quests[0];
    player.daily.counters[quest.counter] = quest.target;
    const claim = store.claimQuest(player, quest.id);
    assert.equal(claim.ok, true, claim.reason);
    assert.equal(store.claimQuest(player, quest.id).ok, false, 'дважды нельзя');
  });

  it('обмен сферами переводит валюту и пишет в ленту', () => {
    const store = makeStore();
    const player = store.getPlayer('p3');
    const target = store.getPlayer('p5');
    player.inventory.chaos = 10;
    const targetBefore = target.inventory.chaos;
    const result = store.transferOrbs(player, { toPlayerId: target.id, orbId: 'chaos', amount: 4 });
    assert.equal(result.ok, true);
    assert.equal(player.inventory.chaos, 6);
    assert.equal(target.inventory.chaos, targetBefore + 4);
    assert.ok(store.db.feed[0].text.includes('передал'));
    assert.equal(store.transferOrbs(player, { toPlayerId: target.id, orbId: 'chaos', amount: 999 }).ok, false);
    assert.equal(store.transferOrbs(player, { toPlayerId: player.id, orbId: 'chaos', amount: 1 }).ok, false);
  });

  it('лента ограничена feedLimit', () => {
    const store = makeStore();
    for (let i = 0; i < 120; i += 1) store.pushFeed({ kind: 'test', text: `событие ${i}` });
    assert.ok(store.db.feed.length <= 80);
  });
});

describe('админка', () => {
  const admin = (store) => store.getPlayer('p1');

  it('не-админ получает отказ на всех админ-действиях', () => {
    const store = makeStore();
    const stranger = store.getPlayer('p2');
    assert.equal(store.setDailyLimit(stranger, 5).ok, false);
    assert.equal(store.resetCooldown(stranger).ok, false);
    assert.equal(store.resetBoss(stranger).ok, false);
    assert.equal(store.resetLadder(stranger).ok, false);
    assert.equal(store.resetAll(stranger, 'ВАЙП').ok, false);
    assert.equal(store.cheatOrbs(stranger, 'p1', 'chaos', 10).ok, false);
  });

  it('админ меняет лимит, босса, ладдер и сферы', () => {
    const store = makeStore();
    const boss = store.resetBoss(admin(store));
    assert.equal(boss.ok, true);
    assert.ok(boss.boss.maxHp > 0);
    assert.equal(store.resetLadder(admin(store)).ok, true);
    assert.ok(store.db.settings.ladderResetAt);
    const cheat = store.cheatOrbs(admin(store), 'p3', 'exalted', 3);
    assert.equal(cheat.ok, true);
    assert.equal(store.getPlayer('p3').inventory.exalted, cheat.inventory.exalted);
    assert.equal(store.setAtlasPoints(admin(store), 'p4', 7).atlasPoints, 7);
    assert.equal(store.resetAtlas(admin(store), 'p1').ok, true);
  });

  it('вайп требует кодовое слово ВАЙП', () => {
    const store = makeStore();
    const bad = store.resetAll(admin(store), 'абракадабра');
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /ВАЙП/);
    const playersBefore = store.db.players.map((p) => p.id);
    const good = store.resetAll(admin(store), 'вайп');
    assert.equal(good.ok, true);
    assert.deepEqual(store.db.players.map((p) => p.id), playersBefore);
    assert.ok(store.db.feed.some((entry) => entry.text.includes('вайп')));
  });
});

describe('аутентификация', () => {
  it('подписанный токен проверяется и отбрасывается при подмене', () => {
    const token = signToken({ playerId: 'p1', admin: true });
    const check = verifyToken(token);
    assert.equal(check.ok, true);
    assert.equal(check.payload.sub, 'p1');
    assert.equal(check.payload.adm, true);
    assert.equal(verifyToken(`${token}x`).ok, false);
    assert.equal(verifyToken('garbage').ok, false);
    assert.equal(verifyToken(token, { now: Date.now() + 40 * 24 * 3600 * 1000 }).ok, false, 'истечение');
  });

  it('подписанная ссылка ?player=&sig=', () => {
    const link = buildSignedLink({ playerId: 'p3', baseUrl: 'https://example.com/app' });
    const url = new URL(link);
    assert.equal(url.searchParams.get('player'), 'p3');
    assert.equal(verifySignedLink({ playerId: 'p3', sig: url.searchParams.get('sig') }).ok, true);
    assert.equal(verifySignedLink({ playerId: 'p4', sig: url.searchParams.get('sig') }).ok, false);
    assert.equal(url.searchParams.get('sig'), signHmac('player:p3'));
  });

  it('validateInitData отвергает подделку и принимает корректную подпись', async () => {
    const crypto = await import('node:crypto');
    const botToken = '123456:TEST-TOKEN';
    const user = JSON.stringify({ id: 42, first_name: 'Тест' });
    const authDate = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({ user, auth_date: String(authDate), query_id: 'AAE' });
    const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    params.set('hash', hash);

    const valid = validateInitData(params.toString(), { botToken });
    assert.equal(valid.ok, true, valid.reason);
    assert.equal(valid.user.id, 42);

    const forged = new URLSearchParams(params);
    forged.set('user', JSON.stringify({ id: 999, first_name: 'Взломщик' }));
    assert.equal(validateInitData(forged.toString(), { botToken }).ok, false);

    const expired = validateInitData(params.toString(), { botToken, now: Date.now() + 3 * 86400000 });
    assert.equal(expired.ok, false);
  });

  it('ensureTelegramPlayer создаёт игрока и связывает свободный профиль', () => {
    const store = makeStore();
    store.db.players.forEach((p) => { p.telegramId = null; });
    const linked = store.ensureTelegramPlayer({ id: 777, first_name: 'Новый', username: 'nuub' });
    assert.equal(linked.ok, undefined);
    assert.equal(linked.player.telegramId, 777);
    assert.ok(linked.player.id);
    const again = store.ensureTelegramPlayer({ id: 777, first_name: 'Новый' });
    assert.equal(again.player.id, linked.player.id);

    const fresh = store.createSeed();
    const store2 = new GameStore({ persist: false, quiet: true });
    store2.db = store2.migrate(fresh);
    store2.db.players = store2.db.players.slice(0, 1);
    store2.db.players[0].telegramId = 1;
    const created = store2.ensureTelegramPlayer({ id: 5555, first_name: 'Странник' });
    assert.equal(store2.db.players.length, 2);
    assert.equal(created.player.telegramId, 5555);
  });
});

describe('CloudBackup: конфигурация и состояние', () => {
  it('без токена бэкап выключен и не падает', async () => {
    const store = makeStore();
    const statePath = tmpDbPath('cloud-state');
    const backup = new CloudBackup({ store, botToken: '', chatId: '', statePath, log: () => {} });
    assert.equal(backup.enabled, false);
    const result = await backup.backupNow();
    assert.equal(result.ok, false);
    assert.equal(backup.status().enabled, false);
    assert.equal(await backup.restore(), null);
  });

  it('делает sendDocument + pin и запоминает message_id', async () => {
    const store = makeStore();
    const statePath = tmpDbPath('cloud-state2');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/sendDocument')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 321, document: { file_id: 'FILE123' } } }),
        };
      }
      if (url.includes('/pinChatMessage')) {
        return { ok: true, json: async () => ({ ok: true, result: true }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };
    const backup = new CloudBackup({
      store,
      botToken: 'token',
      chatId: '42',
      statePath,
      debounceMs: 1,
      fetchImpl,
      log: () => {},
    });
    assert.equal(backup.enabled, true);
    const result = await backup.backupNow();
    assert.equal(result.ok, true, result.reason);
    assert.ok(calls.some((call) => call.url.includes('/sendDocument')));
    assert.ok(calls.some((call) => call.url.includes('/pinChatMessage')));
    assert.equal(backup.status().messageId, 321);
    fs.rmSync(statePath, { force: true });
  });

  it('восстанавливает БД из известного file_id', async () => {
    const store = makeStore();
    const statePath = tmpDbPath('cloud-state3');
    const snapshot = JSON.stringify({ ...store.db, players: store.db.players.slice(0, 2) });
    const fetchImpl = async (url) => {
      if (url.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'docs/db.json' } }) };
      }
      if (url.includes('/file/bot')) {
        return { ok: true, text: async () => snapshot, json: async () => JSON.parse(snapshot) };
      }
      if (url.includes('/getMessage')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 7, document: { file_id: 'F1' } } }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };
    const backup = new CloudBackup({
      store, botToken: 'token', chatId: '42', statePath, fetchImpl, log: () => {},
    });
    backup.writeState({ messageId: 7, fileId: 'F1' });
    const db = await backup.restore();
    assert.ok(db);
    assert.equal(db.players.length, 2);
    fs.rmSync(statePath, { force: true });
  });

  it('dayKey стабилен в пределах суток', () => {
    const base = new Date('2026-02-14T10:00:00Z').getTime();
    assert.equal(dayKey(base), dayKey(base + 3600 * 1000));
  });
});
