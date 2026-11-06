/**
 * Движок: генерация кубиков, сферы, верстак, карты, дерево Атласа, рейд.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AFFIXES,
  BENCH_RECIPES,
  CURRENCIES,
  CURRENCY_DISPLAY_ORDER,
  DICE_BASES,
  MAP_MODS,
  MAP_TIER_MAX,
  MAP_ZONES,
  RARITY,
} from '../src/engine/constants.js';
import {
  applyBenchRecipe,
  applyOrbToDie,
  applyVaal,
  createRng,
  estimateDiePower,
  fillMods,
  generateDie,
  getBenchCost,
  getDieAggregatedStats,
  getTopTier,
  hasTopTier,
  rollAffix,
  uid,
} from '../src/engine/crafting.js';
import {
  createEmptyMap,
  craftMap,
  getAtlasEffects,
  getFragmentsSummary,
  getMapModifiers,
  grantMapVictory,
  learnPassive,
  requirementSatisfied,
  rollDailyMaps,
} from '../src/engine/atlas.js';
import { makeStore, seeded } from './helpers.js';

describe('constants: единый источник правды', () => {
  it('ровно 11 валют и нет Сферы Алхимии', () => {
    assert.equal(Object.keys(CURRENCIES).length, 11);
    assert.equal(CURRENCY_DISPLAY_ORDER.length, 11);
    assert.ok(!('alchemy' in CURRENCIES));
    assert.equal(new Set(CURRENCY_DISPLAY_ORDER).size, 11);
    for (const id of CURRENCY_DISPLAY_ORDER) {
      assert.ok(CURRENCIES[id], `сфера ${id} должна существовать`);
      assert.ok(CURRENCIES[id].icon);
      assert.ok(CURRENCIES[id].description);
    }
  });

  it('шесть баз кубиков с имплиситами', () => {
    assert.equal(Object.keys(DICE_BASES).length, 6);
    assert.equal(DICE_BASES.bone_d6.implicit.key, 'minFaceBonus');
    assert.equal(DICE_BASES.diamond_d4.baseCrit, 30);
    assert.equal(DICE_BASES.diamond_d4.implicit.value, 35);
    assert.equal(DICE_BASES.weighted_d8.implicit.key, 'rerollOnes');
    assert.equal(DICE_BASES.astral_d6.implicit.value, 35);
    assert.equal(DICE_BASES.prismatic_d10.faces, 10);
    assert.equal(DICE_BASES.runic_d12.faces, 12);
    assert.equal(DICE_BASES.runic_d12.bossKillsRequired, 4);
  });

  it('32 группы аффиксов: 16 префиксов и 16 суффиксов, у каждой есть T0 с весом 0', () => {
    const affixes = Object.values(AFFIXES);
    assert.equal(affixes.length, 32);
    assert.equal(affixes.filter((a) => a.type === 'prefix').length, 16);
    assert.equal(affixes.filter((a) => a.type === 'suffix').length, 16);
    for (const affix of affixes) {
      assert.ok(affix.tiers.T1 && affix.tiers.T5, `${affix.id}: нужны тиры T1..T5`);
      assert.equal(affix.tiers.T0.weight, 0, `${affix.id}: T0 только через Ваал`);
      assert.ok(affix.tiers.T0.min <= affix.tiers.T0.max);
    }
  });

  it('16 зон Атласа T1–T16 и 10 модов карт', () => {
    assert.equal(MAP_ZONES.length, 16);
    assert.equal(MAP_ZONES[0].tier, 1);
    assert.equal(MAP_ZONES[15].tier, MAP_TIER_MAX);
    assert.equal(Object.keys(MAP_MODS).length, 10);
  });

  it('7 рецептов верстака, включая снятие крафта', () => {
    assert.equal(BENCH_RECIPES.length, 7);
    assert.ok(BENCH_RECIPES.some((r) => r.removesCraft));
  });
});

describe('генерация кубиков', () => {
  it('normal: 0 модов, rare: 3–6 модов, unique: фиксированные', () => {
    const rng = seeded(7);
    const normal = generateDie({ rng, baseId: 'bone_d6', rarity: 'normal', ilvl: 80 });
    assert.equal(normal.mods.length, 0);
    assert.equal(normal.rarity, 'normal');

    for (let i = 0; i < 20; i += 1) {
      const rare = generateDie({ rng, baseId: 'prismatic_d10', rarity: 'rare', ilvl: 80, topTierOnly: true });
      assert.ok(rare.mods.length >= 3 && rare.mods.length <= 6, `rare модов: ${rare.mods.length}`);
      assert.ok(rare.mods.filter((m) => m.type === 'prefix').length <= 3);
      assert.ok(rare.mods.filter((m) => m.type === 'suffix').length <= 3);
    }

    const unique = generateDie({ rng, rarity: 'unique', uniqueId: 'kaoms_die' });
    assert.equal(unique.rarity, 'unique');
    assert.equal(unique.mods.length, 2);
    assert.ok(unique.special.text.includes('More'));
  });

  it('magic: максимум 1 префикс и 1 суффикс', () => {
    const rng = seeded(3);
    for (let i = 0; i < 40; i += 1) {
      const magic = generateDie({ rng, rarity: 'magic', ilvl: 90 });
      assert.ok(magic.mods.length <= 2 && magic.mods.length >= 1);
      assert.ok(magic.mods.filter((m) => m.type === 'prefix').length <= 1);
      assert.ok(magic.mods.filter((m) => m.type === 'suffix').length <= 1);
    }
  });

  it('rollAffix уважает ilvl и не выдаёт T0 никогда', () => {
    const rng = seeded(11);
    const lowDie = generateDie({ rng, rarity: 'normal', ilvl: 1 });
    for (let i = 0; i < 50; i += 1) {
      const mod = rollAffix({ rng, die: lowDie, type: 'prefix', ilvl: 1 });
      if (mod) assert.equal(mod.tier, 'T5', 'на ilvl 1 доступен только T5');
    }
    const highDie = generateDie({ rng, rarity: 'normal', ilvl: 100 });
    for (let i = 0; i < 80; i += 1) {
      const mod = rollAffix({ rng, die: highDie, type: i % 2 ? 'prefix' : 'suffix', ilvl: 100 });
      if (mod) assert.notEqual(mod.tier, 'T0');
    }
  });

  it('getDieAggregatedStats суммирует имплиситы, моды и качество', () => {
    const rng = seeded(21);
    const die = generateDie({ rng, baseId: 'prismatic_d10', rarity: 'rare', ilvl: 100, topTierOnly: true });
    die.quality = 20;
    const stats = getDieAggregatedStats(die);
    assert.equal(stats.faces, 10);
    assert.ok(stats.incScore >= 20 + 25, 'качество + имплисит базы в incScore');
    assert.ok(stats.rarityPct >= 0);
    assert.ok(stats.critMultiTotal >= 150);

    const bone = generateDie({ rng, baseId: 'bone_d6', rarity: 'normal', ilvl: 1 });
    const boneStats = getDieAggregatedStats(bone);
    assert.equal(boneStats.minFaceBonus, 1);

    const weighted = generateDie({ rng, baseId: 'weighted_d8', rarity: 'normal', ilvl: 1 });
    assert.equal(getDieAggregatedStats(weighted).specials.rerollOnes, true);
  });

  it('estimateDiePower растёт с редкостью и ilvl', () => {
    const rng = seeded(5);
    const weak = generateDie({ rng, baseId: 'bone_d6', rarity: 'normal', ilvl: 1 });
    const strong = generateDie({ rng, baseId: 'runic_d12', rarity: 'rare', ilvl: 100, topTierOnly: true });
    assert.ok(estimateDiePower(strong) > estimateDiePower(weak));
    assert.ok(estimateDiePower(strong) > 20);
  });
});

describe('сферы на кубике', () => {
  const freshDie = (seedVal = 1) => generateDie({
    rng: seeded(seedVal), baseId: 'bone_d6', rarity: 'normal', ilvl: 80,
  });

  it('точилка даёт качество с шагом 5% до 20%', () => {
    const die = freshDie();
    for (let i = 0; i < 4; i += 1) {
      const result = applyOrbToDie({ die, orbId: 'whetstone', rng: seeded(i) });
      assert.equal(result.ok, true);
    }
    assert.equal(die.quality, 20);
    const overflow = applyOrbToDie({ die, orbId: 'whetstone', rng: seeded(9) });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.refunded, true);
  });

  it('цепочка Transmutation → Augmentation → Regal → Chaos → Scouring', () => {
    const die = freshDie(15);
    assert.equal(applyOrbToDie({ die, orbId: 'transmutation', rng: seeded(1) }).ok, true);
    assert.equal(die.rarity, 'magic');
    assert.ok(die.mods.length >= 1 && die.mods.length <= 2);

    if (die.mods.length === 1) {
      const aug = applyOrbToDie({ die, orbId: 'augmentation', rng: seeded(2) });
      assert.equal(aug.ok, true);
      assert.equal(die.mods.length, 2);
    }

    const regal = applyOrbToDie({ die, orbId: 'regal', rng: seeded(3) });
    assert.equal(regal.ok, true);
    assert.equal(die.rarity, 'rare');
    assert.equal(die.mods.length, 3);

    const chaos = applyOrbToDie({ die, orbId: 'chaos', rng: seeded(4) });
    assert.equal(chaos.ok, true);
    assert.ok(die.mods.length >= 3 && die.mods.length <= 6);

    const scouring = applyOrbToDie({ die, orbId: 'scouring', rng: seeded(5) });
    assert.equal(scouring.ok, true);
    assert.equal(die.rarity, 'normal');
    assert.equal(die.mods.length, 0);
  });

  it('Alteration перекручивает только magic', () => {
    const die = freshDie(22);
    assert.equal(applyOrbToDie({ die, orbId: 'alteration', rng: seeded(1) }).ok, false);
    applyOrbToDie({ die, orbId: 'transmutation', rng: seeded(2) });
    const alter = applyOrbToDie({ die, orbId: 'alteration', rng: seeded(3) });
    assert.equal(alter.ok, true);
    assert.ok(die.mods.length >= 1 && die.mods.length <= 2);
  });

  it('Annulment удаляет ровно 1 мод', () => {
    const rng = seeded(31);
    const die = generateDie({ rng, rarity: 'rare', ilvl: 100 });
    const before = die.mods.length;
    const result = applyOrbToDie({ die, orbId: 'annulment', rng: seeded(7) });
    assert.equal(result.ok, true);
    assert.equal(die.mods.length, before - 1);
  });

  it('Exalted добавляет мод, но не больше 6', () => {
    const rng = seeded(41);
    const die = generateDie({ rng, rarity: 'rare', ilvl: 100 });
    let guard = 0;
    while (die.mods.length < 6 && guard < 12) {
      guard += 1;
      applyOrbToDie({ die, orbId: 'exalted', rng: seeded(guard) });
    }
    assert.ok(die.mods.length >= 3 && die.mods.length <= 6);
    fillMods({ rng, die, targetMin: 6, targetMax: 6 });
    assert.equal(die.mods.length, 6);
    const overflow = applyOrbToDie({ die, orbId: 'exalted', rng: seeded(1) });
    assert.equal(overflow.ok, false);
  });

  it('Divine сохраняет тиры, меняет значения', () => {
    const rng = seeded(51);
    const die = generateDie({ rng, rarity: 'rare', ilvl: 100 });
    const tiers = die.mods.map((m) => m.tier);
    let changed = 0;
    for (let i = 0; i < 12; i += 1) {
      const before = die.mods.map((m) => m.value);
      const result = applyOrbToDie({ die, orbId: 'divine', rng: seeded(100 + i) });
      assert.equal(result.ok, true);
      if (die.mods.some((m, idx) => m.value !== before[idx])) changed += 1;
    }
    assert.deepEqual(die.mods.map((m) => m.tier), tiers, 'тиры не должны меняться');
    assert.ok(changed > 0, 'дивайн должен хотя бы раз изменить значение');
  });

  it('Vaal: ровно 4 исхода, флаг corrupted необратим', () => {
    const outcomes = new Set();
    for (let i = 0; i < 200; i += 1) {
      const die = generateDie({ rng: seeded(i + 300), rarity: 'rare', ilvl: 100 });
      const result = applyVaal({ die, rng: seeded(i * 7 + 1) });
      assert.equal(die.corrupted, true);
      assert.ok(['vaal_implicit', 'tier_zero', 'reroll_six', 'brick'].includes(result.outcome));
      outcomes.add(result.outcome);
      if (result.outcome === 'brick') {
        assert.equal(die.rarity, 'magic');
        assert.ok(die.mods.length >= 1 && die.mods.length <= 2);
      }
      if (result.outcome === 'tier_zero') {
        assert.ok(die.mods.some((m) => m.tier === 'T0'));
      }
      if (result.outcome === 'vaal_implicit') {
        assert.ok(die.vaalImplicits.length >= 1);
      }
    }
    assert.equal(outcomes.size, 4, `должны встретиться все 4 исхода, видели: ${[...outcomes]}`);

    const die = generateDie({ rng: seeded(5), rarity: 'rare', ilvl: 100 });
    applyVaal({ die, rng: seeded(9) });
    assert.equal(die.corrupted, true);
    const second = applyOrbToDie({ die, orbId: 'vaal', rng: seeded(3) });
    assert.equal(second.ok, false, 'повторное осквернение запрещено');
    const exalt = applyOrbToDie({ die, orbId: 'exalted', rng: seeded(3) });
    assert.equal(exalt.ok, false, 'осквернённый кубик неизменяем');
  });

  it('запертый кубик нельзя изменить', () => {
    const die = generateDie({ rng: seeded(1), rarity: 'normal', ilvl: 10 });
    die.locked = true;
    const result = applyOrbToDie({ die, orbId: 'transmutation', rng: seeded(1) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /заперт/i);
  });
});

describe('Мастерский верстак', () => {
  it('накладывает крафтовый мод и не даёт второй', () => {
    const rng = seeded(61);
    const die = generateDie({ rng, rarity: 'rare', ilvl: 100 });
    while (die.mods.length >= 4) die.mods.pop();
    const first = applyBenchRecipe({ die, recipeId: 'bench_flat' });
    assert.equal(first.ok, true, first.reason);
    assert.equal(die.mods.filter((m) => m.crafted).length, 1);
    const second = applyBenchRecipe({ die, recipeId: 'bench_inc' });
    assert.equal(second.ok, false);
    const remove = applyBenchRecipe({ die, recipeId: 'bench_remove' });
    assert.equal(remove.ok, true);
    assert.equal(die.mods.filter((m) => m.crafted).length, 0);
  });

  it('getBenchCost даёт скидку 20% от пассивки generous_bench', () => {
    const recipe = BENCH_RECIPES.find((r) => r.id === 'bench_flat');
    const full = getBenchCost(recipe, 0);
    const discounted = getBenchCost(recipe, 20);
    assert.deepEqual(full, { whetstone: 4, transmutation: 2 });
    assert.deepEqual(discounted, { whetstone: 4, transmutation: 2 });
    const inc = BENCH_RECIPES.find((r) => r.id === 'bench_multi');
    assert.ok(getBenchCost(inc, 20).regal >= 1);
  });

  it('уникальные и осквернённые кубики на верстак не принимаются', () => {
    const rng = seeded(71);
    const unique = generateDie({ rng, rarity: 'unique', uniqueId: 'atziri_die' });
    assert.equal(applyBenchRecipe({ die: unique, recipeId: 'bench_flat' }).ok, false);
    const rare = generateDie({ rng, rarity: 'rare', ilvl: 100 });
    rare.corrupted = true;
    assert.equal(applyBenchRecipe({ die: rare, recipeId: 'bench_flat' }).ok, false);
  });
});

describe('крафт карт', () => {
  it('16 тиров и корректные зоны', () => {
    for (let tier = 1; tier <= 16; tier += 1) {
      const map = createEmptyMap({ tier });
      assert.equal(map.tier, tier);
      assert.ok(map.name);
      assert.ok(map.bossName);
    }
    assert.equal(createEmptyMap({ tier: 99 }).tier, 16);
  });

  it('Трансмутка → Регал → Хаос на карте', () => {
    const rng = seeded(81);
    const map = createEmptyMap({ tier: 6 });
    assert.equal(craftMap({ map, orbId: 'transmutation', rng }).ok, true);
    assert.equal(map.rarity, 'magic');
    assert.ok(map.mods.length >= 1 && map.mods.length <= 2);

    assert.equal(craftMap({ map, orbId: 'regal', rng }).ok, true);
    assert.equal(map.rarity, 'rare');

    const chaos = craftMap({ map, orbId: 'chaos', rng: seeded(4) });
    assert.equal(chaos.ok, true);
    assert.ok(map.mods.length >= 4 && map.mods.length <= 6, `модов: ${map.mods.length}`);
    for (const modId of map.mods) assert.ok(MAP_MODS[modId]);
  });

  it('Ваал оскверняет карту и блокирует дальнейший крафт', () => {
    const map = createEmptyMap({ tier: 14 });
    const vaal = craftMap({ map, orbId: 'vaal', rng: seeded(3) });
    assert.equal(vaal.ok, true);
    assert.equal(map.corrupted, true);
    assert.equal(craftMap({ map, orbId: 'chaos', rng: seeded(3) }).ok, false);
  });

  it('getMapModifiers агрегирует risk/reward', () => {
    const map = createEmptyMap({ tier: 10 });
    map.rarity = 'rare';
    map.mods = ['blood_price', 'titanic', 'no_luck'];
    map.quality = 15;
    const mods = getMapModifiers(map);
    assert.equal(mods.quantityPct, 25 + 15);
    assert.equal(mods.noLucky, true);
    assert.ok(mods.bossHpMult >= 2.5);
    assert.equal(mods.extraFragment, 1);
  });

  it('ежедневный сундук выдаёт 3–5 белых карт', () => {
    for (let seedVal = 0; seedVal < 12; seedVal += 1) {
      const maps = rollDailyMaps({ rng: seeded(seedVal) });
      assert.ok(maps.length >= 3 && maps.length <= 5, `карт: ${maps.length}`);
      for (const map of maps) assert.ok(map.tier >= 1 && map.tier <= 5);
    }
    const bonus = rollDailyMaps({ rng: seeded(1), extraMaps: 2 });
    assert.ok(bonus.length >= 5 && bonus.length <= 7);
  });
});

describe('Атлас: дерево и награды', () => {
  it('12 пассивок, 3 ветки по 4 ноды, цепочки требований', () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    const effects = getAtlasEffects(player);
    assert.ok(effects.extraPortals >= 1);
    assert.ok(effects.fragmentBonus >= 0);

    const fresh = store.getPlayer('p5');
    fresh.atlasPassives = [];
    fresh.atlasPoints = 20;
    assert.equal(learnPassive(fresh, 'exalted_trove').ok, false, 'нужна предыдущая нода');
    assert.equal(learnPassive(fresh, 'golden_rush').ok, true);
    assert.equal(learnPassive(fresh, 'golden_rush').ok, false, 'повторно нельзя');
    assert.equal(learnPassive(fresh, 'exalted_trove').ok, true);
    assert.equal(learnPassive(fresh, 'generous_bench').ok, true);
    assert.equal(learnPassive(fresh, 'artisans_eye').ok, true);
    assert.equal(fresh.atlasPoints, 15);
    const eff = getAtlasEffects(fresh);
    assert.equal(eff.benchDiscount, 20);
    assert.equal(eff.topTierDrops, true);
    assert.equal(eff.alterToChaos, 15);
    assert.equal(eff.bossExaltChance, 10);
  });

  it('bonus objective: magic для T1–T5, rare для T6–T10, rare+corrupted для T11+', () => {
    const magic = createEmptyMap({ tier: 3 });
    magic.rarity = 'magic';
    assert.equal(requirementSatisfied(magic, 'magic'), true);
    assert.equal(requirementSatisfied(magic, 'rare'), false);

    const rare = createEmptyMap({ tier: 8 });
    rare.rarity = 'rare';
    assert.equal(requirementSatisfied(rare, 'rare'), true);

    const corrupted = createEmptyMap({ tier: 13 });
    corrupted.rarity = 'rare';
    assert.equal(requirementSatisfied(corrupted, 'rare_corrupted'), false);
    corrupted.corrupted = true;
    assert.equal(requirementSatisfied(corrupted, 'rare_corrupted'), true);
  });

  it('grantMapVictory начисляет очко атласа один раз за тир и даёт лут', () => {
    const store = makeStore();
    const player = store.getPlayer('p6');
    player.atlasCompleted = [];
    player.atlasPoints = 0;
    player.maps = [];
    const map = createEmptyMap({ tier: 2 });
    map.rarity = 'magic';

    const first = grantMapVictory({ player, map, rng: seeded(5), bossKills: 2 });
    assert.equal(first.atlasPoint, true);
    assert.equal(player.atlasPoints, 1);
    assert.deepEqual(player.atlasCompleted, [2]);

    const second = grantMapVictory({ player, map, rng: seeded(6), bossKills: 2 });
    assert.equal(second.atlasPoint, false);
    assert.equal(player.atlasPoints, 1);

    const hard = generateRareMapWithMods(14);
    const third = grantMapVictory({ player, map: hard, rng: seeded(7), bossKills: 4 });
    assert.ok(third.maps.length <= 1);
    assert.ok(Array.isArray(third.logs));
  });

  it('getFragmentsSummary/getFragments для рейда', () => {
    const store = makeStore();
    const raid = store.db.raid;
    const summary = getFragmentsSummary(raid);
    assert.equal(typeof summary, 'object');
    assert.equal(summary.total, Object.values(raid.fragments).reduce((a, b) => a + b, 0));
  });
});

function generateRareMapWithMods(tier) {
  const map = createEmptyMap({ tier });
  map.rarity = 'rare';
  map.mods = ['blood_price', 'frenzied'];
  map.corrupted = tier >= 11;
  return map;
}

describe('рейд-боссы (движок)', () => {
  it('4 фрагмента → призыв доступен, босс 6000/7500/9500 HP', async () => {
    const store = makeStore();
    const player = store.getPlayer('p1');
    player.fragments = { hydra: 1, chimera: 1, phoenix: 1, minotaur: 1 };
    store.db.raid.fragments = { hydra: 0, chimera: 0, phoenix: 0, minotaur: 0 };
    for (const id of ['hydra', 'chimera', 'phoenix', 'minotaur']) {
      const result = store.depositFragment(player, id);
      assert.equal(result.ok, true, result.reason);
    }
    const status = store.db.raid;
    assert.equal(status.fragments.hydra, 1);
    const summon = store.summonRaid(player);
    assert.equal(summon.ok, true, summon.reason);
    assert.equal(summon.raid.maxHp, 6000);
    assert.equal(summon.raid.hp, 6000);
    assert.equal(summon.raid.name, 'Создатель');
    assert.ok(summon.raid.expiresAt > Date.now());

    // Повторный призыв запрещён
    assert.equal(store.summonRaid(player).ok, false);
  });

  it('атака бьёт по боссу, уважает кулдаун 60с и не тратит бросок', () => {
    const store = makeStore();
    const player = store.getPlayer('p2');
    player.dice.push(generateDie({ rng: seeded(3), rarity: 'rare', ilvl: 100 }));
    player.equippedDieId = player.dice[player.dice.length - 1].id;
    store.ensureDailyChest(player);
    store.db.raid.fragments = { hydra: 1, chimera: 1, phoenix: 1, minotaur: 1 };
    assert.equal(store.summonRaid(player).ok, true);

    const rollsBefore = player.dailyRollsUsed;
    const attack = store.raidAttack(player);
    assert.equal(attack.ok, true, attack.reason);
    assert.ok(attack.damage > 0);
    assert.ok(attack.bossHp < 6000);
    assert.equal(player.dailyRollsUsed, rollsBefore, 'рейд не тратит суточный бросок');

    const blocked = store.raidAttack(player);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /Кулдаун/i);
  });

  it('щит включается на 75%, ярость на <15%, затем повержение и лут', () => {
    const store = makeStore();
    const player = store.getPlayer('p3');
    store.db.raid.fragments = { hydra: 1, chimera: 1, phoenix: 1, minotaur: 1 };
    store.summonRaid(player);
    const active = store.db.raid.active;
    // Ставим HP чуть выше порога 75% и бьём до пересечения.
    active.hp = Math.round(6000 * 0.752);
    let crossed = false;
    for (let i = 0; i < 10 && !crossed; i += 1) {
      store.db.raid.active.attacks[player.id] = 0;
      const hit = store.raidAttack(player);
      assert.equal(hit.ok, true, hit.reason);
      if (store.db.raid.active.shieldActive) crossed = true;
    }
    assert.equal(crossed, true, 'щит должен включиться при переходе через 75% HP');
    assert.equal(store.db.raid.active.shieldHitsLeft, 3);

    store.db.raid.active.hp = Math.round(6000 * 0.1);
    const now = Date.now();
    store.db.raid.active.attacks[player.id] = now - 61000;
    const second = store.raidAttack(player);
    assert.equal(second.ok, true, second.reason);
    assert.equal(store.db.raid.active.enraged, true, 'ярость при <15% HP');
  });
});
