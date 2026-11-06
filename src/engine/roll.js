/**
 * PATH OF DICE — engine/roll.js
 * Ежедневный бросок кубика: Lucky, Эхо Броска, криты, групповые ауры,
 * дроп валюты и урон по общему боссу чата.
 */

import {
  CURRENCIES,
  CURRENCY_DISPLAY_ORDER,
  TUNING,
} from './constants.js';
import {
  createRng,
  getDieAggregatedStats,
  pick,
  pickWeighted,
  randInt,
} from './crafting.js';

/**
 * Суммарные ауры всех друзей чата (кроме себя по умолчанию).
 * @returns {{inc:number, crit:number, contributors:string[]}}
 */
export function getPartyAuras(players, { excludeId = null, includeSelf = false } = {}) {
  const result = { inc: 0, crit: 0, contributors: [] };
  if (!Array.isArray(players)) return result;
  for (const player of players) {
    if (!player) continue;
    if (!includeSelf && player.id === excludeId) continue;
    const equipped = player.dice?.find((die) => die.id === player.equippedDieId)
      || player.dice?.[0];
    if (!equipped) continue;
    const stats = getDieAggregatedStats(equipped);
    if (stats.partyAuraInc || stats.partyAuraCrit) {
      result.inc += stats.partyAuraInc;
      result.crit += stats.partyAuraCrit;
      result.contributors.push(player.name || player.id);
    }
  }
  return result;
}

/** Сколько раз кубик «прыгает» от Эха Броска. */
function resolveEchoes(rng, chancePct, maxEchoes = 2) {
  let echoes = 0;
  for (let i = 0; i < maxEchoes; i += 1) {
    if (rng() * 100 < chancePct) echoes += 1;
    else break;
  }
  return echoes;
}

/** Один бросок с учётом minFaceBonus / rerollOnes / maxFaceOverload. */
function rollFace({ rng, stats }) {
  const faces = Math.max(1, stats.faces);
  const floor = Math.min(faces, 1 + Math.floor(stats.minFaceBonus || 0));
  let face = randInt(rng, floor, faces);
  let rerolled = false;

  if (stats.specials?.rerollOnes && face === 1) {
    face = randInt(rng, Math.max(1, floor), faces);
    rerolled = true;
  }
  if (stats.maxFaceOverload > 0 && rng() * 100 < stats.maxFaceOverload) {
    face = faces;
  }
  return {
    face,
    rerolled,
    isMax: face === faces,
    isMin: face === floor,
  };
}

/**
 * Основной расчёт броска.
 * @param {object} params
 * @param {object} params.die     экипированный кубик
 * @param {Function} [params.rng]
 * @param {{inc:number,crit:number}} [params.partyAuras]
 * @param {object} [params.buffs] { scoreBonus, critBonus, extraInc, charges }
 * @param {object} [params.modifiers] { noLucky, doubleOrbs, rarityPct, quantityPct, lowFacePenalty, forcedLucky }
 * @param {number} [params.bossKills] для уникального Headhunter
 */
export function rollDailyDie({
  die,
  rng = createRng(),
  partyAuras = { inc: 0, crit: 0 },
  buffs = {},
  modifiers = {},
  bossKills = 0,
} = {}) {
  if (!die) throw new Error('Не выбран кубик для броска.');

  const stats = getDieAggregatedStats(die);
  const faces = Math.max(1, stats.faces);
  const events = [];

  /* ── Lucky: бросок дважды, берётся лучший ── */
  const luckyChance = modifiers.noLucky ? 0 : Math.min(100, stats.luckyChance || 0)
    + (modifiers.forcedLucky ? 100 : 0)
    + (buffs.critBonus ? 0 : 0);
  const lucky = rng() * 100 < luckyChance;

  let primary = rollFace({ rng, stats });
  let alternate = null;
  if (lucky) {
    alternate = rollFace({ rng, stats });
    if (alternate.face > primary.face) {
      primary = alternate;
      events.push({ kind: 'lucky', text: 'Lucky: взят лучший из двух бросков' });
    } else {
      events.push({ kind: 'lucky', text: 'Lucky: лучшим остался первый бросок' });
    }
  }

  let firstFace = primary.face;
  if (modifiers.lowFacePenalty && firstFace < 3) {
    firstFace = Math.max(1, firstFace - 1);
    events.push({ kind: 'penalty', text: 'Зеркальная карта: низкая грань −1' });
  }

  /* ── Удвоение первой грани ── */
  let doubled = false;
  if (stats.doubleFirstFace > 0 && rng() * 100 < stats.doubleFirstFace) {
    firstFace *= 2;
    doubled = true;
    events.push({ kind: 'double', text: `Первая грань удвоена: ${firstFace}` });
  }

  /* ── Эхо Броска ── */
  const echoChance = Math.min(100, stats.multistrikeChance || 0);
  const echoes = resolveEchoes(rng, echoChance);
  const echoFaces = [];
  for (let i = 0; i < echoes; i += 1) {
    const echo = rollFace({ rng, stats });
    echoFaces.push(echo.face);
  }
  if (echoes > 0) {
    events.push({ kind: 'echo', text: `Эхо Броска x${echoes}: ${echoFaces.join(' + ')}` });
  }

  const sumFaces = firstFace + echoFaces.reduce((a, b) => a + b, 0);

  /* ── Бонусы ── */
  const buffFlat = Number(buffs.scoreBonus) || 0;
  const flatAdd = (stats.flatAdd || 0) + buffFlat;
  const partyInc = modifiers.ignorePartyAura ? 0 : Number(partyAuras.inc) || 0;
  const incPct = (stats.incScore || 0) + partyInc + (Number(buffs.extraInc) || 0)
    + (Number(modifiers.incScorePct) || 0);
  const morePct = stats.moreDamagePct || 0;

  const rawScore = TUNING.rollScoreBase + sumFaces + flatAdd;
  const scoreBeforeCrit = Math.max(1, Math.round(rawScore * (1 + incPct / 100) * (1 + morePct / 100)));

  /* ── Критический удар ── */
  // Аура пати — «+N% шанса крита» плоским значением, как и написано в описании мода.
  const critChanceBase = modifiers.ignoreCrit ? 0 : stats.baseCrit;
  const critChancePct = critChanceBase * (1 + (stats.critChance || 0) / 100)
    + (Number(partyAuras.crit) || 0)
    + (Number(modifiers.flatCrit) || 0)
    + (Number(buffs.critBonus) || 0);
  const critRoll = rng() * 100;
  const isCrit = critRoll < critChancePct;
  const critMultiPct = stats.critMultiTotal || 150;
  const critMult = isCrit ? critMultiPct / 100 : 1;

  if (isCrit) events.push({ kind: 'crit', text: `КРИТ! x${(critMult).toFixed(2)}` });

  const score = Math.max(1, Math.round(scoreBeforeCrit * critMult));

  /* ── Урон по боссу ── */
  const bossBonus = 1 + (stats.bossDamagePct || 0) / 100;
  const headhunterBonus = stats.specials?.headhunter
    ? 1 + Math.min(40, (bossKills || 0) * 2) / 100
    : 1;
  const damage = Math.max(1, Math.round(score * bossBonus * headhunterBonus));

  /* ── Дроп валюты ── */
  const orbCount = Math.min(
    12,
    randInt(rng, 2, 5) + Math.floor(stats.extraOrbs || 0) + (modifiers.extraOrbs || 0),
  );
  const rarityPct = (stats.rarityPct || 0) + (modifiers.rarityPct || 0);
  const quantityPct = (modifiers.quantityPct || 0);
  const orbs = rollOrbDrop({
    rng,
    count: orbCount,
    rarityPct,
    quantityPct,
    doubleOrbs: Boolean(modifiers.doubleOrbs),
    dupeChance: stats.orbDupeChance || 0,
  });

  return {
    dieId: die.id,
    dieName: die.name,
    baseId: die.baseId,
    faces,
    primaryFace: primary.face,
    firstFace,
    echoFaces,
    echoes,
    lucky,
    luckyAlternate: alternate ? alternate.face : null,
    doubled,
    rerolled: primary.rerolled,
    isMaxFace: firstFace >= faces,
    crit: isCrit,
    critChancePct: Math.round(critChancePct * 10) / 10,
    critMultiPct,
    sumFaces,
    flatAdd,
    incPct: Math.round(incPct * 10) / 10,
    morePct,
    partyInc,
    score,
    scoreBeforeCrit,
    damage,
    orbs,
    orbTotal: orbs.reduce((sum, orb) => sum + orb.count, 0),
    events,
    rolledAt: Date.now(),
  };
}

/** Мешок валюты с весами и редкостью. */
export function rollOrbDrop({
  rng = createRng(),
  count = 3,
  rarityPct = 0,
  quantityPct = 0,
  doubleOrbs = false,
  dupeChance = 0,
  allowedIds = CURRENCY_DISPLAY_ORDER,
} = {}) {
  const pool = allowedIds.map((id) => CURRENCIES[id]).filter(Boolean);
  const bag = new Map();
  const totalCount = Math.max(
    1,
    Math.round(count * (1 + quantityPct / 100) * (doubleOrbs ? 2 : 1)),
  );

  for (let i = 0; i < totalCount; i += 1) {
    const orb = pickWeighted(rng, pool, (entry) =>
      entry.weight * (1 + (rarityPct / 100) * entry.rarityBoost * TUNING.orbWeightRarityFactor));
    if (!orb) continue;
    bag.set(orb.id, (bag.get(orb.id) || 0) + 1);
  }

  if (dupeChance > 0 && rng() * 100 < dupeChance) {
    const target = pick(rng, [...bag.entries()]);
    if (target) bag.set(target[0], bag.get(target[0]) + target[1]);
  }

  return [...bag.entries()]
    .map(([id, amount]) => ({ id, count: amount, ...CURRENCIES[id] }))
    .sort((a, b) => CURRENCY_DISPLAY_ORDER.indexOf(a.id) - CURRENCY_DISPLAY_ORDER.indexOf(b.id));
}

/**
 * Наносит урон боссу, учитывая Culling Strike и щиты.
 * @param {object} boss { hp, maxHp }
 * @param {number} damage
 * @param {{culling?:number, rng?:Function, shieldReduction?:number, shieldActive?:boolean}} opts
 */
export function applyBossDamage(boss, damage, opts = {}) {
  const { culling = 0, rng = createRng(), shieldActive = false, shieldReduction = 0 } = opts;
  if (!boss) return { applied: 0, killed: false, culled: false };
  const incoming = Math.max(1, Math.round(damage * (shieldActive ? 1 - shieldReduction : 1)));
  const before = boss.hp;
  boss.hp = Math.max(0, boss.hp - incoming);
  const killed = boss.hp <= 0;
  const threshold = boss.maxHp * 0.05;
  const culled = !killed && culling > 0 && boss.hp <= threshold && rng() * 100 < culling;
  // Culling Strike добивает цель независимо от того, сколько урона «не хватило».
  if (culled) boss.hp = 0;
  return {
    applied: before - boss.hp,
    killed: killed || culled,
    culled,
    hp: boss.hp,
    maxHp: boss.maxHp,
  };
}

export function formatRollSummary(result) {
  if (!result) return '';
  const parts = [`${result.dieName}: ${result.sumFaces} граней`];
  if (result.echoes) parts.push(`Эхо x${result.echoes}`);
  if (result.crit) parts.push(`КРИТ x${(result.critMultiPct / 100).toFixed(2)}`);
  parts.push(`${result.score} очков`);
  if (result.orbs.length) {
    parts.push(result.orbs.map((o) => `${o.icon}${o.count}`).join(' '));
  }
  return parts.join(' · ');
}

export function getNewBoss({ level = 1, rng = createRng() } = {}) {
  const names = [
    ['Отрекшийся Надвигатель', '👹'],
    ['Костяной Мясник', '💀'],
    ['Мать Выводка', '🕷️'],
    ['Хранитель Пепла', '🔥'],
    ['Владыка Бездны', '🌑'],
    ['Тёмный Изгнанник', '🗡️'],
    ['Аватар Пустоты', '🌀'],
  ];
  const [name, icon] = pick(rng, names);
  const maxHp = Math.round(420 + level * 80 + rng() * 120);
  return {
    name,
    icon,
    level,
    maxHp,
    hp: maxHp,
    spawnedAt: Date.now(),
    defeatedAt: null,
    nextLevel: level + 1,
  };
}
