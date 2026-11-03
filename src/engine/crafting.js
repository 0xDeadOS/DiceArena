/**
 * PATH OF DICE — engine/crafting.js
 * Генерация кубиков, агрегация статов, применение 11 сфер и рецептов верстака.
 * Модуль чистый: не трогает БД и не знает про сокеты, поэтому легко тестируется.
 */

import {
  AFFIX_TIERS,
  AFFIXES,
  BENCH_RECIPES,
  CURRENCIES,
  DICE_BASES,
  PREFIX_LIST,
  RARITY,
  SUFFIX_LIST,
  TUNING,
  UNIQUE_DICE,
  VAAL_IMPLICITS,
} from './constants.js';

/* ─────────────────────────── RNG ─────────────────────────── */

/** Детерминированный mulberry32 — одинаковый результат при одинаковом seed. */
export function createRng(seed = Date.now()) {
  let a = hashSeed(seed);
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const str = String(seed);
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randInt(rng, min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick(rng, list) {
  if (!list.length) return null;
  return list[Math.floor(rng() * list.length)];
}

/** Выбор по весам: entries — массив объектов, weightOf(entry) → number. */
export function pickWeighted(rng, entries, weightOf = (e) => e.weight ?? 1) {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, weightOf(entry)), 0);
  if (total <= 0) return entries.length ? entries[entries.length - 1] : null;
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= Math.max(0, weightOf(entry));
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 1_000_000_000;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/* ─────────────────────── Сущности кубиков ─────────────────────── */

export function getBase(baseId) {
  return DICE_BASES[baseId] || DICE_BASES.bone_d6;
}

export function getRarityCaps(rarityId) {
  return RARITY[rarityId] || RARITY.normal;
}

export function countMods(die) {
  return Array.isArray(die?.mods) ? die.mods.length : 0;
}

export function countByType(die, type, includeCrafted = true) {
  if (!Array.isArray(die?.mods)) return 0;
  return die.mods.filter((m) => m.type === type && (includeCrafted || !m.crafted)).length;
}

/** Сколько ещё модов данного типа можно навесить. */
export function openSlots(die, type) {
  const caps = getRarityCaps(die.rarity);
  const max = type === 'prefix' ? caps.maxPrefixes : caps.maxSuffixes;
  return Math.max(0, max - countByType(die, type));
}

export function hasOpenSlot(die, type) {
  return openSlots(die, type) > 0;
}

/** Свободные группы аффиксов, которых ещё нет на кубике. */
function availableAffixGroups(die, type) {
  const list = type === 'prefix' ? PREFIX_LIST : SUFFIX_LIST;
  const used = new Set((die.mods || []).map((m) => m.affixId));
  return list.filter((affix) => !used.has(affix.id));
}

/** Доступные тиры с учётом ilvl: T5 всегда, T4 c ilvl 8 … T1 c ilvl 60. */
const TIER_MIN_ILVL = Object.freeze({ T5: 0, T4: 8, T3: 20, T2: 35, T1: 60 });

function tierEligible(tier, ilvl, { topTierOnly = false } = {}) {
  if (tier === 'T0') return false; // T0 только через Сферу Ваала
  const need = TIER_MIN_ILVL[tier] ?? 0;
  if (ilvl < need) return false;
  if (topTierOnly) return tier === 'T1' || tier === 'T2';
  return true;
}

/** Выбирает группу, затем тир, затем значение. Возвращает мод или null. */
export function rollAffix({
  rng,
  die,
  type,
  ilvl = die?.ilvl ?? 1,
  topTierOnly = false,
  forcedAffixId = null,
  forcedTier = null,
}) {
  let affix;
  if (forcedAffixId) {
    affix = AFFIXES[forcedAffixId];
    if (!affix || affix.type !== type) return null;
    if ((die.mods || []).some((m) => m.affixId === forcedAffixId)) return null;
  } else {
    const pool = availableAffixGroups(die, type);
    if (!pool.length) return null;
    affix = pickWeighted(rng, pool, (a) => a.weight);
  }
  if (!affix) return null;

  const tiers = AFFIX_TIERS.filter(
    (tier) =>
      affix.tiers[tier] &&
      (forcedTier ? tier === forcedTier : tierEligible(tier, ilvl, { topTierOnly })),
  );
  if (!tiers.length) return null;

  const tier = pickWeighted(rng, tiers, (t) => Math.max(0.0001, affix.tiers[t].weight));
  const range = affix.tiers[tier];
  const value = randInt(rng, range.min, range.max);

  return makeMod({ affix, tier, value });
}

export function makeMod({ affix, tier, value, crafted = false }) {
  return {
    id: uid('mod'),
    affixId: affix.id,
    name: affix.name,
    type: affix.type,
    key: affix.key,
    unit: affix.unit,
    stat: affix.stat,
    tier,
    value,
    crafted: Boolean(crafted),
  };
}

export function formatModValue(mod) {
  const unit = mod.unit === 'pct' ? '%' : '';
  const sign = ['shield_break', 'more_damage', 'party_aura_crit'].includes(mod.affixId) ? '' : '+';
  return `${sign}${mod.value}${unit}`;
}

export function formatModLabel(mod) {
  const crafted = mod.crafted ? ' ✦' : '';
  return `[${mod.tier}] ${formatModValue(mod)} ${mod.stat}${crafted}`;
}

/** Заполняет кубик модами до требований редкости. */
export function fillMods({ rng, die, targetMin = 1, targetMax = null }) {
  const caps = getRarityCaps(die.rarity);
  const hardMax = Math.min(caps.maxMods, targetMax ?? caps.maxMods);
  const desired = randInt(rng, Math.min(targetMin, hardMax), hardMax);
  die.mods = [];
  let guard = 0;
  while (countMods(die) < desired && guard < 60) {
    guard += 1;
    const types = ['prefix', 'suffix'].filter((type) => hasOpenSlot(die, type));
    if (!types.length) break;
    const type = pick(rng, types);
    const mod = rollAffix({ rng, die, type, ilvl: die.ilvl });
    if (mod) die.mods.push(mod);
  }
  return die;
}

const RARE_PREFIX_WORDS = [
  'Кровавый', 'Пустотный', 'Астральный', 'Проклятый', 'Костяной', 'Огненный',
  'Ледяной', 'Штормовой', 'Забытый', 'Древний', 'Мерцающий', 'Рунический',
  'Бездонный', 'Сумрачный', 'Шейперский', 'Изгнанный',
];
const RARE_SUFFIX_WORDS = [
  'Рок', 'Грань', 'Шёпот', 'Пепел', 'Зов', 'Клинок', 'Вихрь', 'Судьба',
  'Клеймо', 'Разлом', 'Тень', 'Пламя', 'Холод', 'Прилив', 'Обет', 'Венец',
];

export function generateRareName(rng) {
  return `${pick(rng, RARE_PREFIX_WORDS)} ${pick(rng, RARE_SUFFIX_WORDS)}`;
}

/**
 * Создаёт новый кубик.
 * @param {object} opts
 * @param {'normal'|'magic'|'rare'|'unique'} opts.rarity
 * @param {string} [opts.baseId]
 * @param {string} [opts.uniqueId]
 */
export function generateDie({
  rng = createRng(),
  baseId = 'bone_d6',
  rarity = 'normal',
  ilvl = 1,
  ownerId = null,
  uniqueId = null,
  topTierOnly = false,
} = {}) {
  let base = getBase(baseId);

  if (uniqueId) {
    const unique = UNIQUE_DICE[uniqueId];
    if (!unique) throw new Error(`Неизвестный уникальный кубик: ${uniqueId}`);
    base = getBase(unique.base);
    rarity = 'unique';
  }

  const die = {
    id: uid('die'),
    baseId: base.id,
    baseName: base.name,
    short: base.short,
    faces: base.faces,
    rarity,
    uniqueId: uniqueId || null,
    name: rarity === 'unique' ? UNIQUE_DICE[uniqueId].name : base.name,
    icon: uniqueId ? UNIQUE_DICE[uniqueId].icon : base.icon,
    accent: base.accent,
    ilvl: Math.max(1, Math.round(ilvl)),
    quality: 0,
    mods: [],
    implicit: { ...base.implicit },
    vaalImplicits: [],
    corrupted: false,
    locked: false,
    ownerId,
    createdAt: Date.now(),
  };

  if (rarity === 'magic') {
    const count = rng() < 0.5 ? 1 : 2;
    const types = count === 1 ? [rng() < 0.5 ? 'prefix' : 'suffix'] : ['prefix', 'suffix'];
    for (const type of types) {
      const mod = rollAffix({ rng, die, type, ilvl: die.ilvl, topTierOnly });
      if (mod) die.mods.push(mod);
    }
  } else if (rarity === 'rare') {
    fillMods({ rng, die, targetMin: 3, targetMax: 6 });
  } else if (rarity === 'unique') {
    const unique = UNIQUE_DICE[uniqueId];
    die.mods = unique.fixedMods.map((fixed) => {
      const affix = AFFIXES[fixed.affixId];
      return makeMod({ affix, tier: fixed.tier, value: fixed.value });
    });
    die.special = { ...unique.special };
    die.flavor = unique.flavor;
  }

  die.name = die.rarity === 'rare' ? generateRareName(rng) : die.name;
  return die;
}

/* ─────────────────── Агрегация статов ─────────────────── */

const AGGREGATE_KEYS = [
  'flatAdd', 'incScore', 'multistrikeChance', 'maxFaceOverload', 'fireDamagePct',
  'coldDamagePct', 'lightningDamagePct', 'shieldBreakPct', 'chaosDamagePct',
  'cullingStrike', 'moreDamagePct', 'doubleFirstFace', 'physDamagePct',
  'minFaceBonus', 'bossDamagePct', 'maxHpFlat', 'critChance', 'critMulti',
  'luckyChance', 'rarityPct', 'extraOrbs', 'partyAuraInc', 'partyAuraCrit',
  'freeOrbChance', 'thornsPct', 'chargeChance', 'cooldownReduction',
  'orbDupeChance', 'damageReduction', 'regenChance', 'mapFindPct',
  'bonusCritMulti', 'bonusRarity', 'bonusIncScore', 'critMultiBase', 'elementalPenPct',
];

function emptyStats() {
  const out = {};
  for (const key of AGGREGATE_KEYS) out[key] = 0;
  out.faces = 0;
  out.baseCrit = 0;
  out.critMultiTotal = 0;
  out.quality = 0;
  out.specials = {};
  out.modCount = 0;
  out.topTier = null;
  return out;
}

/**
 * Суммирует все статы кубика: имплиситы базы, Vaal-имплиситы, моды, качество,
 * уникальные свойства. Числа приводятся к удобному виду для формул броска.
 */
export function getDieAggregatedStats(die, { qualityAsInc = true } = {}) {
  const stats = emptyStats();
  if (!die) return stats;

  const base = getBase(die.baseId);
  stats.faces = base.faces;
  stats.baseCrit = base.baseCrit;
  stats.critMultiBase = base.critMulti;
  stats.quality = Math.min(TUNING.maxQuality, die.quality || 0);
  stats.modCount = countMods(die);

  const applyImplicit = (implicit) => {
    if (!implicit) return;
    if (implicit.key === 'rerollOnes') {
      stats.specials.rerollOnes = true;
      return;
    }
    if (typeof stats[implicit.key] === 'number' && implicit.key !== 'critMultiBase') {
      stats[implicit.key] += implicit.value || 0;
    }
    if (implicit.secondary) {
      stats[implicit.secondary.key] = (stats[implicit.secondary.key] || 0) + implicit.secondary.value;
    }
  };

  applyImplicit(base.implicit);
  for (const vaal of die.vaalImplicits || []) applyImplicit(vaal);

  for (const mod of die.mods || []) {
    if (typeof stats[mod.key] === 'number') stats[mod.key] += mod.value;
    else stats[mod.key] = (stats[mod.key] || 0) + mod.value;
  }

  if (die.rarity === 'unique' && die.uniqueId) {
    const unique = UNIQUE_DICE[die.uniqueId];
    if (unique?.special) stats.specials[unique.special.key] = unique.special.text;
  }

  if (qualityAsInc) stats.incScore += stats.quality;
  stats.critMultiTotal = stats.critMultiBase + stats.critMulti + stats.bonusCritMulti;
  stats.incScore += stats.bonusIncScore;
  stats.rarityPct += stats.bonusRarity;

  if (die.special) stats.specials[die.special.key] = die.special.text;
  stats.topTier = getTopTier(die);
  return stats;
}

export function getTopTier(die) {
  if (!die?.mods?.length) return null;
  const order = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];
  let best = null;
  for (const mod of die.mods) {
    if (!best || order.indexOf(mod.tier) < order.indexOf(best)) best = mod.tier;
  }
  return best;
}

export function hasTopTier(die, tiers = ['T1', 'T2']) {
  return (die?.mods || []).some((m) => tiers.includes(m.tier));
}

/**
 * Грубая оценка «мощи» кубика — используется в ладдере, HP похода и
 * требовании силы боссов.
 */
export function estimateDiePower(die, { bossKills = 0 } = {}) {
  if (!die) return 0;
  const s = getDieAggregatedStats(die);
  let power = 0;
  power += s.faces * 2;
  power += (s.minFaceBonus || 0) * 4;
  power += s.flatAdd * 5;
  power += s.incScore * 0.35;
  power += s.moreDamagePct * 1.2;
  power += s.critChance * 0.45;
  power += Math.max(0, s.critMultiTotal - 150) * 0.35;
  power += s.multistrikeChance * 0.6;
  power += s.luckyChance * 0.5;
  power += s.maxFaceOverload * 0.4;
  power += s.rarityPct * 0.18;
  power += s.partyAuraInc * 0.5;
  power += s.doubleFirstFace * 0.3;
  power += s.bossDamagePct * 0.3;
  power += s.chaosDamagePct * 0.2;
  power += s.shieldBreakPct * 0.2;
  if (s.specials.headhunter) power += Math.min(40, bossKills * 2) * 0.4;
  return Math.round(power * 10) / 10;
}

/* ─────────────────── Сферы ─────────────────── */

export function canUseOrb(die, orbId) {
  const orb = CURRENCIES[orbId];
  if (!orb) return { ok: false, reason: 'Неизвестная сфера.' };
  if (!die) return { ok: false, reason: 'Кубик не найден.' };
  if (die.locked) return { ok: false, reason: 'Кубик заперт — снимите замок в тайнике.' };
  if (die.corrupted && orbId !== 'vaal') {
    return { ok: false, reason: 'Осквернённый кубик уже нельзя изменить.' };
  }
  if (orbId === 'vaal' && die.corrupted) return { ok: false, reason: 'Кубик уже осквернён.' };
  if (die.rarity === 'unique' && ['transmutation', 'alteration', 'augmentation', 'regal', 'scouring', 'chaos'].includes(orbId)) {
    return { ok: false, reason: 'Уникальные свойства нельзя перекрутить обычными сферами.' };
  }
  return { ok: true };
}

function rollFreeOrb(stats, rng) {
  const chance = Math.min(TUNING.freeOrbMax, stats.freeOrbChance || 0);
  return rng() * 100 < chance;
}

/**
 * Применяет сферу к кубику.
 * @returns {{ok:boolean, reason?:string, message?:string, die:object, refunded:boolean, event?:object}}
 */
export function applyOrbToDie({ die, orbId, rng = createRng() }) {
  const usable = canUseOrb(die, orbId);
  if (!usable.ok) return { ok: false, reason: usable.reason, die, refunded: true };

  const stats = getDieAggregatedStats(die);
  const free = rollFreeOrb(stats, rng);
  const finish = (payload) => ({
    ...payload,
    ok: payload.ok !== false,
    die,
    refunded: free,
    freeOrb: free,
    event: payload.event || null,
  });

  switch (orbId) {
    case 'whetstone': {
      if ((die.quality || 0) >= TUNING.maxQuality) {
        return { ok: false, reason: 'Качество уже максимальное (20%).', die, refunded: true };
      }
      die.quality = Math.min(TUNING.maxQuality, (die.quality || 0) + 5);
      return finish({ message: `Качество кубика: ${die.quality}%.`, event: { kind: 'quality', value: die.quality } });
    }
    case 'transmutation': {
      if (die.rarity !== 'normal') {
        return { ok: false, reason: 'Трансмутка работает только на Обычном кубике.', die, refunded: true };
      }
      die.rarity = 'magic';
      fillMods({ rng, die, targetMin: 1, targetMax: 2 });
      return finish({ message: `Кубик стал Магическим: ${die.mods.length} свойств.`, event: { kind: 'rarity', rarity: 'magic' } });
    }
    case 'alteration': {
      if (die.rarity !== 'magic') {
        return { ok: false, reason: 'Переменка работает только на Магическом кубике.', die, refunded: true };
      }
      fillMods({ rng, die, targetMin: 1, targetMax: 2 });
      return finish({
        message: `Свойства перекручены: ${die.mods.map(formatModLabel).join(', ')}`,
        event: { kind: 'reroll', topTier: getTopTier(die) },
      });
    }
    case 'augmentation': {
      if (die.rarity !== 'magic') {
        return { ok: false, reason: 'Усилялка работает только на Магическом кубике.', die, refunded: true };
      }
      if (die.mods.length >= 2) {
        return { ok: false, reason: 'У кубика уже 2 свойства — усилять некуда.', die, refunded: true };
      }
      const added = addRandomMod({ rng, die });
      if (!added) return { ok: false, reason: 'Нет свободных групп аффиксов.', die, refunded: true };
      return finish({ message: `Добавлено свойство: ${formatModLabel(added)}`, event: { kind: 'augment' } });
    }
    case 'scouring': {
      if (!['magic', 'rare'].includes(die.rarity)) {
        return { ok: false, reason: 'Скоуринг сбрасывает только Magic/Rare.', die, refunded: true };
      }
      die.rarity = 'normal';
      die.mods = [];
      return finish({ message: 'Кубик очищен до Обычного. Качество сохранено.', event: { kind: 'scour' } });
    }
    case 'regal': {
      if (die.rarity !== 'magic') {
        return { ok: false, reason: 'Регал превращает только Магический кубик в Редкий.', die, refunded: true };
      }
      die.rarity = 'rare';
      const added = addRandomMod({ rng, die });
      return finish({
        message: `Кубик стал Редким${added ? `, добавлено: ${formatModLabel(added)}` : ''}.`,
        event: { kind: 'rarity', rarity: 'rare' },
      });
    }
    case 'chaos': {
      if (die.rarity !== 'rare') {
        return { ok: false, reason: 'На кубике Хаос перекручивает только Редкий.', die, refunded: true };
      }
      fillMods({ rng, die, targetMin: 3, targetMax: 6 });
      return finish({
        message: `Хаос перекрутил редкий кубик: ${die.mods.length} модов.`,
        event: { kind: 'reroll', topTier: getTopTier(die) },
      });
    }
    case 'annulment': {
      if (!['magic', 'rare'].includes(die.rarity) || !die.mods.length) {
        return { ok: false, reason: 'Нечего удалять — нужен Magic/Rare с модами.', die, refunded: true };
      }
      const index = Math.floor(rng() * die.mods.length);
      const [removed] = die.mods.splice(index, 1);
      return finish({ message: `Аннул удалил: ${formatModLabel(removed)}`, event: { kind: 'annul' } });
    }
    case 'exalted': {
      if (die.rarity !== 'rare') {
        return { ok: false, reason: 'Экзальт работает только на Редком кубике.', die, refunded: true };
      }
      if (die.mods.length >= 6) {
        return { ok: false, reason: 'На кубике уже 6 модов — больше нельзя.', die, refunded: true };
      }
      const added = addRandomMod({ rng, die });
      if (!added) return { ok: false, reason: 'Нет свободных групп аффиксов.', die, refunded: true };
      return finish({
        message: `Экзальт добавил: ${formatModLabel(added)}`,
        event: { kind: 'exalt', tier: added.tier, mod: added },
      });
    }
    case 'divine': {
      if (!die.mods.length) return { ok: false, reason: 'Нечего перекручивать.', die, refunded: true };
      const changed = [];
      for (const mod of die.mods) {
        if (mod.crafted) continue;
        const affix = AFFIXES[mod.affixId];
        const range = affix?.tiers?.[mod.tier];
        if (!range) continue;
        const old = mod.value;
        mod.value = randInt(rng, range.min, range.max);
        if (mod.value !== old) changed.push(mod);
      }
      return finish({
        message: changed.length
          ? `Дивайн изменил ${changed.length} мод(ов), тиры сохранены.`
          : 'Дивайн прошёл впустую — значения остались прежними.',
        event: { kind: 'divine', changed: changed.length },
      });
    }
    case 'vaal': {
      return applyVaal({ die, rng, free });
    }
    default:
      return { ok: false, reason: 'Неизвестная сфера.', die, refunded: true };
  }
}

function addRandomMod({ rng, die }) {
  const types = ['prefix', 'suffix'].filter((type) => hasOpenSlot(die, type));
  if (!types.length) return null;
  const shuffled = types.sort(() => rng() - 0.5);
  for (const type of shuffled) {
    const mod = rollAffix({ rng, die, type, ilvl: die.ilvl });
    if (mod) {
      die.mods.push(mod);
      return mod;
    }
  }
  return null;
}

/**
 * Ваал: 4 равновероятных исхода.
 * 1) мощный Vaal-имплисит, 2) апгрейд случайного мода до T0,
 * 3) реролл в 6 модов, 4) Brick — поломка в слабый кубик с 1–2 модами.
 */
export function applyVaal({ die, rng = createRng(), free = false }) {
  const outcome = randInt(rng, 1, 4);
  die.corrupted = true;
  const base = { die, refunded: free, freeOrb: free, corrupted: true };

  if (outcome === 1) {
    const implicit = pick(rng, VAAL_IMPLICITS.filter(
      (imp) => !(die.vaalImplicits || []).some((existing) => existing.id === imp.id),
    )) || VAAL_IMPLICITS[0];
    die.vaalImplicits = [...(die.vaalImplicits || []), { ...implicit }];
    return {
      ...base,
      ok: true,
      message: `Ваал даровал имплисит: ${implicit.text}`,
      outcome: 'vaal_implicit',
      event: { kind: 'vaal', outcome: 'vaal_implicit', text: implicit.text },
    };
  }

  if (outcome === 2) {
    const candidates = die.mods.filter((m) => m.tier !== 'T0');
    if (candidates.length) {
      const mod = pick(rng, candidates);
      const affix = AFFIXES[mod.affixId];
      mod.tier = 'T0';
      const range = affix.tiers.T0;
      mod.value = randInt(rng, range.min, range.max);
      return {
        ...base,
        ok: true,
        message: `Ваал вознёс «${affix.name}» до [T0]: ${formatModLabel(mod)}`,
        outcome: 'tier_zero',
        event: { kind: 'vaal', outcome: 'tier_zero', tier: 'T0', mod },
      };
    }
    // Fallback — имплисит, если апгрейдить нечего.
    const implicit = pick(rng, VAAL_IMPLICITS);
    die.vaalImplicits = [...(die.vaalImplicits || []), { ...implicit }];
    return {
      ...base,
      ok: true,
      message: `Ваал даровал имплисит: ${implicit.text}`,
      outcome: 'vaal_implicit',
      event: { kind: 'vaal', outcome: 'vaal_implicit', text: implicit.text },
    };
  }

  if (outcome === 3) {
    die.rarity = die.rarity === 'unique' ? 'rare' : die.rarity === 'normal' ? 'rare' : die.rarity;
    die.mods = [];
    if (die.rarity === 'magic') die.rarity = 'rare';
    fillMods({ rng, die, targetMin: 6, targetMax: 6 });
    return {
      ...base,
      ok: true,
      message: `Ваал перековал кубик в 6 случайных модов.`,
      outcome: 'reroll_six',
      event: { kind: 'vaal', outcome: 'reroll_six', topTier: getTopTier(die) },
    };
  }

  // Brick
  die.rarity = 'magic';
  die.mods = [];
  fillMods({ rng, die, targetMin: 1, targetMax: 2 });
  return {
    ...base,
    ok: true,
    message: 'Ваал сломал кубик: осталось лишь 1–2 слабых мода. Brick.',
    outcome: 'brick',
    event: { kind: 'vaal', outcome: 'brick' },
  };
}

/* ─────────────────── Верстак ─────────────────── */

export function getBenchRecipe(recipeId) {
  return BENCH_RECIPES.find((r) => r.id === recipeId) || null;
}

/** Цена рецепта с учётом пассивки generous_bench (−20%). */
export function getBenchCost(recipe, discountPct = 0) {
  if (!recipe) return {};
  const mult = Math.max(0, 1 - discountPct / 100);
  const out = {};
  for (const [orbId, amount] of Object.entries(recipe.cost || {})) {
    out[orbId] = Math.max(1, Math.ceil(amount * mult));
  }
  return out;
}

/**
 * Применяет рецепт верстака. На кубике может быть только 1 крафтовый мод.
 * @returns {{ok:boolean, reason?:string, message:string, die:object}}
 */
export function applyBenchRecipe({ die, recipeId, rng = createRng() }) {
  const recipe = getBenchRecipe(recipeId);
  if (!recipe) return { ok: false, reason: 'Неизвестный рецепт верстака.', die };
  if (!die) return { ok: false, reason: 'Кубик не найден.', die };
  if (die.locked) return { ok: false, reason: 'Кубик заперт.', die };
  if (die.corrupted) return { ok: false, reason: 'Осквернённый кубик нельзя крафтить на верстаке.', die };
  if (die.rarity === 'unique') return { ok: false, reason: 'Уникальные кубики не крафтятся на верстаке.', die };

  const existingCraft = die.mods.find((m) => m.crafted);

  if (recipe.removesCraft) {
    if (!existingCraft) return { ok: false, reason: 'На кубике нет крафтового мода.', die };
    die.mods = die.mods.filter((m) => !m.crafted);
    return { ok: true, message: `Крафтовый мод «${existingCraft.name}» снят.`, die };
  }

  if (die.rarity === 'normal') {
    return { ok: false, reason: 'Сначала сделайте кубик Магическим или Редким.', die };
  }
  if (existingCraft) {
    return { ok: false, reason: 'На кубике уже есть крафтовый мод (только 1 одновременно).', die };
  }

  const affix = AFFIXES[recipe.affixId];
  if (!affix) return { ok: false, reason: 'Аффикс рецепта не найден.', die };
  if (!hasOpenSlot(die, affix.type)) {
    return { ok: false, reason: `Нет свободного слота ${affix.type === 'prefix' ? 'префикса' : 'суффикса'}.`, die };
  }
  if (die.mods.some((m) => m.affixId === affix.id)) {
    return { ok: false, reason: 'Такой мод уже есть на кубике.', die };
  }

  const mod = makeMod({ affix, tier: recipe.tier, value: recipe.value, crafted: true });
  die.mods.push(mod);
  return {
    ok: true,
    message: `Верстак выгравировал: ${formatModLabel(mod)}`,
    die,
    mod,
  };
}

/* ─────────────────── Прочее ─────────────────── */

export function getEquipPowerLabel(power) {
  if (power < 20) return 'Хрупкий';
  if (power < 40) return 'Крепкий';
  if (power < 65) return 'Опасный';
  if (power < 90) return 'Смертоносный';
  return 'Мифический';
}

/** Черновик описания кубика для UI/бота. */
export function describeDie(die) {
  if (!die) return 'Нет кубика';
  const stats = getDieAggregatedStats(die);
  return [
    `${die.icon || '🎲'} ${die.name} (${die.short || stats.faces})`,
    `Редкость: ${RARITY[die.rarity]?.label || die.rarity}`,
    `Моды: ${die.mods.length}`,
    `Качество: ${die.quality}%`,
    die.corrupted ? '🩸 Осквернён' : '',
  ].filter(Boolean).join(' · ');
}

export { RARE_PREFIX_WORDS, RARE_SUFFIX_WORDS };
