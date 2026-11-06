/**
 * Граф похода по карте + пошаговый тактический бой.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOSS_INTENTS,
  COMBAT_ACTIONS,
  MAP_BATTLE_ORBS,
  MAP_COMBAT_CONFIG,
  MAP_NODE_TYPES,
} from '../src/engine/constants.js';
import { createRng, generateDie } from '../src/engine/crafting.js';
import {
  RUN_PHASES,
  autoResolveRun,
  availableNodeIds,
  buildMapGraph,
  chooseMapNode,
  computeRunMaxHp,
  createEnemyForNode,
  finishRun,
  getLayerCount,
  getPowerBonus,
  publicRun,
  resolveMapTurn,
  retreatRun,
  startRun,
} from '../src/engine/mapCombat.js';
import { createEmptyMap, getMapModifiers } from '../src/engine/atlas.js';
import { fillInventory, makeStore, seeded } from './helpers.js';

function makePlayer(seedVal = 1) {
  const store = makeStore();
  const player = store.getPlayer('p4');
  const die = generateDie({
    rng: seeded(seedVal), baseId: 'prismatic_d10', rarity: 'rare', ilvl: 100, topTierOnly: true,
  });
  player.dice = [die];
  player.equippedDieId = die.id;
  fillInventory(store, player, 50);
  return { store, player, die };
}

describe('buildMapGraph: граф развилок', () => {
  it('глубина зависит от тира: 4 / 5 / 6 ярусов', () => {
    assert.equal(getLayerCount(1), 4);
    assert.equal(getLayerCount(5), 4);
    assert.equal(getLayerCount(6), 5);
    assert.equal(getLayerCount(11), 5);
    assert.equal(getLayerCount(12), 6);
    assert.equal(getLayerCount(16), 6);
  });

  for (const tier of [1, 6, 16]) {
    it(`T${tier}: вход → босс, все узлы достижимы, рёбра ведут только вперёд`, () => {
      const graph = buildMapGraph({ tier, rng: seeded(100 + tier) });
      const layers = getLayerCount(tier);
      assert.equal(graph.layers.length, layers);
      assert.equal(graph.nodes.length, new Set(graph.nodes.map((n) => n.id)).size, 'id уникальны');

      const entry = graph.nodes.find((n) => n.id === graph.entryId);
      const boss = graph.nodes.find((n) => n.id === graph.bossId);
      assert.equal(entry.type, 'entrance');
      assert.equal(entry.layer, 0);
      assert.equal(boss.type, 'boss');
      assert.equal(boss.layer, layers - 1);
      assert.equal(graph.layers[layers - 1].length, 1, 'финальный ярус — один босс');

      for (let layer = 1; layer <= layers - 2; layer += 1) {
        const inLayer = graph.layers[layer];
        assert.ok(inLayer.length >= 2 && inLayer.length <= 3, `ярус ${layer}: ${inLayer.length} узлов`);
        for (const id of inLayer) {
          const node = graph.nodes.find((n) => n.id === id);
          assert.ok(
            !['entrance', 'boss'].includes(node.type),
            `промежуточный узел не может быть ${node.type}`,
          );
          assert.ok(MAP_NODE_TYPES[node.type], `тип ${node.type} известен`);
          assert.ok(node.icon && node.name);
        }
      }

      // Каждый узел (кроме босса) имеет 1–2 исходящих ребра.
      for (const node of graph.nodes) {
        if (node.type === 'boss') {
          assert.equal(node.nextIds.length, 0);
          continue;
        }
        const maxLinks = node.type === 'entrance' ? 3 : 2;
        assert.ok(node.nextIds.length >= 1 && node.nextIds.length <= maxLinks,
          `${node.type}@${node.layer}: ${node.nextIds.length} рёбер`);
        for (const nextId of node.nextIds) {
          const target = graph.nodes.find((n) => n.id === nextId);
          assert.ok(target, 'ребро ведёт в существующий узел');
          assert.equal(target.layer, node.layer + 1, 'ребро только на следующий ярус');
        }
      }

      // Все узлы достижимы из входа (BFS), и все пути заканчиваются боссом.
      const reachable = new Set([graph.entryId]);
      const queue = [graph.entryId];
      while (queue.length) {
        const currentId = queue.shift();
        const current = graph.nodes.find((n) => n.id === currentId);
        for (const nextId of current.nextIds) {
          if (!reachable.has(nextId)) {
            reachable.add(nextId);
            queue.push(nextId);
          }
        }
      }
      assert.equal(reachable.size, graph.nodes.length, 'нет недостижимых узлов');

      for (const node of graph.nodes) {
        if (node.type !== 'boss') assert.ok(node.nextIds.length > 0, 'нет тупиков');
        if (node.layer === layers - 2) {
          assert.deepEqual(node.nextIds, [graph.bossId], 'предпоследний ярус ведёт к боссу');
        }
      }
    });
  }

  it('развилки реально ветвятся: хотя бы один ярус имеет 3 узла', () => {
    let branches = 0;
    for (let i = 0; i < 10; i += 1) {
      const graph = buildMapGraph({ tier: 16, rng: seeded(i) });
      branches += graph.layers.slice(1, -1).filter((layer) => layer.length === 3).length;
    }
    assert.ok(branches > 0, 'за 10 генераций должен встретиться ярус из 3 узлов');
  });

  it('у каждого узла следующего яруса есть входящее ребро', () => {
    for (let i = 0; i < 20; i += 1) {
      const graph = buildMapGraph({ tier: 12, rng: seeded(i) });
      for (let layer = 1; layer < graph.layers.length; layer += 1) {
        for (const id of graph.layers[layer]) {
          const incoming = graph.nodes.filter((n) => n.nextIds.includes(id));
          assert.ok(incoming.length >= 1, `узел ${id} яруса ${layer} без входа`);
        }
      }
    }
  });
});

describe('startRun и навигация по развилкам', () => {
  it('старт: вход посещён, фаза navigation, доступны 2–3 ветки', () => {
    const { player } = makePlayer(2);
    const map = createEmptyMap({ tier: 8 });
    const run = startRun({ player, map, rng: seeded(9) });
    assert.equal(run.phase, RUN_PHASES.navigation);
    assert.equal(run.currentNodeId, run.graph.entryId);
    assert.ok(run.hp === run.maxHp && run.hp > 0);
    const available = availableNodeIds(run);
    assert.ok(available.length >= 1 && available.length <= 2,
      `из входа максимум 2 ребра, получили ${available.length}`);
    assert.ok(run.log.some((line) => line.kind === 'enter'));
  });

  it('нельзя перейти в недоступный узел', () => {
    const { player } = makePlayer(3);
    const run = startRun({ player, map: createEmptyMap({ tier: 4 }), rng: seeded(11) });
    const far = run.graph.nodes.find((n) => n.layer === 2);
    const result = chooseMapNode({ run, player, nodeId: far.id, rng: seeded(1) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /нельзя перейти/i);
  });

  it('мирные узлы (chest/shrine) срабатывают мгновенно и не включают бой', () => {
    const { player } = makePlayer(4);
    let checkedChest = false;
    let checkedShrine = false;

    for (let attempt = 0; attempt < 60 && !(checkedChest && checkedShrine); attempt += 1) {
      const run = startRun({
        player, map: createEmptyMap({ tier: 3 }), rng: seeded(attempt + 40),
      });
      let guard = 0;
      while (run.phase === RUN_PHASES.navigation && guard < 20) {
        guard += 1;
        const options = availableNodeIds(run)
          .map((id) => run.graph.nodes.find((n) => n.id === id))
          .filter(Boolean);
        const peaceful = options.find((n) => !n.combat);
        if (!peaceful) break;
        const before = run.hp;
        const result = chooseMapNode({ run, player, nodeId: peaceful.id, rng: seeded(attempt * 31 + guard) });
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.peaceful, true);
        assert.equal(run.phase, RUN_PHASES.navigation, 'мирный узел не запускает бой');
        assert.equal(run.enemy, null);
        assert.ok(result.effect?.kind);
        if (peaceful.type === 'chest') {
          checkedChest = true;
          const gained = Object.values(run.loot).reduce((a, b) => a + b, 0);
          assert.ok(gained >= 0);
        }
        if (peaceful.type === 'shrine') {
          checkedShrine = true;
          const healed = run.hp > before;
          const buffed = (run.buffs.scoreBonus || 0) > 0;
          assert.ok(healed || buffed || result.effect.mode, 'святилище либо лечит, либо даёт бафф');
        }
      }
    }
    assert.equal(checkedChest, true, 'должен встретиться ларец');
    assert.equal(checkedShrine, true, 'должно встретиться святилище');
  });

  it('боевой узел запускает бой с врагом нужного типа', () => {
    const { player } = makePlayer(5);
    let found = false;
    for (let attempt = 0; attempt < 40 && !found; attempt += 1) {
      const run = startRun({ player, map: createEmptyMap({ tier: 10 }), rng: seeded(attempt + 200) });
      const options = availableNodeIds(run)
        .map((id) => run.graph.nodes.find((n) => n.id === id))
        .filter((n) => n && n.combat);
      if (!options.length) continue;
      const target = options[0];
      const result = chooseMapNode({ run, player, nodeId: target.id, rng: seeded(attempt) });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.peaceful, false);
      assert.equal(run.phase, RUN_PHASES.combat);
      assert.ok(run.enemy);
      assert.equal(run.enemy.kind, target.type);
      assert.ok(run.enemy.hp > 0);
      assert.ok(run.enemy.faces >= 6);
      found = true;
    }
    assert.equal(found, true);
  });

  it('выбор узла запрещён, пока идёт бой', () => {
    const { player } = makePlayer(6);
    let run = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = startRun({ player, map: createEmptyMap({ tier: 5 }), rng: seeded(attempt + 500) });
      const combatNode = availableNodeIds(candidate)
        .map((id) => candidate.graph.nodes.find((n) => n.id === id))
        .find((n) => n && n.combat);
      if (combatNode) {
        chooseMapNode({ run: candidate, player, nodeId: combatNode.id, rng: seeded(1) });
        run = candidate;
        break;
      }
    }
    assert.ok(run, 'нужен боевой узел на первой развилке');
    assert.equal(run.phase, RUN_PHASES.combat);
    const available = availableNodeIds(run);
    assert.deepEqual(available, [], 'в бою развилок нет');
    const attempt = chooseMapNode({ run, player, nodeId: run.graph.bossId, rng: seeded(1) });
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason, /идёт бой/i);
  });
});

describe('createEnemyForNode и формула HP похода', () => {
  it('тиры определяют кубик мобов: D6 (T1–10), D8 (T11–15), D12 (T16)', () => {
    assert.equal(createEnemyForNode({ tier: 3, nodeType: 'pack', rng: seeded(1) }).faces, 6);
    assert.equal(createEnemyForNode({ tier: 10, nodeType: 'pack', rng: seeded(1) }).faces, 6);
    assert.equal(createEnemyForNode({ tier: 11, nodeType: 'pack', rng: seeded(1) }).faces, 8);
    assert.equal(createEnemyForNode({ tier: 15, nodeType: 'pack', rng: seeded(1) }).faces, 8);
    assert.equal(createEnemyForNode({ tier: 16, nodeType: 'pack', rng: seeded(1) }).faces, 12);
    const elite = createEnemyForNode({ tier: 16, nodeType: 'elite', rng: seeded(1) });
    assert.equal(elite.faces, 13);
    assert.equal(elite.bonus, 1);
  });

  it('HP элиты = x1.8 от обычного пака', () => {
    const pack = createEnemyForNode({ tier: 8, nodeType: 'pack', rng: seeded(5) });
    const elite = createEnemyForNode({ tier: 8, nodeType: 'elite', rng: seeded(5) });
    assert.ok(elite.maxHp > pack.maxHp * 1.5);
    assert.ok(elite.maxHp <= Math.round(pack.maxHp * 1.8) + 2);
  });

  it('босс карты: HP = (80 + tier*8) * bossHpMult, кубик D(6 + floor(tier/5))', () => {
    const boss = createEnemyForNode({ tier: 10, nodeType: 'boss', rng: seeded(1) });
    assert.equal(boss.maxHp, 80 + 10 * 8);
    assert.equal(boss.faces, 6 + Math.floor(10 / 5));
    assert.equal(boss.isBoss, true);
    const tanky = createEnemyForNode({
      tier: 10, nodeType: 'boss', rng: seeded(1), modifiers: { bossHpMult: 2 },
    });
    assert.equal(tanky.maxHp, (80 + 10 * 8) * 2);
  });

  it('HP похода = min(20, 12 + floor(power/4)) + бонусы', () => {
    const { die } = makePlayer(7);
    const hp = computeRunMaxHp(die);
    assert.ok(hp >= 6 && hp <= 20, `HP: ${hp}`);
    const buffed = computeRunMaxHp(die, { hpBonus: 4 });
    assert.equal(buffed, hp + 4);
  });

  it('getPowerBonus = min(5, floor(power/4))', () => {
    assert.equal(getPowerBonus(0), 0);
    assert.equal(getPowerBonus(3), 0);
    assert.equal(getPowerBonus(4), 1);
    assert.equal(getPowerBonus(19), 4);
    assert.equal(getPowerBonus(100), 5);
  });
});

describe('resolveMapTurn: пошаговый бой', () => {
  const setupCombat = (seedVal = 1, tier = 6) => {
    const { player } = makePlayer(seedVal);
    let run = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const candidate = startRun({ player, map: createEmptyMap({ tier }), rng: seeded(attempt + seedVal * 13) });
      const combatNode = availableNodeIds(candidate)
        .map((id) => candidate.graph.nodes.find((n) => n.id === id))
        .find((n) => n && n.combat && n.type !== 'boss');
      if (combatNode) {
        chooseMapNode({ run: candidate, player, nodeId: combatNode.id, rng: seeded(attempt) });
        run = candidate;
        break;
      }
    }
    assert.ok(run, 'не удалось начать бой');
    return { player, run };
  };

  it('три действия имеют корректные модификаторы', () => {
    assert.deepEqual(
      { s: COMBAT_ACTIONS.attack.score, d: COMBAT_ACTIONS.attack.damageMult, i: COMBAT_ACTIONS.attack.incomingMult },
      { s: 1, d: 1, i: 1 },
    );
    assert.equal(COMBAT_ACTIONS.defend.score, 1);
    assert.equal(COMBAT_ACTIONS.defend.damageMult, 0.4);
    assert.equal(COMBAT_ACTIONS.defend.incomingMult, 0.4);
    assert.equal(COMBAT_ACTIONS.gamble.score, -1);
    assert.equal(COMBAT_ACTIONS.gamble.damageMult, 1.9);
    assert.equal(COMBAT_ACTIONS.gamble.extraLossOnLose, 2);
  });

  it('раунд возвращает броски, счёт и результат; проигрыш снимает HP', () => {
    const { player, run } = setupCombat(3);
    const startHp = run.hp;
    const enemyStartHp = run.enemy.hp;
    let wins = 0;
    let losses = 0;
    for (let i = 0; i < 40 && run.phase === RUN_PHASES.combat; i += 1) {
      const result = resolveMapTurn({ run, player, action: 'attack', rng: seeded(i + 1) });
      assert.equal(result.ok, true, result.reason);
      const { turn } = result;
      assert.ok(turn.playerScore >= 1);
      assert.ok(turn.enemyScore >= 1);
      assert.equal(turn.playerScore > turn.enemyScore, turn.won);
      if (turn.won) {
        wins += 1;
        assert.ok(turn.damage >= 1, 'урон должен быть положительным');
      } else {
        losses += 1;
        assert.ok(turn.hpLoss >= 1, 'поражение всегда стоит HP');
      }
      assert.ok(run.hp <= startHp);
    }
    assert.ok(wins + losses > 0);
    assert.ok(run.enemy === null || run.enemy.hp < enemyStartHp, 'враг получил урон');
  });

  it('победа в бою переводит фазу обратно в navigation и засчитывает узел', () => {
    const { player, run } = setupCombat(5, 1);
    // Ослабляем врага, чтобы гарантированно добить.
    run.enemy.hp = 1;
    let guard = 0;
    let result = null;
    while (run.phase === RUN_PHASES.combat && guard < 30) {
      guard += 1;
      result = resolveMapTurn({ run, player, action: 'attack', rng: seeded(guard * 3) });
    }
    assert.equal(run.phase, RUN_PHASES.navigation);
    assert.equal(run.enemy, null);
    assert.ok(result.nodeCleared);
    assert.ok(run.nodesCleared >= 1);
    assert.ok(availableNodeIds(run).length >= 1, 'после победы снова есть развилка');
  });

  it('защита снижает потери HP по сравнению с атакой при проигрыше', () => {
    const { player, run } = setupCombat(7);
    // Искусственно делаем врага непобедимым, чтобы оба хода были проигрышными.
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const attackRun = clone(run);
    const defendRun = clone(run);
    for (const target of [attackRun, defendRun]) {
      target.enemy.bonus = 40;
      target.enemy.faces = 20;
      target.enemy.hp = 9999;
      target.enemy.maxHp = 9999;
      target.hp = 20;
      target.maxHp = 20;
    }
    const attack = resolveMapTurn({ run: attackRun, player, action: 'attack', rng: seeded(1234) });
    const defend = resolveMapTurn({ run: defendRun, player, action: 'defend', rng: seeded(1234) });
    assert.equal(attack.ok, true, attack.reason);
    assert.equal(defend.ok, true, defend.reason);
    assert.equal(attack.won, false);
    assert.equal(defend.won, false);
    assert.ok(defend.turn.hpLoss < attack.turn.hpLoss,
      `защита (${defend.turn.hpLoss}) должна терять меньше HP, чем атака (${attack.turn.hpLoss})`);
  });

  it('сферы боя тратятся из тайника и дают эффект', () => {
    const { player, run } = setupCombat(9);
    const beforeWhetstone = player.inventory.whetstone;
    const hpBefore = run.hp;
    run.hp = Math.max(1, run.hp - 3);
    const heal = resolveMapTurn({
      run, player, action: 'attack', orbId: 'whetstone', rng: seeded(4),
    });
    assert.equal(heal.ok, true, heal.reason);
    assert.equal(player.inventory.whetstone, beforeWhetstone - 1);
    assert.ok(run.hp >= hpBefore - 5);
    assert.equal(heal.turn.orb.id, 'whetstone');
  });

  it('сферы боя не хватает — ход отклоняется', () => {
    const { player, run } = setupCombat(11);
    player.inventory.exalted = 0;
    const result = resolveMapTurn({ run, player, action: 'attack', orbId: 'exalted', rng: seeded(1) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Нет/i);
  });

  it('неизвестное действие отклоняется', () => {
    const { player, run } = setupCombat(13);
    const result = resolveMapTurn({ run, player, action: 'teleport', rng: seeded(1) });
    assert.equal(result.ok, false);
  });

  it('9 боевых сфер описаны и доступны', () => {
    const ids = Object.keys(MAP_BATTLE_ORBS);
    assert.equal(ids.length, 9);
    for (const id of ids) {
      assert.ok(MAP_BATTLE_ORBS[id].icon);
      assert.ok(MAP_BATTLE_ORBS[id].description);
    }
  });
});

describe('босс карты: щит, телеграф, ярость', () => {
  const bossRun = () => {
    const { player } = makePlayer(21);
    const map = createEmptyMap({ tier: 8 });
    const run = startRun({ player, map, rng: seeded(77) });
    // Телепортируемся к боссу, минуя промежуточные узлы.
    const bossNode = run.graph.nodes.find((n) => n.type === 'boss');
    const preBoss = run.graph.nodes.find((n) => n.nextIds.includes(bossNode.id));
    preBoss.visited = true;
    run.currentNodeId = preBoss.id;
    const result = chooseMapNode({ run, player, nodeId: bossNode.id, rng: seeded(3) });
    assert.equal(result.ok, true, result.reason);
    return { run, player };
  };

  it('у босса есть телеграф намерений из BOSS_INTENTS', () => {
    const { run } = bossRun();
    assert.equal(run.phase, RUN_PHASES.combat);
    assert.equal(run.enemy.isBoss, true);
    assert.ok(run.enemy.intent);
    assert.ok(BOSS_INTENTS.some((intent) => intent.id === run.enemy.intent.id));
    const publicInfo = publicRun(run);
    assert.equal(publicInfo.enemy.intent.id, run.enemy.intent.id);
  });

  it('щит включается на 70% и 35% HP и снимается ударами', () => {
    const { run, player } = bossRun();
    run.enemy.hp = Math.round(run.enemy.maxHp * 0.72);
    let guard = 0;
    let shieldSeen = false;
    while (run.phase === RUN_PHASES.combat && guard < 40) {
      guard += 1;
      const result = resolveMapTurn({ run, player, action: 'attack', rng: seeded(guard * 11) });
      if (!result.ok) break;
      if (run.enemy?.shield?.active) {
        shieldSeen = true;
        assert.ok(run.enemy.shield.hitsLeft <= MAP_COMBAT_CONFIG.bossShieldHits);
      }
      if (run.enemy && run.enemy.hp > run.enemy.maxHp * 0.36) {
        // держим HP выше второго порога
        run.enemy.hp = Math.max(run.enemy.hp, Math.round(run.enemy.maxHp * 0.36));
      }
    }
    assert.equal(shieldSeen, true, 'щит должен появиться при 70% HP');
  });

  it('ярость включается ниже 25% HP', () => {
    const { run, player } = bossRun();
    run.enemy.hp = Math.round(run.enemy.maxHp * 0.26);
    let guard = 0;
    while (run.phase === RUN_PHASES.combat && guard < 20 && !run.enemy?.enraged) {
      guard += 1;
      run.enemy.hp = Math.max(2, Math.round(run.enemy.maxHp * 0.24));
      resolveMapTurn({ run, player, action: 'attack', rng: seeded(guard) });
    }
    assert.ok(!run.enemy || run.enemy.enraged || run.phase === RUN_PHASES.victory);
  });

  it('победа над боссом завершает поход и начисляет отчёт', () => {
    const { run, player } = bossRun();
    run.enemy.hp = 1;
    let guard = 0;
    let last = null;
    while (run.phase === RUN_PHASES.combat && guard < 30) {
      guard += 1;
      last = resolveMapTurn({ run, player, action: 'attack', rng: seeded(guard * 7) });
    }
    assert.equal(run.phase, RUN_PHASES.victory);
    assert.ok(run.report, 'отчёт должен существовать');
    assert.equal(last.runFinished, true);
    assert.equal(run.report.outcome, 'victory');
    assert.equal(run.report.keepPct, 1);
    assert.ok(run.report.atlas, 'награда Атласа начислена');
    assert.ok(player.bossKills >= 1);
  });

  it('смерть игрока — поражение, сохраняется половина лута', () => {
    const { run, player } = bossRun();
    run.loot = { transmutation: 10, alteration: 6 };
    run.hp = 1;
    let guard = 0;
    while (run.phase === RUN_PHASES.combat && guard < 30) {
      guard += 1;
      resolveMapTurn({ run, player, action: 'gamble', rng: seeded(guard * 23) });
    }
    assert.equal(run.phase, RUN_PHASES.defeat);
    assert.equal(run.report.outcome, 'defeat');
    assert.equal(run.report.keepPct, 0.5);
    assert.ok(run.report.gained.transmutation <= 5);
  });
});

describe('finishRun / retreatRun / autoResolveRun', () => {
  it('отступление отдаёт половину собранного лута', () => {
    const { player } = makePlayer(31);
    const run = startRun({ player, map: createEmptyMap({ tier: 5 }), rng: seeded(5) });
    run.loot = { chaos: 4, whetstone: 7 };
    const before = { ...player.inventory };
    const result = retreatRun({ run, player });
    assert.equal(result.ok, true);
    assert.equal(run.phase, RUN_PHASES.retreat);
    assert.equal(player.inventory.chaos, before.chaos + 2);
    assert.equal(player.inventory.whetstone, before.whetstone + 3);
    assert.equal(result.report.outcome, 'retreat');

    const second = retreatRun({ run, player });
    assert.equal(second.ok, false, 'дважды отступить нельзя');
  });

  it('авто-забег доходит до финала и не зависает', () => {
    const { player } = makePlayer(41);
    const run = startRun({ player, map: createEmptyMap({ tier: 3 }), rng: seeded(123) });
    const { report, turns } = autoResolveRun({ run, player, rng: seeded(456) });
    assert.ok(report, 'отчёт должен быть');
    assert.ok(['victory', 'defeat', 'retreat'].includes(report.outcome));
    assert.ok(turns.length > 0, 'должны быть раунды боя');
    assert.ok(['victory', 'defeat', 'retreat'].includes(run.phase));
  });

  it('publicRun отдаёт безопасный слепок графа с флагами доступности', () => {
    const { player } = makePlayer(51);
    const run = startRun({ player, map: createEmptyMap({ tier: 12 }), rng: seeded(2) });
    const info = publicRun(run);
    assert.equal(info.graph.nodes.length, run.graph.nodes.length);
    const available = info.graph.nodes.filter((n) => n.available);
    assert.equal(available.length, info.availableNodeIds.length);
    for (const node of info.graph.nodes) {
      assert.ok(typeof node.x === 'number' && typeof node.y === 'number');
      assert.ok(Array.isArray(node.nextIds));
    }
    assert.ok(info.log.length > 0);
  });

  it('модификаторы карты влияют на бой (noLucky, monsterMult)', () => {
    const { player } = makePlayer(61);
    const map = createEmptyMap({ tier: 9 });
    map.rarity = 'rare';
    map.mods = ['dense_swarm', 'no_luck'];
    const modifiers = getMapModifiers(map);
    const run = startRun({ player, map, rng: seeded(9), modifiers });
    assert.equal(run.modifiers.noLucky, true);
    assert.ok(run.modifiers.monsterMult > 1);
  });
});
