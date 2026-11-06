/**
 * PATH OF DICE — engine/mapCombat.js
 * Поход по карте: генерация графа развилок (DAG) + пошаговый тактический бой
 * на боевых узлах и с боссом карты.
 */

import {
  BOSS_INTENTS,
  BOSS_INTENT_MAP,
  COMBAT_ACTIONS,
  CURRENCIES,
  MAP_BATTLE_ORBS,
  MAP_COMBAT_CONFIG,
  MAP_NODE_TYPES,
  MAP_ZONES,
  RARITY,
} from './constants.js';
import {
  createRng,
  estimateDiePower,
  getDieAggregatedStats,
  pick,
  pickWeighted,
  randInt,
  uid,
} from './crafting.js';
import { getMapModifiers, grantMapVictory } from './atlas.js';
import { rollOrbDrop } from './roll.js';

export const RUN_PHASES = Object.freeze({
  navigation: 'navigation',
  combat: 'combat',
  victory: 'victory',
  defeat: 'defeat',
  retreat: 'retreat',
});

const INTERMEDIATE_WEIGHTS = Object.freeze({
  pack: 42,
  elite: 17,
  chest: 15,
  shrine: 13,
  ambush: 13,
});

/* ────────────────────────── ГРАФ ────────────────────────── */

export function getLayerCount(tier) {
  if (tier <= 5) return 4;
  if (tier <= 11) return 5;
  return 6;
}

/**
 * Строит DAG карты: вход → промежуточные ярусы с развилками → босс.
 * Гарантирует связность: у каждого узла следующего яруса есть входящее ребро.
 */
export function buildMapGraph({ tier = 1, rng = createRng(), modifiers = {} } = {}) {
  const layersCount = getLayerCount(tier);
  const nodes = [];
  const layerIds = [];

  const addNode = (node) => {
    nodes.push(node);
    return node;
  };

  /* Ярус 0 — вход */
  const entry = addNode({
    id: uid('node'),
    layer: 0,
    slot: 0,
    type: 'entrance',
    ...MAP_NODE_TYPES.entrance,
    nextIds: [],
    visited: true,
    resolved: true,
    x: 50,
    y: 0,
  });
  layerIds.push([entry.id]);

  /* Промежуточные ярусы */
  for (let layer = 1; layer <= layersCount - 2; layer += 1) {
    const count = randInt(rng, 2, 3);
    const ids = [];
    for (let slot = 0; slot < count; slot += 1) {
      const typeId = pickWeighted(
        rng,
        Object.keys(INTERMEDIATE_WEIGHTS).map((id) => ({ id, weight: INTERMEDIATE_WEIGHTS[id] })),
        (entryItem) => entryItem.weight,
      ).id;
      const def = MAP_NODE_TYPES[typeId];
      const node = addNode({
        id: uid('node'),
        layer,
        slot,
        type: typeId,
        name: def.name,
        icon: def.icon,
        combat: def.combat,
        color: def.color,
        nextIds: [],
        visited: false,
        resolved: false,
        x: count === 1 ? 50 : 20 + (60 * slot) / (count - 1),
        y: layer,
      });
      ids.push(node.id);
    }
    layerIds.push(ids);
  }

  /* Финальный ярус — босс */
  const bossDef = MAP_NODE_TYPES.boss;
  const boss = addNode({
    id: uid('node'),
    layer: layersCount - 1,
    slot: 0,
    type: 'boss',
    name: bossDef.name,
    icon: bossDef.icon,
    combat: true,
    color: bossDef.color,
    nextIds: [],
    visited: false,
    resolved: false,
    x: 50,
    y: layersCount - 1,
  });
  layerIds.push([boss.id]);

  /* Рёбра: каждый узел → 1–2 узла следующего яруса; без «сирот». */
  for (let layer = 0; layer < layerIds.length - 1; layer += 1) {
    const current = layerIds[layer];
    const next = layerIds[layer + 1];
    const incoming = new Map(next.map((id) => [id, 0]));

    for (const nodeId of current) {
      const node = nodes.find((n) => n.id === nodeId);
      const linksCount = Math.min(next.length, randInt(rng, 1, 2));
      const shuffled = [...next].sort(() => rng() - 0.5);
      const targets = shuffled.slice(0, linksCount);
      // Если это последний промежуточный ярус — все ведут к боссу.
      for (const target of targets) {
        if (!node.nextIds.includes(target)) node.nextIds.push(target);
        incoming.set(target, incoming.get(target) + 1);
      }
    }

    // Гарантируем входящие рёбра для каждого узла следующего яруса.
    // Источник выбираем среди узлов с наименьшим числом исходящих рёбер,
    // чтобы развилки оставались читаемыми (1–2 связи на узел).
    for (const targetId of next) {
      if ((incoming.get(targetId) || 0) > 0) continue;
      const candidates = current
        .map((id) => nodes.find((n) => n.id === id))
        .filter(Boolean)
        .filter((node) => !node.nextIds.includes(targetId))
        .sort((a, b) => a.nextIds.length - b.nextIds.length);
      if (!candidates.length) continue;
      const minLinks = candidates[0].nextIds.length;
      const pool = candidates.filter((node) => node.nextIds.length === minLinks);
      const sourceNode = pick(rng, pool);
      sourceNode.nextIds.push(targetId);
      incoming.set(targetId, 1);
    }
  }

  // Упорядочим nextIds слева-направо для предсказуемого UI.
  for (const node of nodes) {
    node.nextIds.sort((a, b) => {
      const na = nodes.find((n) => n.id === a);
      const nb = nodes.find((n) => n.id === b);
      return (na?.slot ?? 0) - (nb?.slot ?? 0);
    });
  }

  const graph = {
    nodes,
    layers: layerIds,
    entryId: entry.id,
    bossId: boss.id,
    layerCount: layersCount,
    tier,
    seed: Math.floor(rng() * 1e9),
    modifiers,
  };
  return graph;
}

export function getNode(graph, nodeId) {
  return graph?.nodes?.find((n) => n.id === nodeId) || null;
}

export function availableNodeIds(run) {
  if (!run || run.phase !== RUN_PHASES.navigation) return [];
  const node = getNode(run.graph, run.currentNodeId);
  if (!node) return [];
  return node.nextIds.filter((id) => {
    const target = getNode(run.graph, id);
    return target && !target.visited;
  });
}

export function getAvailableNodes(run) {
  return availableNodeIds(run).map((id) => getNode(run.graph, id)).filter(Boolean);
}

/* ────────────────────────── ПОХОД ────────────────────────── */

export function computeRunMaxHp(die, modifiers = {}) {
  const stats = getDieAggregatedStats(die);
  const power = estimateDiePower(die);
  const base = Math.min(
    MAP_COMBAT_CONFIG.hpCap,
    MAP_COMBAT_CONFIG.hpBase
      + Math.floor(power / MAP_COMBAT_CONFIG.hpFromPower)
      + (stats.maxHpFlat || 0),
  );
  const bonus = modifiers.hpBonus || 0;
  return Math.max(6, base + bonus);
}

export function createEnemyForNode({ tier, nodeType, rng = createRng(), modifiers = {} }) {
  const def = MAP_NODE_TYPES[nodeType] || MAP_NODE_TYPES.pack;
  const isElite = nodeType === 'elite';
  const monsterMult = modifiers.monsterMult || 1;

  if (nodeType === 'boss') {
    const zone = MAP_ZONES[Math.max(0, Math.min(15, tier - 1))];
    const faces = 6 + Math.floor(tier / 5);
    const hp = Math.round((MAP_COMBAT_CONFIG.bossHpBase + tier * MAP_COMBAT_CONFIG.bossHpPerTier)
      * (modifiers.bossHpMult || 1));
    return {
      id: uid('enemy'),
      kind: 'boss',
      nodeId: null,
      name: zone.boss,
      icon: '👹',
      hp,
      maxHp: hp,
      faces,
      bonus: 0,
      round: 1,
      shield: { active: false, hitsLeft: 0 },
      enraged: false,
      intent: null,
      intentBonus: modifiers.bossIntentBonus || 0,
      tiersCrossed: [],
      isBoss: true,
    };
  }

  let faces = 6;
  if (tier >= 11 && tier <= 15) faces = 8;
  else if (tier >= 16) faces = 12;
  if (isElite) faces += 1;

  const hpBase = MAP_COMBAT_CONFIG.enemyHpBase + tier * MAP_COMBAT_CONFIG.enemyHpPerTier;
  let hp = Math.round((hpBase + rng() * MAP_COMBAT_CONFIG.enemyHpJitter) * monsterMult);
  if (isElite) hp = Math.round(hp * MAP_COMBAT_CONFIG.eliteHpMult);

  const names = {
    pack: ['Стая обречённых', 'Пак скелетов', 'Рой паразитов', 'Отряд мародёров'],
    elite: ['Элитный Редкий Пак', 'Проклятый Вожак', 'Кровавый Чемпион'],
    ambush: ['Разлом Пустоты', 'Засада Изгнанника', 'Тень Разлома'],
  };
  const name = pick(rng, names[nodeType] || names.pack);

  return {
    id: uid('enemy'),
    kind: nodeType,
    nodeId: null,
    name,
    icon: def.icon,
    hp,
    maxHp: hp,
    faces,
    bonus: isElite ? 1 : 0,
    round: 1,
    shield: { active: false, hitsLeft: 0 },
    enraged: false,
    intent: null,
    intentBonus: modifiers.bossIntentBonus || 0,
    isBoss: false,
  };
}

export function startRun({
  player,
  map,
  partner = null,
  rng = createRng(),
  modifiers = null,
}) {
  const tier = map?.tier || 1;
  const mapMods = modifiers || getMapModifiers(map);
  const graph = buildMapGraph({ tier, rng, modifiers: mapMods });
  const die = (player.dice || []).find((d) => d.id === player.equippedDieId) || player.dice?.[0] || null;
  const maxHp = computeRunMaxHp(die, mapMods);

  const run = {
    id: uid('run'),
    playerId: player.id,
    partnerId: partner?.id || null,
    ally: partner
      ? {
        id: partner.id,
        name: partner.name,
        power: estimateDiePower(
          (partner.dice || []).find((d) => d.id === partner.equippedDieId) || partner.dice?.[0],
        ),
      }
      : null,
    map: {
      id: map?.id || null,
      tier,
      name: map?.name || MAP_ZONES[tier - 1].name,
      icon: map?.icon || MAP_ZONES[tier - 1].icon,
      rarity: map?.rarity || 'normal',
      mods: [...(map?.mods || [])],
      quality: map?.quality || 0,
      corrupted: Boolean(map?.corrupted),
      bossName: map?.bossName || MAP_ZONES[tier - 1].boss,
    },
    tier,
    modifiers: mapMods,
    graph,
    currentNodeId: graph.entryId,
    phase: RUN_PHASES.navigation,
    hp: maxHp,
    maxHp,
    buffs: { scoreBonus: 0 },
    enemy: null,
    log: [
      {
        at: Date.now(),
        kind: 'enter',
        text: `🚪 Вы вошли в карту T${tier} «${run_name(map, tier)}». HP: ${maxHp}/${maxHp}.`,
      },
    ],
    loot: {},
    lootLog: [],
    combos: 0,
    bestCombo: 0,
    turns: 0,
    nodesCleared: 0,
    startedAt: Date.now(),
    finishedAt: null,
    report: null,
    lastTurn: null,
  };
  return run;
}

function run_name(map, tier) {
  return map?.name || MAP_ZONES[tier - 1]?.name || `Карта T${tier}`;
}

function pushLog(run, text, kind = 'info') {
  run.log.push({ at: Date.now(), kind, text });
  if (run.log.length > 120) run.log = run.log.slice(-120);
}

function addLoot(run, orbs) {
  for (const orb of orbs) {
    run.loot[orb.id] = (run.loot[orb.id] || 0) + orb.count;
  }
  run.lootLog.push(...orbs);
}

/* ────────────────────────── ВЫБОР УЗЛА ────────────────────────── */

/**
 * Переход по развилке. Мирные узлы срабатывают сразу, боевые запускают бой.
 */
export function chooseMapNode({ run, player, nodeId, rng = createRng() }) {
  if (!run) return { ok: false, reason: 'Поход не найден.' };
  if (run.phase !== RUN_PHASES.navigation) {
    return { ok: false, reason: 'Сейчас идёт бой — выберите действие.' };
  }
  const available = availableNodeIds(run);
  if (!available.includes(nodeId)) {
    return { ok: false, reason: 'В этот узел нельзя перейти с текущей развилки.' };
  }
  const node = getNode(run.graph, nodeId);
  const current = getNode(run.graph, run.currentNodeId);
  run.currentNodeId = node.id;
  node.visited = true;
  node.clearedAt = Date.now();
  pushLog(run, `${node.icon} Переход: ${current?.name || 'узел'} → ${node.name}.`, 'move');

  if (!node.combat) {
    const effect = resolvePeacefulNode({ run, player, node, rng });
    node.resolved = true;
    return {
      ok: true,
      peaceful: true,
      node,
      effect,
      phase: run.phase,
      availableNodeIds: availableNodeIds(run),
    };
  }

  const enemy = createEnemyForNode({
    tier: run.tier,
    nodeType: node.type,
    rng,
    modifiers: run.modifiers,
  });
  enemy.nodeId = node.id;

  // Особенность узла «Разлом»: проверка кубика перед схваткой.
  if (node.type === 'ambush') {
    const check = resolveAmbushCheck({ run, player, rng });
    enemy.bonus += check.enemyBonus || 0;
    if (!check.ok) {
      run.hp = Math.max(1, run.hp - MAP_COMBAT_CONFIG.ambushFailHpLoss);
    }
  }

  // Ветра Ваала: бой может начаться с −1 HP.
  if (run.modifiers.vaalWinds && rng() < 0.5) {
    run.hp = Math.max(1, run.hp - 1);
    pushLog(run, '🌪️ Ветра Ваала отнимают 1 HP на входе в бой.', 'danger');
  }

  if (enemy.isBoss) prepareBossIntent(enemy, rng, run.modifiers);
  run.enemy = enemy;
  run.phase = RUN_PHASES.combat;
  run.lastTurn = null;
  pushLog(
    run,
    `⚔️ Бой с ${enemy.name} (${enemy.hp} HP, D${enemy.faces}${enemy.bonus ? ` +${enemy.bonus}` : ''}).`,
    'combat',
  );

  return {
    ok: true,
    peaceful: false,
    node,
    enemy: publicEnemy(enemy),
    phase: run.phase,
    availableNodeIds: [],
    ambushCheck: node.type === 'ambush' ? run.log[run.log.length - 1] : null,
  };
}

function resolveAmbushCheck({ run, player, rng }) {
  const die = (player?.dice || []).find((d) => d.id === player.equippedDieId) || player?.dice?.[0];
  const stats = getDieAggregatedStats(die);
  const face = randInt(rng, 1, Math.max(1, stats.faces || 6));
  const need = Math.ceil((stats.faces || 6) / 2);
  const ok = face >= need;
  pushLog(
    run,
    ok
      ? `🎲 Проверка Разлома: ${face} ≥ ${need} — успех, враг застигнут врасплох.`
      : `🎲 Проверка Разлома: ${face} < ${need} — провал, −${MAP_COMBAT_CONFIG.ambushFailHpLoss} HP и враг сильнее.`,
    ok ? 'good' : 'danger',
  );
  return { ok, face, need, enemyBonus: ok ? 0 : 1 };
}

function resolvePeacefulNode({ run, player, node, rng }) {
  if (node.type === 'chest') {
    if (rng() < 0.3) {
      const bonusMap = { id: uid('map'), tier: run.tier, name: MAP_ZONES[run.tier - 1].name };
      run.bonusMaps = run.bonusMaps || [];
      run.bonusMaps.push(bonusMap);
      pushLog(run, `🗺️ В ларце карта T${run.tier}!`, 'good');
      return { kind: 'chest', bonusMap };
    }
    const count = randInt(rng, MAP_COMBAT_CONFIG.chestOrbsMin, MAP_COMBAT_CONFIG.chestOrbsMax);
    const orbs = rollOrbDrop({
      rng,
      count,
      rarityPct: (run.modifiers.rarityPct || 0) + 25,
      quantityPct: run.modifiers.quantityPct || 0,
      doubleOrbs: run.modifiers.doubleOrbs,
    });
    addLoot(run, orbs);
    pushLog(run, `💰 Ларец: ${orbs.map((o) => `${o.icon}${o.count}`).join(' ') || 'пусто'}.`, 'good');
    return { kind: 'chest', orbs };
  }

  if (node.type === 'shrine') {
    const heal = MAP_COMBAT_CONFIG.shrineHeal;
    const buff = MAP_COMBAT_CONFIG.shrineBuffScore;
    if (run.hp < run.maxHp) {
      const healed = Math.min(heal, run.maxHp - run.hp);
      run.hp += healed;
      pushLog(run, `⛩️ Святилище Предков: +${healed} HP.`, 'good');
      return { kind: 'shrine', mode: 'heal', healed };
    }
    run.buffs.scoreBonus = (run.buffs.scoreBonus || 0) + buff;
    pushLog(run, `⛩️ Святилище Предков: +${buff} к броску до конца похода.`, 'good');
    return { kind: 'shrine', mode: 'buff', scoreBonus: buff };
  }

  pushLog(run, `${node.icon} Узел ${node.name} не содержит угрозы.`, 'info');
  return { kind: node.type };
}

/* ────────────────────────── БОЙ ────────────────────────── */

function prepareBossIntent(enemy, rng, modifiers = {}) {
  const intent = pick(rng, BOSS_INTENTS);
  enemy.intent = {
    ...intent,
    enemyScore: intent.enemyScore + (modifiers.bossIntentBonus || 0),
  };
  return enemy.intent;
}

export function getPowerBonus(power) {
  return Math.min(5, Math.floor((power || 0) / 4));
}

function orbEffectFor(orbId) {
  const orb = MAP_BATTLE_ORBS[orbId];
  if (!orb) return null;
  return orb;
}

/**
 * Разрешает один раунд боя на узле.
 */
export function resolveMapTurn({
  run,
  player,
  action = 'attack',
  orbId = null,
  rng = createRng(),
}) {
  if (!run) return { ok: false, reason: 'Поход не найден.' };
  if (run.phase !== RUN_PHASES.combat || !run.enemy) {
    return { ok: false, reason: 'Сейчас нет активного боя.' };
  }
  const act = COMBAT_ACTIONS[action];
  if (!act) return { ok: false, reason: 'Неизвестное действие.' };

  const enemy = run.enemy;
  let orb = null;
  if (orbId) {
    orb = orbEffectFor(orbId);
    if (!orb) return { ok: false, reason: 'Неизвестная боевая сфера.' };
    if ((player.inventory?.[orbId] || 0) < orb.cost) {
      return { ok: false, reason: `Нет ${CURRENCIES[orbId]?.name || orbId} в тайнике.` };
    }
  }

  const die = (player.dice || []).find((d) => d.id === player.equippedDieId) || player.dice?.[0];
  const stats = getDieAggregatedStats(die);
  const power = estimateDiePower(die);

  const orbFx = {
    score: 0,
    enemyScore: 0,
    damageMult: 1,
    heal: 0,
    stripShield: false,
    enemyFaceOne: false,
    guaranteedCrit: false,
    selfDamage: 0,
  };

  if (orb) {
    player.inventory[orbId] = Math.max(0, (player.inventory[orbId] || 0) - orb.cost);
    switch (orb.effect) {
      case 'heal':
        orbFx.heal = orb.value;
        run.hp = Math.min(run.maxHp, run.hp + orb.value);
        break;
      case 'score':
        orbFx.score += orb.value;
        break;
      case 'damageMult':
        orbFx.damageMult *= orb.value;
        break;
      case 'enemyScore':
        orbFx.enemyScore += orb.value;
        break;
      case 'stripShield':
        orbFx.stripShield = true;
        break;
      case 'enemyFaceOne':
        orbFx.enemyFaceOne = true;
        break;
      case 'guaranteedCrit':
        orbFx.guaranteedCrit = true;
        break;
      case 'vaal':
        orbFx.damageMult *= orb.value;
        orbFx.selfDamage = 2;
        run.hp = Math.max(1, run.hp - 2);
        break;
      default:
        break;
    }
  }

  /* ── Игрок ── */
  const faces = Math.max(1, stats.faces);
  const minFace = Math.min(faces, 1 + Math.floor(stats.minFaceBonus || 0));
  let playerFace = randInt(rng, minFace, faces);
  if (stats.specials?.rerollOnes && playerFace === 1) {
    playerFace = randInt(rng, minFace, faces);
  }
  if (stats.maxFaceOverload > 0 && rng() * 100 < stats.maxFaceOverload) playerFace = faces;
  if (run.modifiers.lowFacePenalty && playerFace < 3) playerFace = Math.max(1, playerFace - 1);
  if (orbFx.enemyFaceOne) {
    // хаос-сфера действует на врага, но запомним флаг
  }

  const powerBonus = getPowerBonus(power);
  const allySupport = run.ally ? Math.min(3, Math.floor((run.ally.power || 0) / 12)) : 0;
  const orbScore = orbFx.score;
  const buffScore = run.buffs?.scoreBonus || 0;
  const playerScore = playerFace + act.score + orbScore + powerBonus + buffScore + allySupport;

  /* ── Враг ── */
  let enemyFace = randInt(rng, 1, Math.max(1, enemy.faces));
  if (orbFx.enemyFaceOne) enemyFace = 1;
  const intent = enemy.intent || null;
  const enemyCritChance = run.modifiers.enemyCritBonus || 0;
  const enemyCrit = enemyCritChance > 0 && rng() * 100 < enemyCritChance;
  const enemyScore = Math.max(
    1,
    enemyFace + (enemy.bonus || 0) + (intent?.enemyScore || 0)
      + (enemy.enraged ? 2 : 0) + orbFx.enemyScore + (enemyCrit ? 1 : 0),
  );

  const won = playerScore > enemyScore;
  const diff = Math.abs(playerScore - enemyScore);
  const critChance = stats.baseCrit * (1 + (stats.critChance || 0) / 100)
    + (run.modifiers.critChance || 0);
  const crit = orbFx.guaranteedCrit || rng() * 100 < critChance;
  const critMult = crit ? (stats.critMultiTotal || 150) / 100 : 1;

  const turn = {
    round: enemy.round,
    nodeId: enemy.nodeId,
    enemyName: enemy.name,
    playerFace,
    enemyFace,
    playerScore,
    enemyScore,
    won,
    crit,
    powerBonus,
    allySupport,
    intent: intent ? { id: intent.id, name: intent.name, icon: intent.icon } : null,
    orb: orb ? { id: orb.id, name: orb.name, icon: orb.icon } : null,
    shieldBlocked: false,
    damage: 0,
    hpLoss: 0,
    enemyHpAfter: enemy.hp,
    playerHpAfter: run.hp,
    text: '',
    at: Date.now(),
  };

  if (won) {
    run.combos += 1;
    run.bestCombo = Math.max(run.bestCombo, run.combos);
    run.turns += 1;
    let damage = Math.round(playerScore * 1.8 * act.damageMult * orbFx.damageMult * critMult);
    // Модификатор намерения босса уменьшает входящий урон (глухая защита).
    if (intent?.damageTakenMult && intent.damageTakenMult < 1) {
      damage = Math.round(damage * intent.damageTakenMult);
    }
    if (enemy.shield?.active) {
      damage = Math.round(damage * (1 - MAP_COMBAT_CONFIG.bossShieldReduction));
      enemy.shield.hitsLeft = Math.max(0, enemy.shield.hitsLeft - 1);
      turn.shieldBlocked = true;
      if (enemy.shield.hitsLeft === 0) {
        enemy.shield.active = false;
        pushLog(run, '🛡️ Щит босса сбит!', 'good');
      }
    }
    if (orbFx.stripShield && enemy.shield?.active) {
      enemy.shield.active = false;
      enemy.shield.hitsLeft = 0;
      pushLog(run, '🧼 Скоуринг сбил Щит Пустоты!', 'good');
    }
    damage = Math.max(1, damage);
    enemy.hp = Math.max(0, enemy.hp - damage);
    turn.damage = damage;
    turn.enemyHpAfter = enemy.hp;

    // Вампиризм Ваал-имплисита.
    if (stats.vaalBlood && rng() * 100 < stats.vaalBlood) {
      run.hp = Math.min(run.maxHp, run.hp + 1);
    }
    pushLog(
      run,
      `${crit ? '💥 КРИТ ' : ''}Раунд ${turn.round}: ${playerScore} vs ${enemyScore} — ${damage} урона по ${enemy.name} (${enemy.hp}/${enemy.maxHp} HP).`,
      'good',
    );
  } else {
    run.combos = 0;
    run.turns += 1;
    const rawLoss = Math.min(
      5,
      Math.max(1, 1 + Math.floor(diff / 3)),
    );
    let hpLoss = Math.round(rawLoss * act.incomingMult)
      + (act.extraLossOnLose || 0)
      + (intent?.extraLoss || 0);
    hpLoss = Math.max(1, hpLoss);
    run.hp = Math.max(0, run.hp - hpLoss);
    turn.hpLoss = hpLoss;
    turn.playerHpAfter = run.hp;
    pushLog(
      run,
      `Раунд ${turn.round}: ${playerScore} vs ${enemyScore} — провал, −${hpLoss} HP (${run.hp}/${run.maxHp}).`,
      'danger',
    );
  }

  turn.text = won
    ? `Победа в раунде: −${turn.damage} HP врагу`
    : `Поражение в раунде: −${turn.hpLoss} HP вам`;

  enemy.round += 1;
  run.lastTurn = turn;

  let nodeCleared = false;
  let runFinished = false;

  /* ── Смерть врага ── */
  if (enemy.hp <= 0) {
    nodeCleared = true;
    const rewards = resolveCombatVictory({ run, player, enemy, rng });
    turn.rewards = rewards;
    const node = getNode(run.graph, run.currentNodeId);
    if (node) node.resolved = true;
    run.nodesCleared += 1;
    run.enemy = null;
    if (enemy.isBoss) {
      run.phase = RUN_PHASES.victory;
      runFinished = true;
      finishRun({ run, player, rng, outcome: 'victory' });
    } else {
      run.phase = RUN_PHASES.navigation;
    }
  } else if (run.hp <= 0) {
    run.phase = RUN_PHASES.defeat;
    runFinished = true;
    finishRun({ run, player, rng, outcome: 'defeat' });
  } else if (enemy.isBoss) {
    // Новая фаза щита и новый телеграф.
    const hpPct = (enemy.hp / enemy.maxHp) * 100;
    for (const threshold of MAP_COMBAT_CONFIG.bossShieldThresholds) {
      if (hpPct <= threshold && !enemy.tiersCrossed.includes(threshold)) {
        enemy.tiersCrossed.push(threshold);
        enemy.shield = {
          active: true,
          hitsLeft: MAP_COMBAT_CONFIG.bossShieldHits,
        };
        pushLog(run, `🛡️ Босс поднял Щит (${threshold}% HP) — держится 2 удара.`, 'danger');
      }
    }
    if (hpPct <= MAP_COMBAT_CONFIG.bossEnrageHpPct && !enemy.enraged) {
      enemy.enraged = true;
      pushLog(run, '💢 Босс впал в Ярость: +2 к его броску!', 'danger');
    }
    prepareBossIntent(enemy, rng, run.modifiers);
  }

  return {
    ok: true,
    turn,
    won,
    enemy: run.enemy ? publicEnemy(run.enemy) : null,
    playerHp: run.hp,
    playerMaxHp: run.maxHp,
    phase: run.phase,
    nodeCleared,
    runFinished,
    availableNodeIds: availableNodeIds(run),
    log: run.log.slice(-6),
  };
}

function resolveCombatVictory({ run, player, enemy, rng }) {
  const rarityBoost = run.modifiers.rarityPct || 0;
  const results = { orbs: [], map: null, fragment: null, heal: 0, scoreBonus: 0 };

  if (enemy.kind === 'elite') {
    const orbs = rollOrbDrop({
      rng,
      count: randInt(rng, 4, 6),
      rarityPct: rarityBoost + 65,
      quantityPct: (run.modifiers.quantityPct || 0) + 40,
      doubleOrbs: run.modifiers.doubleOrbs,
    });
    addLoot(run, orbs);
    results.orbs = orbs;
    const heal = Math.min(MAP_COMBAT_CONFIG.eliteHealOnWin, run.maxHp - run.hp);
    run.hp += heal;
    results.heal = heal;
    pushLog(run, `⚔️ Элита повержена: ${orbs.map((o) => `${o.icon}${o.count}`).join(' ')}${heal ? `, +${heal} HP` : ''}.`, 'good');
  } else if (enemy.kind === 'ambush') {
    const orbs = rollOrbDrop({
      rng,
      count: randInt(rng, 3, 5),
      rarityPct: rarityBoost + 80,
      quantityPct: (run.modifiers.quantityPct || 0) + 25,
      doubleOrbs: run.modifiers.doubleOrbs,
    });
    addLoot(run, orbs);
    results.orbs = orbs;
    if (rng() * 100 < 12 + (run.modifiers.fragmentChance || 0) / 2) {
      results.fragment = true;
      run.fragmentFound = true;
      pushLog(run, '💠 Разлом отдал фрагмент рейд-босса!', 'mythic');
    }
    pushLog(run, `🕳️ Разлом зачищен: ${orbs.map((o) => `${o.icon}${o.count}`).join(' ')}.`, 'good');
  } else if (enemy.kind === 'boss') {
    pushLog(run, `👹 Босс карты ${enemy.name} повержен!`, 'mythic');
    results.bossKilled = true;
  } else {
    const orbs = rollOrbDrop({
      rng,
      count: randInt(rng, 2, 3),
      rarityPct: rarityBoost,
      quantityPct: (run.modifiers.quantityPct || 0) + 10,
      doubleOrbs: run.modifiers.doubleOrbs,
    });
    addLoot(run, orbs);
    results.orbs = orbs;
    pushLog(run, `🐗 Пак зачищен: ${orbs.map((o) => `${o.icon}${o.count}`).join(' ')}.`, 'good');
  }

  // Регенерация от суффикса regenChance.
  const die = (player.dice || []).find((d) => d.id === player.equippedDieId) || player.dice?.[0];
  const stats = getDieAggregatedStats(die);
  if (stats.regenChance > 0 && rng() * 100 < stats.regenChance && run.hp < run.maxHp) {
    run.hp += 1;
    results.heal += 1;
    pushLog(run, '💚 Регенерация: +1 HP.', 'good');
  }
  return results;
}

/** Завершение похода: начисление лута игроку. */
export function finishRun({ run, player, rng = createRng(), outcome = 'victory' }) {
  if (run.finishedAt) return run.report;
  run.finishedAt = Date.now();
  const keepPct = outcome === 'victory' ? 1 : 0.5;

  const gained = {};
  for (const [orbId, count] of Object.entries(run.loot || {})) {
    const keep = Math.max(0, Math.floor(count * keepPct));
    if (keep <= 0) continue;
    gained[orbId] = keep;
    player.inventory[orbId] = (player.inventory[orbId] || 0) + keep;
  }

  // Бонусные карты из ларцов всегда остаются.
  for (const bonusMap of run.bonusMaps || []) {
    player.maps.push({
      ...bonusMap,
      id: uid('map'),
      rarity: 'normal',
      quality: 0,
      mods: [],
      corrupted: false,
      ownerId: player.id,
      createdAt: Date.now(),
    });
  }

  const report = {
    runId: run.id,
    tier: run.tier,
    outcome,
    keepPct,
    hp: run.hp,
    maxHp: run.maxHp,
    nodesCleared: run.nodesCleared,
    turns: run.turns,
    bestCombo: run.bestCombo,
    gained,
    bonusMaps: (run.bonusMaps || []).length,
    fragment: Boolean(run.fragmentFound),
    atlas: null,
    logs: run.log.slice(-14),
    finishedAt: run.finishedAt,
    mapName: run.map?.name,
  };

  if (outcome === 'victory' && run.map) {
    const victory = grantMapVictory({
      player,
      map: {
        tier: run.tier,
        rarity: run.map.rarity,
        corrupted: run.map.corrupted,
        mods: run.map.mods,
        quality: run.map.quality,
        name: run.map.name,
      },
      rng,
      bossKills: player.bossKills || 0,
      modifiers: run.modifiers,
    });
    report.atlas = victory;
    player.bossKills = (player.bossKills || 0) + 1;
    player.mapsCompleted = (player.mapsCompleted || 0) + 1;
    if (run.fragmentFound) {
      player.fragments = player.fragments || {};
      const fragIds = ['hydra', 'chimera', 'phoenix', 'minotaur'];
      const frag = pick(rng, fragIds);
      player.fragments[frag] = (player.fragments[frag] || 0) + 1;
      report.fragmentId = frag;
    }
  } else if (run.map) {
    pushLog(run, 'Отступление: сохраняется половина собранного лута.', 'danger');
  }

  run.report = report;
  return report;
}

export function retreatRun({ run, player }) {
  if (!run) return { ok: false, reason: 'Поход не найден.' };
  if ([RUN_PHASES.victory, RUN_PHASES.defeat, RUN_PHASES.retreat].includes(run.phase)) {
    return { ok: false, reason: 'Поход уже завершён.' };
  }
  run.phase = RUN_PHASES.retreat;
  const report = finishRun({ run, player, outcome: 'retreat' });
  return { ok: true, report, message: 'Вы отступили, сохранив половину лута.' };
}

/* ────────────────────────── ХЕЛПЕРЫ ДЛЯ UI ────────────────────────── */

export function publicEnemy(enemy) {
  if (!enemy) return null;
  return {
    id: enemy.id,
    kind: enemy.kind,
    name: enemy.name,
    icon: enemy.icon,
    hp: enemy.hp,
    maxHp: enemy.maxHp,
    faces: enemy.faces,
    bonus: enemy.bonus,
    round: enemy.round,
    shieldActive: Boolean(enemy.shield?.active),
    shieldHitsLeft: enemy.shield?.hitsLeft || 0,
    enraged: Boolean(enemy.enraged),
    isBoss: Boolean(enemy.isBoss),
    intent: enemy.intent
      ? {
        id: enemy.intent.id,
        name: enemy.intent.name,
        icon: enemy.intent.icon,
        description: enemy.intent.description,
        enemyScore: enemy.intent.enemyScore,
      }
      : null,
  };
}

export function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    playerId: run.playerId,
    partnerId: run.partnerId,
    ally: run.ally,
    tier: run.tier,
    map: run.map,
    modifiers: run.modifiers,
    phase: run.phase,
    hp: run.hp,
    maxHp: run.maxHp,
    currentHp: run.hp,
    buffs: run.buffs,
    enemy: publicEnemy(run.enemy),
    currentNodeId: run.currentNodeId,
    availableNodeIds: availableNodeIds(run),
    graph: {
      nodes: run.graph.nodes.map((node) => ({
        id: node.id,
        layer: node.layer,
        slot: node.slot,
        type: node.type,
        name: node.name,
        icon: node.icon,
        color: node.color,
        combat: node.combat,
        nextIds: node.nextIds,
        visited: node.visited,
        available: availableNodeIds(run).includes(node.id),
        x: node.x,
        y: node.y,
      })),
      layers: run.graph.layers,
      entryId: run.graph.entryId,
      bossId: run.graph.bossId,
      layerCount: run.graph.layerCount,
    },
    loot: run.loot,
    lootLog: run.lootLog,
    combos: run.combos,
    bestCombo: run.bestCombo,
    turns: run.turns,
    nodesCleared: run.nodesCleared,
    log: run.log.slice(-20),
    report: run.report,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastTurn: run.lastTurn,
  };
}

/**
 * Быстрый авто-забег — симуляция похода «жадным» маршрутом.
 * Полезно для админских проверок и тестов, а также как кнопка «Авто».
 */
export function autoResolveRun({ run, player, rng = createRng(), maxTurns = 200 }) {
  let guard = 0;
  const turnLog = [];
  while (guard < maxTurns) {
    guard += 1;
    if (run.phase === RUN_PHASES.navigation) {
      const options = getAvailableNodes(run);
      if (!options.length) break;
      // Жадный маршрут: элитка > лут > пак > разлом > святилище > босс.
      const priority = { elite: 0, chest: 1, pack: 2, ambush: 3, shrine: 4, boss: 5 };
      options.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));
      chooseMapNode({ run, player, nodeId: options[0].id, rng });
      continue;
    }
    if (run.phase === RUN_PHASES.combat) {
      const result = resolveMapTurn({ run, player, action: 'attack', orbId: null, rng });
      if (!result.ok) break;
      turnLog.push(result.turn);
      continue;
    }
    break;
  }
  if (!run.report) finishRun({ run, player, rng, outcome: run.hp > 0 ? 'retreat' : 'defeat' });
  return { run, report: run.report, turns: turnLog };
}
