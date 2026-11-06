/**
 * PATH OF DICE — engine/atlas.js
 * Атлас Миров 2.0: карты T1–T16, 10 модов Risk vs Reward, крафт карт,
 * дерево пассивок из 12 нод, фрагменты рейд-боссов и сам рейд.
 */

import {
  ATLAS_PASSIVES,
  bonusObjectiveRarity,
  CURRENCIES,
  DICE_BASE_LIST,
  FRAGMENTS,
  FRAGMENT_IDS,
  MAP_MODS,
  MAP_MOD_IDS,
  MAP_TIER_MAX,
  MAP_ZONES,
  RARITY,
  RAID_BOSSES,
  RAID_CONFIG,
  TUNING,
  UNIQUE_DICE,
  UNIQUE_GAMBLE_PRICE,
} from './constants.js';
import {
  applyOrbToDie,
  createRng,
  generateDie,
  getDieAggregatedStats,
  hasTopTier,
  pick,
  pickWeighted,
  randInt,
  uid,
} from './crafting.js';
import { rollDailyDie, rollOrbDrop } from './roll.js';

/* ───────────────────────── Карты ───────────────────────── */

export function getZone(tier) {
  const normalized = Math.max(1, Math.min(MAP_TIER_MAX, Math.round(tier)));
  return MAP_ZONES[normalized - 1];
}

export function zoneColorGroup(tier) {
  if (tier <= 5) return 'white';
  if (tier <= 10) return 'yellow';
  if (tier <= 15) return 'red';
  return 'purple';
}

export function createEmptyMap({ tier = 1, ownerId = null, rarity = 'normal' } = {}) {
  const zone = getZone(tier);
  return {
    id: uid('map'),
    tier: zone.tier,
    zoneId: zone.id,
    name: zone.name,
    icon: zone.icon,
    color: zone.color,
    bossName: zone.boss,
    rarity,
    quality: 0,
    mods: [],
    corrupted: false,
    ownerId,
    createdAt: Date.now(),
  };
}

export function getMapModifiers(map) {
  const out = {
    quantityPct: 0,
    rarityPct: 0,
    critChance: 0,
    mapDropChance: 0,
    fragmentChance: 0,
    bossHpMult: 1,
    monsterMult: 1,
    noLucky: false,
    doubleOrbs: false,
    lowFacePenalty: false,
    vaalWinds: false,
    enemyCritBonus: 0,
    bossIntentBonus: 0,
    extraFragment: 0,
    mods: [],
  };
  if (!map || !Array.isArray(map.mods)) return out;
  for (const modId of map.mods) {
    const mod = MAP_MODS[modId];
    if (!mod) continue;
    out.mods.push(mod);
    out.quantityPct += mod.quantityPct || 0;
    out.rarityPct += mod.rarityPct || 0;
    out.critChance += mod.critChance || 0;
    out.mapDropChance += mod.mapDropChance || 0;
    out.fragmentChance += mod.fragmentChance || 0;
    out.bossHpMult *= mod.bossHpMult || 1;
    out.monsterMult *= mod.monsterMult || 1;
    out.noLucky = out.noLucky || Boolean(mod.noLucky);
    out.doubleOrbs = out.doubleOrbs || Boolean(mod.doubleOrbs);
    out.lowFacePenalty = out.lowFacePenalty || Boolean(mod.lowFacePenalty);
    out.vaalWinds = out.vaalWinds || Boolean(mod.vaalWinds);
    out.enemyCritBonus += mod.enemyCritBonus || 0;
    out.bossIntentBonus += mod.bossIntentBonus || 0;
    out.extraFragment += mod.extraFragment || 0;
  }
  out.qualityPct = map.quality || 0;
  out.quantityPct += map.quality || 0;
  return out;
}

export function mapRarityCaps(map) {
  const caps = RARITY[map?.rarity] || RARITY.normal;
  return { maxMods: caps.maxMods, rarity: map?.rarity || 'normal' };
}

/**
 * Крафт карты в Мап-девайсе. Поддерживаются Точилка, Трансмутка, Хаос,
 * Скоуринг, Ваал и Аннул (снятие мода карты).
 */
export function craftMap({ map, orbId, rng = createRng() }) {
  if (!map) return { ok: false, reason: 'Карта не найдена.' };
  const orb = CURRENCIES[orbId];
  if (!orb) return { ok: false, reason: 'Неизвестная сфера.' };

  if (orbId === 'vaal') {
    if (map.corrupted) return { ok: false, reason: 'Карта уже осквернена.' };
    map.corrupted = true;
    const roll = rng();
    if (roll < 0.35) {
      map.rarity = 'rare';
      ensureMapMods(map, rng, 4, 6);
      return { ok: true, message: 'Ваал сделал карту Редкой и осквернённой.', map, event: { kind: 'corrupt', outcome: 'upgrade' } };
    }
    if (roll < 0.7) {
      const extra = MAP_MOD_IDS.filter((id) => !map.mods.includes(id));
      if (extra.length) {
        map.mods.push(pick(rng, extra));
      }
      map.rarity = map.rarity === 'normal' ? 'rare' : map.rarity;
      ensureMapMods(map, rng, 3, 6);
      return { ok: true, message: 'Ваал добавил мод и осквернил карту.', map, event: { kind: 'corrupt', outcome: 'mod' } };
    }
    map.quality = 0;
    return { ok: true, message: 'Ваал сжёг качество карты, но оставил её осквернённой.', map, event: { kind: 'corrupt', outcome: 'burn' } };
  }

  if (map.corrupted) return { ok: false, reason: 'Осквернённую карту нельзя изменить.' };

  switch (orbId) {
    case 'whetstone': {
      if ((map.quality || 0) >= TUNING.maxQuality) {
        return { ok: false, reason: 'Качество карты уже 20%.' };
      }
      map.quality = Math.min(TUNING.maxQuality, (map.quality || 0) + 5);
      return { ok: true, message: `Качество карты: ${map.quality}%. +${map.quality}% к количеству.`, map, event: { kind: 'quality' } };
    }
    case 'transmutation': {
      if (map.rarity !== 'normal') return { ok: false, reason: 'Трансмутка работает только на Обычной карте.' };
      map.rarity = 'magic';
      ensureMapMods(map, rng, 1, 2);
      return { ok: true, message: `Карта стала Магической: ${map.mods.length} мод(ов).`, map, event: { kind: 'rarity', rarity: 'magic' } };
    }
    case 'alteration': {
      if (map.rarity !== 'magic') return { ok: false, reason: 'Переменка работает только на Магической карте.' };
      map.mods = [];
      ensureMapMods(map, rng, 1, 2);
      return { ok: true, message: 'Моды карты перекручены.', map, event: { kind: 'reroll' } };
    }
    case 'augmentation': {
      if (map.rarity !== 'magic') return { ok: false, reason: 'Усилялка работает только на Магической карте.' };
      if (map.mods.length >= 2) return { ok: false, reason: 'У карты уже 2 мода.' };
      ensureMapMods(map, rng, map.mods.length + 1, map.mods.length + 1);
      return { ok: true, message: 'Добавлен мод на карту.', map, event: { kind: 'augment' } };
    }
    case 'scouring': {
      if (map.rarity === 'normal') return { ok: false, reason: 'Карта и так Обычная.' };
      map.rarity = 'normal';
      map.mods = [];
      return { ok: true, message: 'Карта очищена до Обычной (качество сохранено).', map, event: { kind: 'scour' } };
    }
    case 'regal': {
      if (map.rarity !== 'magic') return { ok: false, reason: 'Регал работает только на Магической карте.' };
      map.rarity = 'rare';
      ensureMapMods(map, rng, map.mods.length + 1, map.mods.length + 1);
      return { ok: true, message: 'Карта стала Редкой.', map, event: { kind: 'rarity', rarity: 'rare' } };
    }
    case 'chaos': {
      if (map.corrupted) return { ok: false, reason: 'Осквернённую карту нельзя перекрутить.' };
      map.rarity = 'rare';
      map.mods = [];
      ensureMapMods(map, rng, 4, 6);
      return { ok: true, message: `Хаос сделал карту Редкой: ${map.mods.length} модов.`, map, event: { kind: 'reroll', rarity: 'rare' } };
    }
    case 'annulment': {
      if (!map.mods.length) return { ok: false, reason: 'На карте нет модов.' };
      const index = Math.floor(rng() * map.mods.length);
      const [removed] = map.mods.splice(index, 1);
      if (!map.mods.length && map.rarity !== 'normal') map.rarity = 'normal';
      return { ok: true, message: `Аннул убрал мод: ${MAP_MODS[removed]?.name || removed}.`, map, event: { kind: 'annul' } };
    }
    case 'exalted': {
      if (map.rarity !== 'rare') return { ok: false, reason: 'Экзальт работает только на Редкой карте.' };
      if (map.mods.length >= 6) return { ok: false, reason: 'На карте уже 6 модов.' };
      ensureMapMods(map, rng, map.mods.length + 1, map.mods.length + 1);
      return { ok: true, message: 'Экзальт добавил мод на карту.', map, event: { kind: 'exalt' } };
    }
    default:
      return { ok: false, reason: 'Эта сфера не применяется к картам.' };
  }
}

function ensureMapMods(map, rng, min, max) {
  const caps = RARITY[map.rarity] || RARITY.normal;
  const limit = Math.min(caps.maxMods, max);
  const target = Math.min(limit, Math.max(min, map.mods.length));
  let guard = 0;
  while (map.mods.length < target && guard < 30) {
    guard += 1;
    const available = MAP_MOD_IDS.filter((id) => !map.mods.includes(id));
    if (!available.length) break;
    const mod = pickWeighted(rng, available.map((id) => MAP_MODS[id]), (m) => 1);
    if (mod) map.mods.push(mod.id);
  }
  return map;
}

/** Модификаторы карты для отображения в UI. */
export function describeMap(map) {
  if (!map) return 'Нет карты';
  const mods = (map.mods || []).map((id) => MAP_MODS[id]?.name).filter(Boolean);
  return {
    id: map.id,
    name: `T${map.tier} ${map.name}`,
    rarity: map.rarity,
    quality: map.quality,
    corrupted: map.corrupted,
    mods,
    summary: mods.length ? mods.join(' · ') : 'Без модов',
  };
}

/* ─────────────────── Ежедневный сундук / Кирак ─────────────────── */

export function rollDailyMaps({ rng = createRng(), extraMaps = 0 } = {}) {
  const count = randInt(rng, TUNING.dailyChestMapsMin, TUNING.dailyChestMapsMax) + extraMaps;
  const maps = [];
  for (let i = 0; i < count; i += 1) {
    const tier = randInt(rng, 1, 5);
    maps.push(createEmptyMap({ tier }));
  }
  return maps;
}

export function kiracCost() {
  return { ...TUNING.kiracCost };
}

export function canAfford(cost, inventory) {
  return Object.entries(cost).every(([orb, amount]) => (inventory?.[orb] || 0) >= amount);
}

export function payCost(cost, inventory) {
  for (const [orb, amount] of Object.entries(cost)) {
    inventory[orb] = (inventory[orb] || 0) - amount;
    if (inventory[orb] < 0) inventory[orb] = 0;
  }
  return inventory;
}

/* ─────────────────── Дерево Атласа ─────────────────── */

export function getAtlasPassive(id) {
  return ATLAS_PASSIVES[id] || null;
}

export function isPassiveAvailable(player, passiveId) {
  const passive = getAtlasPassive(passiveId);
  if (!passive) return { ok: false, reason: 'Пассивка не найдена.' };
  if ((player.atlasPassives || []).includes(passiveId)) {
    return { ok: false, reason: 'Пассивка уже изучена.' };
  }
  const missing = (passive.requires || []).filter(
    (req) => !(player.atlasPassives || []).includes(req),
  );
  if (missing.length) {
    return {
      ok: false,
      reason: `Требуется сначала изучить: ${missing.map((m) => ATLAS_PASSIVES[m]?.name || m).join(', ')}.`,
    };
  }
  if ((player.atlasPoints || 0) < passive.cost) {
    return { ok: false, reason: `Не хватает очков Атласа (нужно ${passive.cost}).` };
  }
  return { ok: true };
}

export function learnPassive(player, passiveId) {
  const check = isPassiveAvailable(player, passiveId);
  if (!check.ok) return check;
  const passive = getAtlasPassive(passiveId);
  player.atlasPoints -= passive.cost;
  player.atlasPassives = [...(player.atlasPassives || []), passiveId];
  return { ok: true, passive, message: `Изучено: ${passive.icon} ${passive.name}` };
}

/** Агрегированные эффекты дерева. */
export function getAtlasEffects(player) {
  const effects = {
    alterToChaos: 0,
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
  };
  for (const id of player?.atlasPassives || []) {
    const passive = ATLAS_PASSIVES[id];
    if (!passive) continue;
    for (const [key, value] of Object.entries(passive.effect)) {
      if (typeof value === 'boolean') effects[key] = effects[key] || value;
      else effects[key] = (effects[key] || 0) + value;
    }
  }
  return effects;
}

export function canLearnAnything(player) {
  return Object.values(ATLAS_PASSIVES).some((p) => isPassiveAvailable(player, p.id).ok);
}

/* ─────────────────── Победа на карте ─────────────────── */

/**
 * Начисление награды после зачистки карты.
 * @returns {{atlasPoint:boolean, tier:number, maps:object[], fragment:string|null,
 *            exalt:boolean, rareDie:object|null, logs:string[]}}
 */
export function grantMapVictory({
  player,
  map,
  rng = createRng(),
  bossKills = 0,
  modifiers = {},
} = {}) {
  const logs = [];
  const effects = getAtlasEffects(player);
  const mapMods = getMapModifiers(map);
  const tier = map?.tier || 1;
  const result = {
    atlasPoint: false,
    tier,
    maps: [],
    fragment: null,
    exalt: false,
    rareDie: null,
    logs,
    orbs: [],
  };

  /* ── Bonus Objective ── */
  const required = bonusObjectiveRarity(tier);
  const meets = requirementSatisfied(map, required);
  player.atlasCompleted = player.atlasCompleted || [];
  if (meets && !player.atlasCompleted.includes(tier)) {
    player.atlasCompleted.push(tier);
    player.atlasCompleted.sort((a, b) => a - b);
    player.atlasPoints = (player.atlasPoints || 0) + 1;
    result.atlasPoint = true;
    logs.push(`🎯 Bonus Objective T${tier} выполнен: +1 Очко Атласа.`);
  } else if (!meets) {
    logs.push(`Bonus Objective T${tier} требует ${RARITY[required.split('_')[0]]?.label?.toLowerCase() || required}${required.endsWith('corrupted') ? ' осквернённую' : ''} карту.`);
  }

  /* ── Map sustain: T+1 / T+2 ── */
  const plusTwoChance = 25 + effects.plusTwoChance + (mapMods.mapDropChance || 0) / 2;
  const dropChance = 55 + (mapMods.mapDropChance || 0) + (player.mods?.['mapFindPct'] || 0);
  if (rng() * 100 < dropChance) {
    let nextTier = tier + 1;
    if (rng() * 100 < plusTwoChance) nextTier += 1;
    if (nextTier <= MAP_TIER_MAX) {
      const dropped = createEmptyMap({ tier: nextTier, ownerId: player.id });
      player.maps = player.maps || [];
      player.maps.push(dropped);
      result.maps.push(dropped);
      logs.push(`🗺️ Выпала карта T${nextTier}: ${dropped.name}.`);
    } else {
      const dropped = createEmptyMap({ tier: MAP_TIER_MAX, ownerId: player.id });
      player.maps.push(dropped);
      result.maps.push(dropped);
      logs.push(`🗺️ Выпала карта T16: ${dropped.name}.`);
    }
  }

  /* ── Фрагмент рейд-босса ── */
  const fragmentChance = 18 + (mapMods.fragmentChance || 0) + effects.fragmentBonus;
  if (rng() * 100 < fragmentChance) {
    const fragmentId = pick(rng, FRAGMENT_IDS);
    player.fragments = player.fragments || {};
    player.fragments[fragmentId] = (player.fragments[fragmentId] || 0) + 1;
    result.fragment = fragmentId;
    logs.push(`${FRAGMENTS[fragmentId].icon} Выпал ${FRAGMENTS[fragmentId].name}!`);
  }

  /* ── Экзальт с босса ── */
  const exaltChance = 6 + (effects.bossExaltChance || 0) + bossKills * 0.4;
  if (rng() * 100 < exaltChance) {
    player.inventory.exalted = (player.inventory.exalted || 0) + 1;
    result.exalt = true;
    logs.push('🌟 С босса карты выпал Экзальт!');
  }

  /* ── Редкий/уникальный кубик высокого ilvl ── */
  const dieChance = 12 + tier * 0.8;
  if (rng() * 100 < dieChance) {
    const ilvl = Math.min(100, 40 + tier * 3);
    const topTier = effects.topTierDrops || tier >= 14;
    const rarityRoll = rng();
    const rarity = rarityRoll < 0.12 ? 'unique' : rarityRoll < 0.55 ? 'rare' : 'magic';
    const base = pick(rng, DICE_BASE_LIST.filter((b) => b.bossKillsRequired <= bossKills)) || DICE_BASE_LIST[0];
    const uniqueId = rarity === 'unique' ? pick(rng, Object.keys(UNIQUE_DICE)) : null;
    const die = generateDie({
      rng,
      baseId: base.id,
      rarity,
      ilvl,
      ownerId: player.id,
      uniqueId,
      topTierOnly: topTier,
    });
    player.dice = player.dice || [];
    player.dice.push(die);
    result.rareDie = die;
    logs.push(`🎲 Выпал ${RARITY[rarity].icon} ${die.name}!`);
  }

  /* ── Валюта за зачистку ── */
  const orbBag = rollOrbDrop({
    rng,
    count: Math.max(2, Math.round(tier / 2)),
    rarityPct: (mapMods.rarityPct || 0) + effects.quantity,
    quantityPct: (mapMods.quantityPct || 0) + effects.quantity,
    doubleOrbs: mapMods.doubleOrbs || false,
  });
  for (const orb of orbBag) {
    player.inventory[orb.id] = (player.inventory[orb.id] || 0) + orb.count;
  }
  result.orbs = orbBag;
  if (orbBag.length) {
    logs.push(`💰 Добыча: ${orbBag.map((o) => `${o.icon}${o.count}`).join(' ')}`);
  }

  return result;
}

export function requirementSatisfied(map, required) {
  if (!map) return false;
  if (required === 'magic') return ['magic', 'rare'].includes(map.rarity);
  if (required === 'rare') return map.rarity === 'rare';
  if (required === 'rare_corrupted') return map.rarity === 'rare' && map.corrupted;
  return false;
}

/* ─────────────────── Рейд-боссы ─────────────────── */

export function emptyRaidState() {
  return {
    fragments: Object.fromEntries(FRAGMENT_IDS.map((id) => [id, 0])),
    active: null,
    bossIndex: 0,
    history: [],
  };
}

export function ensureRaidState(db) {
  if (!db.raid) db.raid = emptyRaidState();
  if (!db.raid.fragments) db.raid.fragments = Object.fromEntries(FRAGMENT_IDS.map((id) => [id, 0]));
  for (const id of FRAGMENT_IDS) {
    if (typeof db.raid.fragments[id] !== 'number') db.raid.fragments[id] = 0;
  }
  if (!Array.isArray(db.raid.history)) db.raid.history = [];
  if (typeof db.raid.bossIndex !== 'number') db.raid.bossIndex = 0;
  return db.raid;
}

export function depositFragment(db, player, fragmentId) {
  const raid = ensureRaidState(db);
  if (!FRAGMENTS[fragmentId]) return { ok: false, reason: 'Неизвестный фрагмент.' };
  if ((player.fragments?.[fragmentId] || 0) <= 0) {
    return { ok: false, reason: 'У вас нет такого фрагмента.' };
  }
  player.fragments[fragmentId] -= 1;
  raid.fragments[fragmentId] += 1;
  return {
    ok: true,
    message: `${FRAGMENTS[fragmentId].icon} ${FRAGMENTS[fragmentId].name} сдан в Реликварий.`,
    total: getFragmentTotal(raid),
    bank: { ...raid.fragments },
  };
}

export function getFragmentTotal(raid) {
  return FRAGMENT_IDS.reduce((sum, id) => sum + (raid.fragments?.[id] || 0), 0);
}

/**
 * Сводка по фрагментам: банк, недостающие, готовность рейда.
 * @returns {{bank:object, total:number, ready:boolean, missing:string[]}}
 */
export function getFragmentsSummary(raid) {
  const bank = { ...(raid?.fragments || {}) };
  const missing = FRAGMENT_IDS.filter((id) => (bank[id] || 0) <= 0);
  return {
    bank,
    total: getFragmentTotal({ fragments: bank }),
    ready: missing.length === 0,
    missing,
  };
}

export function raidReady(raid) {
  return FRAGMENT_IDS.every((id) => (raid.fragments?.[id] || 0) > 0);
}

export function raidExpired(raid, now = Date.now()) {
  return Boolean(raid?.active && raid.active.expiresAt <= now);
}

export function summonRaid(db, player) {
  const raid = ensureRaidState(db);
  const now = Date.now();
  if (raid.active && !raidExpired(raid, now)) {
    return { ok: false, reason: 'Рейд-босс уже призван.' };
  }
  if (raid.active && raidExpired(raid, now)) {
    finalizeRaid(db, raid, { expired: true, now });
  }
  if (!raidReady(raid)) {
    const missing = FRAGMENT_IDS.filter((id) => (raid.fragments?.[id] || 0) <= 0);
    return {
      ok: false,
      reason: `Нужны все 4 фрагмента. Не хватает: ${missing.map((id) => FRAGMENTS[id].name).join(', ')}.`,
    };
  }
  const template = RAID_BOSSES[Math.min(raid.bossIndex, RAID_BOSSES.length - 1)];
  for (const id of FRAGMENT_IDS) raid.fragments[id] -= 1;
  raid.active = {
    bossId: template.id,
    name: template.name,
    icon: template.icon,
    color: template.color,
    hp: template.hp,
    maxHp: template.hp,
    summonedAt: now,
    expiresAt: now + RAID_CONFIG.durationMs,
    summonedBy: player.id,
    contributors: {},
    attacks: {},
    shieldsBroken: [],
    shieldActive: false,
    shieldHitsLeft: 0,
    enraged: false,
    rally: [],
    lootBank: [],
    claimed: [],
    lootRoll: null,
    uniquePrize: pick(createRng(now), Object.keys(UNIQUE_DICE)),
    defeated: false,
    defeatedAt: null,
  };
  return {
    ok: true,
    message: `🚨 Призван Рейд-Босс: ${template.name} (${template.hp} HP) на 12 часов!`,
    raid: raid.active,
  };
}

export function raidSummonInfo(raid) {
  const template = RAID_BOSSES[Math.min(raid?.bossIndex || 0, RAID_BOSSES.length - 1)];
  return {
    boss: template,
    ready: raidReady(raid || { fragments: {} }),
    total: getFragmentTotal(raid || { fragments: {} }),
    next: template,
  };
}

/** Live Rally Combo: сколько игроков атаковали за последние 10 минут. */
export function getRallyState(raid, now = Date.now()) {
  if (!raid?.active) return { players: 0, mult: 1, ignoreShields: false, recent: [] };
  const since = now - RAID_CONFIG.rallyWindowMs;
  const recent = (raid.active.rally || []).filter((entry) => entry.at >= since);
  const uniquePlayers = [...new Set(recent.map((entry) => entry.playerId))];
  let mult = 1;
  if (uniquePlayers.length >= RAID_CONFIG.rallyFivePlayers) mult = RAID_CONFIG.rallyFiveMult;
  else if (uniquePlayers.length >= RAID_CONFIG.rallyThreePlayers) mult = RAID_CONFIG.rallyThreeMult;
  return {
    players: uniquePlayers.length,
    mult,
    ignoreShields: uniquePlayers.length >= RAID_CONFIG.rallyFivePlayers,
    recent,
  };
}

export function raidCooldownLeft(raid, playerId, now = Date.now()) {
  if (!raid?.active) return 0;
  const last = raid.active.attacks?.[playerId] || 0;
  const cooldown = RAID_CONFIG.attackCooldownMs;
  return Math.max(0, last + cooldown - now);
}

function ensureRaidLootEntries(raid) {
  raid.active.lootBank = raid.active.lootBank || [];
  raid.active.claimed = raid.active.claimed || [];
  return raid.active;
}

/** Банк лута: гарантированный мешок каждому участнику. */
export function claimedBagFor(playerId, rng = createRng()) {
  const bag = rollOrbDrop({ rng, count: randInt(rng, 3, 5), rarityPct: 60 });
  return bag.map((orb) => ({ id: orb.id, count: orb.count }));
}

/**
 * Атака по рейд-боссу. Не расходует ежедневный бросок.
 * @returns {{ok:boolean, damage?:number, bossHp?:number, ...}}
 */
export function raidAttack({ db, player, rng = createRng(), now = Date.now() }) {
  const raid = ensureRaidState(db);
  if (!raid.active) return { ok: false, reason: 'Рейд-босс не призван.' };
  if (raid.active.defeated) return { ok: false, reason: 'Босс уже повержен.' };
  if (raidExpired(raid, now)) {
    finalizeRaid(db, raid, { expired: true, now });
    return { ok: false, reason: 'Время рейда истекло.' };
  }
  const cdLeft = raidCooldownLeft(raid, player.id, now);
  if (cdLeft > 0) {
    return { ok: false, reason: `Кулдаун ${Math.ceil(cdLeft / 1000)}с.`, cooldownLeft: cdLeft };
  }
  const die = (player.dice || []).find((d) => d.id === player.equippedDieId) || player.dice?.[0];
  if (!die) return { ok: false, reason: 'Нет экипированного кубика.' };

  const effects = getAtlasEffects(player);
  const rally = getRallyState(raid, now);
  const stats = getDieAggregatedStats(die);
  const boss = raid.active;
  const hpPct = (boss.hp / boss.maxHp) * 100;

  const roll = rollDailyDie({
    die,
    rng,
    partyAuras: { inc: 0, crit: 0 },
    bossKills: player.bossKills || 0,
    modifiers: {
      flatCrit: boss.enraged ? RAID_CONFIG.enrageCritBonus : 0,
      incScorePct: 0,
    },
  });

  let damage = roll.damage;
  damage = Math.round(damage * (1 + effects.bossDamage / 100));
  damage = Math.round(damage * rally.mult);

  // Щит Пустоты: активен, пока пати не выбьет 3 макс-грани.
  let shieldBlocked = false;
  if (boss.shieldActive && !rally.ignoreShields) {
    damage = Math.round(damage * (1 - RAID_CONFIG.shieldDamageReduction));
    shieldBlocked = true;
    if (roll.isMaxFace) {
      boss.shieldHitsLeft = Math.max(0, (boss.shieldHitsLeft || 0) - 1);
      if (boss.shieldHitsLeft === 0) {
        boss.shieldActive = false;
        boss.shieldsBroken.push({ at: now, by: player.id });
      }
    }
  }

  boss.hp = Math.max(0, boss.hp - damage);
  boss.contributors[player.id] = (boss.contributors[player.id] || 0) + damage;
  boss.attacks[player.id] = now;
  boss.rally = [...(boss.rally || []).filter((e) => e.at >= now - RAID_CONFIG.rallyWindowMs), { playerId: player.id, at: now }];

  // Фазы щита по 75/50/25%
  const newPct = (boss.hp / boss.maxHp) * 100;
  for (const threshold of RAID_CONFIG.shieldThresholds) {
    if (hpPct > threshold && newPct <= threshold && !boss.shieldsBroken.some((s) => s.threshold === threshold)) {
      boss.shieldActive = true;
      boss.shieldHitsLeft = RAID_CONFIG.shieldFacesRequired;
      boss.shieldsBroken.push({ threshold, at: now });
    }
  }
  if (newPct < RAID_CONFIG.enrageHpPct && !boss.enraged) {
    boss.enraged = true;
  }

  const killed = boss.hp <= 0 && !boss.defeated;
  if (killed) {
    boss.defeated = true;
    boss.defeatedAt = now;
    boss.shieldActive = false;
    buildRaidLoot(raid);
    finalizeRaid(db, raid, { now, expired: false });
  }

  return {
    ok: true,
    damage,
    roll,
    bossHp: boss.hp,
    bossMaxHp: boss.maxHp,
    shieldBlocked,
    shieldActive: boss.shieldActive,
    shieldHitsLeft: boss.shieldHitsLeft,
    enraged: boss.enraged,
    // Отдаём состояние rally после учёта текущего удара — игрок сразу видит себя в комбо.
    rally: getRallyState(raid, now),
    killed,
    cooldownMs: RAID_CONFIG.attackCooldownMs,
    message: killed
      ? `🏆 ${boss.name} повержен! Заберите награду в банке лута.`
      : `${roll.isCrit ? '💥 КРИТ! ' : ''}${damage} урона по ${boss.name}.`,
  };
}

function buildRaidLoot(raid) {
  const active = raid.active;
  const participants = Object.keys(active.contributors || {});
  if (!participants.length) return;
  const mvp = participants.reduce((best, id) =>
    (active.contributors[id] > (active.contributors[best] || 0) ? id : best), participants[0]);
  active.mvp = mvp;
  active.lootBank = participants.map((playerId) => ({
    playerId,
    bag: claimedBagFor(playerId),
    isMvp: playerId === mvp,
    claimed: false,
  }));
  active.lootBank.find((entry) => entry.isMvp)?.bag.push({ id: 'exalted', count: RAID_CONFIG.mvpExaltCount }, { id: 'divine', count: RAID_CONFIG.mvpDivineCount });
}

function finalizeRaid(db, raid, { expired = false, now = Date.now() } = {}) {
  if (!raid.active) return;
  const active = raid.active;
  if (!active.defeated) {
    // Истёк рейд — все получают половину добычи, босс остаётся жив.
    const participants = Object.keys(active.contributors || {});
    active.lootBank = participants.map((playerId) => ({
      playerId,
      bag: claimedBagFor(playerId).map((orb) => ({ id: orb.id, count: Math.max(1, Math.floor(orb.count / 2)) })),
      isMvp: false,
      claimed: false,
    }));
  }
  raid.history.unshift({
    bossId: active.bossId,
    name: active.name,
    hp: active.hp,
    maxHp: active.maxHp,
    defeated: Boolean(active.defeated),
    expired,
    at: now,
    contributors: { ...active.contributors },
    mvp: active.mvp || null,
    uniquePrize: active.uniquePrize || null,
  });
  raid.history = raid.history.slice(0, 12);
  if (active.defeated) {
    raid.bossIndex = Math.min(raid.bossIndex + 1, RAID_BOSSES.length - 1);
    // Сбрасываем сессию, но сохраняем банк лута в архиве.
    raid.lastDefeated = { ...active, claimed: [] };
  }
  if (expired) raid.lastExpired = { ...active };
  raid.active = null;
}

/** Забрать гарантированный мешок лута. */
export function claimRaidLoot(db, player) {
  const raid = ensureRaidState(db);
  const source = raid.active?.defeated ? raid.active : raid.lastDefeated;
  if (!source) return { ok: false, reason: 'Нет завершённого рейда.' };
  ensureRaidLootEntries({ active: source });
  const entry = (source.lootBank || []).find((bag) => bag.playerId === player.id);
  if (!entry) return { ok: false, reason: 'Вы не участвовали в этом рейде.' };
  if (source.claimed?.includes(player.id) || entry.claimed) {
    return { ok: false, reason: 'Награда уже получена.' };
  }
  entry.claimed = true;
  source.claimed = [...(source.claimed || []), player.id];
  const gained = [];
  for (const orb of entry.bag || []) {
    player.inventory[orb.id] = (player.inventory[orb.id] || 0) + orb.count;
    gained.push({ ...CURRENCIES[orb.id], count: orb.count });
  }
  return {
    ok: true,
    message: entry.isMvp ? '🏆 MVP! Забраны Экзальт и Дивайн + мешок лута.' : 'Забран мешок лута.',
    gained,
    isMvp: entry.isMvp,
  };
}

/** Розыгрыш уникального кубика среди участников. */
export function rollRaidLoot(db, player, rng = createRng()) {
  const raid = ensureRaidState(db);
  const source = raid.active?.defeated ? raid.active : raid.lastDefeated;
  if (!source) return { ok: false, reason: 'Нет завершённого рейда.' };
  if (source.lootRoll) {
    return { ok: false, reason: 'Уникальный кубик уже разыгран.', result: source.lootRoll };
  }
  const participants = Object.keys(source.contributors || {});
  if (!participants.length) return { ok: false, reason: 'Нет участников.' };
  const winnerId = pick(rng, participants);
  const winner = (db.players || []).find((p) => p.id === winnerId);
  const uniqueId = source.uniquePrize || pick(rng, Object.keys(UNIQUE_DICE));
  const die = generateDie({
    rng,
    rarity: 'unique',
    uniqueId,
    ilvl: 80,
    ownerId: winnerId,
  });
  if (winner) {
    winner.dice = winner.dice || [];
    winner.dice.push(die);
  }
  source.lootRoll = {
    at: Date.now(),
    winnerId,
    winnerName: winner?.name || 'Изгнанник',
    rolledBy: player?.id || null,
    uniqueId,
    dieId: die.id,
    dieName: die.name,
    participants,
  };
  return {
    ok: true,
    result: source.lootRoll,
    message: `🎲 Уникальный кубик «${die.name}» достаётся ${winner?.name || 'Изгнаннику'}!`,
  };
}

export function getRaidStatus(db, playerId = null) {
  const raid = ensureRaidState(db);
  const now = Date.now();
  const active = raid.active;
  return {
    bank: { ...raid.fragments },
    total: getFragmentTotal(raid),
    ready: raidReady(raid),
    active: active
      ? {
        ...active,
        cooldownLeft: playerId ? raidCooldownLeft(raid, playerId, now) : 0,
        rally: getRallyState(raid, now),
        remainingMs: Math.max(0, active.expiresAt - now),
      }
      : null,
    bossIndex: raid.bossIndex,
    nextBoss: RAID_BOSSES[Math.min(raid.bossIndex, RAID_BOSSES.length - 1)],
    history: raid.history.slice(0, 5),
    lastDefeated: raid.lastDefeated || null,
  };
}

/** Гэмбл уникального кубика у Гвеннен. */
export function gambleUnique({ player, rng = createRng() }) {
  const cost = UNIQUE_GAMBLE_PRICE.chaos;
  if ((player.inventory.chaos || 0) < cost) {
    return { ok: false, reason: `Нужно ${cost} Хаоса.` };
  }
  player.inventory.chaos -= cost;
  const uniqueId = pick(rng, Object.keys(UNIQUE_DICE));
  const die = generateDie({
    rng,
    rarity: 'unique',
    uniqueId,
    ilvl: 80,
    ownerId: player.id,
  });
  player.dice.push(die);
  return { ok: true, die, message: `🎰 Гвеннен выкатила уникальный кубик: ${die.name}!` };
}

/** Покупка базового кубика (с учётом прогресса по боссам). */
export function buyDieBase({ player, baseId, bossKills, rng = createRng() }) {
  const base = DICE_BASE_LIST.find((b) => b.id === baseId);
  if (!base) return { ok: false, reason: 'Неизвестная база.' };
  if ((bossKills ?? player.bossKills ?? 0) < base.bossKillsRequired) {
    return { ok: false, reason: `Нужно убить ${base.bossKillsRequired} босс(ов) чата.` };
  }
  if ((player.inventory.chaos || 0) < base.price) {
    return { ok: false, reason: `Нужно ${base.price} Хаоса.` };
  }
  player.inventory.chaos -= base.price;
  const die = generateDie({ rng, baseId: base.id, rarity: 'normal', ilvl: 70, ownerId: player.id });
  player.dice.push(die);
  return { ok: true, die, message: `Куплен ${base.name} за ${base.price} Хаоса.` };
}

/** Разбор кубика на валюту. */
export function salvageDie({ player, die }) {
  if (!die) return { ok: false, reason: 'Кубик не найден.' };
  if (die.locked) return { ok: false, reason: 'Кубик заперт.' };
  const base = DICE_BASE_LIST.find((b) => b.id === die.baseId) || DICE_BASE_LIST[0];
  const refund = { whetstone: 2 + Math.floor((die.quality || 0) / 10) };
  const modCount = (die.mods || []).length;
  if (modCount >= 3) refund.transmutation = 2;
  if (modCount >= 5) refund.alteration = 1;
  if (die.rarity === 'rare') refund.chaos = 1;
  if (die.rarity === 'unique') refund.exalted = 1;
  if (die.corrupted) refund.vaal = 1;
  for (const [orb, amount] of Object.entries(refund)) {
    player.inventory[orb] = (player.inventory[orb] || 0) + amount;
  }
  player.dice = player.dice.filter((d) => d.id !== die.id);
  if (player.equippedDieId === die.id) {
    player.equippedDieId = player.dice[0]?.id || null;
  }
  return { ok: true, refund, message: `Кубик разобран: ${Object.entries(refund).map(([id, n]) => `${CURRENCIES[id].icon}${n}`).join(' ')}`, base };
}

export function assertAtlasTier(tier) {
  const value = Math.round(Number(tier) || 0);
  return Math.max(1, Math.min(MAP_TIER_MAX, value));
}

export { applyOrbToDie, hasTopTier };
