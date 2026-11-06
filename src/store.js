/**
 * PATH OF DICE — src/store.js
 * Класс GameStore: состояние игры, миграции БД, обёртки над движком,
 * лента событий (feed), прокачка персонажа, задания, дуэли и админка.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AFFIX_LIST,
  ATLAS_BRANCHES,
  ATLAS_PASSIVES,
  BENCH_RECIPES,
  CURRENCIES,
  CURRENCY_DISPLAY_ORDER,
  DICE_BASE_LIST,
  FRAGMENTS,
  FRAGMENT_IDS,
  MAP_BATTLE_ORBS,
  MAP_MODS,
  MAP_NODE_TYPES,
  MAP_ZONES,
  BOSS_INTENTS,
  COMBAT_ACTIONS,
  RARITY_ORDER,
  RARITY,
  RAID_BOSSES,
  RAID_CONFIG,
  TUNING,
  UNIQUE_DICE,
  UNIQUE_GAMBLE_PRICE,
} from './engine/constants.js';
import {
  applyBenchRecipe,
  applyOrbToDie,
  createRng,
  estimateDiePower,
  generateDie,
  getBenchCost,
  getDieAggregatedStats,
  hasTopTier,
  pick,
  randInt,
  uid,
} from './engine/crafting.js';
import {
  applyBossDamage,
  getNewBoss,
  getPartyAuras,
  rollDailyDie,
  rollOrbDrop,
} from './engine/roll.js';
import {
  buyDieBase,
  claimRaidLoot,
  craftMap,
  createEmptyMap,
  depositFragment,
  gambleUnique,
  getAtlasEffects,
  getMapModifiers,
  getRaidStatus,
  grantMapVictory,
  kiracCost,
  learnPassive,
  rollDailyMaps,
  rollRaidLoot,
  salvageDie,
  summonRaid,
  raidAttack,
  getZone,
} from './engine/atlas.js';
import {
  autoResolveRun,
  chooseMapNode,
  finishRun,
  publicRun,
  resolveMapTurn,
  retreatRun,
  startRun,
  RUN_PHASES,
} from './engine/mapCombat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, 'initialSeedDb.json');

export const SCHEMA_VERSION = 3;
export const MAX_LEVEL = 40;

/* ───────────────────────── Уровни и XP ───────────────────────── */

/** Сколько всего XP нужно для достижения уровня (кривая с ростом). */
export function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.floor(40 * (level - 1) ** 1.7);
}

export function levelFromXp(xp) {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

export function xpProgress(xp) {
  const level = levelFromXp(xp);
  const floorXp = xpForLevel(level);
  const nextXp = level >= MAX_LEVEL ? floorXp : xpForLevel(level + 1);
  const span = Math.max(1, nextXp - floorXp);
  return {
    level,
    xp,
    floorXp,
    nextXp,
    into: xp - floorXp,
    span,
    pct: Math.min(100, Math.round(((xp - floorXp) / span) * 100)),
  };
}

/** Награды за уровень. */
function levelRewards(level, rng) {
  const rewards = {};
  const pool = ['whetstone', 'transmutation', 'alteration', 'augmentation', 'scouring', 'regal'];
  const picks = randInt(rng, 2, 3);
  for (let i = 0; i < picks; i += 1) {
    const orb = pick(rng, pool);
    rewards[orb] = (rewards[orb] || 0) + 1;
  }
  if (level % 5 === 0) rewards.chaos = (rewards.chaos || 0) + 1;
  if (level % 10 === 0) rewards.exalted = (rewards.exalted || 0) + 1;
  return rewards;
}

/* ───────────────────────── Задания ───────────────────────── */

export const QUEST_POOL = Object.freeze([
  {
    id: 'daily_roll',
    name: 'Утренний обряд',
    icon: '🎲',
    text: 'Сделай ежедневный бросок кубиком',
    counter: 'rolls',
    target: 1,
    xp: 25,
    reward: { transmutation: 3, whetstone: 2 },
  },
  {
    id: 'node_hunter',
    name: 'Чистильщик',
    icon: '🗺️',
    text: 'Зачисти 4 узла на карте',
    counter: 'nodes',
    target: 4,
    xp: 45,
    reward: { alteration: 4, augmentation: 2 },
  },
  {
    id: 'map_clear',
    name: 'Картограф',
    icon: '👹',
    text: 'Пройди карту до босса',
    counter: 'maps',
    target: 1,
    xp: 60,
    atlasPoint: 1,
    reward: { regal: 1, scouring: 2 },
  },
  {
    id: 'crafter',
    name: 'Ремесленник',
    icon: '⚒️',
    text: 'Примени 3 сферы к кубику или карте',
    counter: 'crafts',
    target: 3,
    xp: 35,
    reward: { alteration: 3, whetstone: 3 },
  },
  {
    id: 'raid_damage',
    name: 'Гроза Рейда',
    icon: '🚨',
    text: 'Нанеси 800 урона рейд-боссу',
    counter: 'raidDamage',
    target: 800,
    xp: 70,
    reward: { chaos: 1, annulment: 1 },
  },
  {
    id: 'duelist',
    name: 'Дуэлянт',
    icon: '🤺',
    text: 'Победи в дуэли',
    counter: 'duelWins',
    target: 1,
    xp: 40,
    reward: { augmentation: 3, alteration: 2 },
  },
  {
    id: 'boss_slayer',
    name: 'Убийца боссов',
    icon: '💀',
    text: 'Добей босса чата',
    counter: 'bossKills',
    target: 1,
    xp: 80,
    atlasPoint: 1,
    reward: { chaos: 2 },
  },
]);

function questsForDay(dayKey) {
  const seed = [...dayKey].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const rng = createRng(seed);
  const pool = [...QUEST_POOL];
  const chosen = [];
  while (chosen.length < 3 && pool.length) {
    const idx = Math.floor(rng() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  return chosen;
}

/* ───────────────────────── Утилиты ───────────────────────── */

export function dayKey(now = Date.now()) {
  const date = new Date(now);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyInventory() {
  const out = {};
  for (const id of CURRENCY_DISPLAY_ORDER) out[id] = 0;
  return out;
}

function emptyCounters() {
  return {
    rolls: 0,
    nodes: 0,
    maps: 0,
    crafts: 0,
    raidDamage: 0,
    duelWins: 0,
    bossKills: 0,
    duels: 0,
  };
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/* ───────────────────────── GameStore ───────────────────────── */

export class GameStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath] путь к JSON-базе
   * @param {string} [opts.seedPath] путь к сиду
   * @param {Function} [opts.now] инъекция времени (для тестов)
   * @param {Function} [opts.rng] инъекция RNG
   * @param {Function} [opts.onSave] колбэк после записи (облачный бэкап)
   * @param {boolean} [opts.persist=true] писать ли на диск
   */
  constructor({
    dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.json'),
    seedPath = SEED_PATH,
    now = () => Date.now(),
    rng = Math.random,
    onSave = null,
    persist = true,
    quiet = false,
  } = {}) {
    this.dbPath = dbPath;
    this.seedPath = seedPath;
    this.now = now;
    this.rng = rng;
    this.onSave = onSave;
    this.persist = persist;
    this.quiet = quiet;
    this.version = 0;
    this.db = null;
    this._saveTimer = null;
    this._savePromise = null;
    this.lastSavedAt = 0;
  }

  /* ── Загрузка / сохранение ── */

  load() {
    let raw = null;
    if (this.persist && fs.existsSync(this.dbPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      } catch (error) {
        this.log(`⚠️ Не удалось прочитать ${this.dbPath}: ${error.message}. Беру сид.`);
        raw = null;
      }
    }
    if (!raw) raw = this.buildSeedDb();
    this.db = this.migrate(raw);
    this.version = 0;
    this.log(`📦 БД загружена: ${this.db.players.length} игроков, версия ${this.db.schema}.`);
    return this.db;
  }

  /** Подменяет БД (используется при восстановлении из Telegram Cloud). */
  adopt(raw) {
    this.db = this.migrate(raw);
    this.touch();
    return this.db;
  }

  log(message) {
    if (!this.quiet) console.log(`[store] ${message}`);
  }

  buildSeedDb() {
    if (fs.existsSync(this.seedPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.seedPath, 'utf8'));
      } catch (error) {
        this.log(`⚠️ Сид повреждён (${error.message}), строю новый.`);
      }
    }
    return this.createSeed();
  }

  /** Генерирует полноценный стартовый слепок на 6 друзей. */
  createSeed() {
    const now = this.now();
    const rng = createRng(20260214);
    const friends = [
      { id: 'p1', name: 'Ксандр', nickname: 'xandr_void', avatar: '🜲', role: 'Инквизитор', admin: true },
      { id: 'p2', name: 'Мирабель', nickname: 'mira_belle', avatar: '🌙', role: 'Оккультистка' },
      { id: 'p3', name: 'Тарн', nickname: 'tarn_ironfist', avatar: '🛡️', role: 'Джаггернаут' },
      { id: 'p4', name: 'Лисса', nickname: 'lissa_spark', avatar: '⚡', role: 'Элементалистка' },
      { id: 'p5', name: 'Кай', nickname: 'kai_shadow', avatar: '🗡️', role: 'Убийца' },
      { id: 'p6', name: 'Нокс', nickname: 'nox_grave', avatar: '💀', role: 'Некромант' },
    ];

    const players = friends.map((friend, index) => {
      const inventory = emptyInventory();
      for (const id of CURRENCY_DISPLAY_ORDER) {
        inventory[id] = randInt(rng, 4, 22);
      }
      inventory.whetstone += 10;
      inventory.chaos += 6;
      if (index === 0) inventory.exalted += 2;

      const unlocked = DICE_BASE_LIST.filter((base) => base.bossKillsRequired <= index);
      const primaryBase = unlocked[unlocked.length - 1] || DICE_BASE_LIST[0];
      const rarity = index === 0 ? 'rare' : index < 3 ? 'rare' : 'magic';
      const primary = generateDie({
        rng,
        baseId: primaryBase.id,
        rarity,
        ilvl: 70 + index * 3,
        ownerId: friend.id,
      });
      const extra = generateDie({
        rng,
        baseId: DICE_BASE_LIST[Math.min(index, DICE_BASE_LIST.length - 1)].id,
        rarity: index % 2 === 0 ? 'magic' : 'normal',
        ilvl: 60,
        ownerId: friend.id,
      });

      const maps = [
        createEmptyMap({ tier: 1 + index, ownerId: friend.id }),
        createEmptyMap({ tier: 2 + (index % 4), ownerId: friend.id }),
      ];
      if (index === 0) {
        const rareMap = createEmptyMap({ tier: 6, ownerId: friend.id });
        rareMap.rarity = 'rare';
        rareMap.mods = ['blood_price', 'mirror_map', 'frenzied'];
        maps.push(rareMap);
      }

      const xp = index === 0 ? 520 : randInt(rng, 40, 300);
      return {
        id: friend.id,
        name: friend.name,
        nickname: friend.nickname,
        avatar: friend.avatar,
        role: friend.role,
        telegramId: null,
        isAdmin: Boolean(friend.admin),
        createdAt: now - (6 - index) * 86400000,
        equippedDieId: primary.id,
        dice: [primary, extra],
        maps,
        inventory,
        fragments: {
          hydra: index === 0 ? 1 : 0,
          chimera: index === 1 ? 1 : 0,
          phoenix: index === 2 ? 1 : 0,
          minotaur: index === 0 ? 1 : 0,
        },
        atlasPoints: index === 0 ? 4 : index < 3 ? 2 : 1,
        atlasPassives: index === 0 ? ['endless_trails', 'trophy_hunter'] : index === 1 ? ['golden_rush'] : [],
        atlasCompleted: index === 0 ? [1, 2] : index === 1 ? [1] : [],
        bossKills: index,
        mapsCompleted: index * 2,
        portals: TUNING.defaultPortalsPerDay,
        dailyRollsUsed: 0,
        lastRollDay: null,
        cooldownUntil: 0,
        charges: 0,
        xp,
        levelClaimed: levelFromXp(0),
        lastChestDay: null,
        chestBonusMaps: 0,
        daily: { day: dayKey(now), counters: emptyCounters(), claimed: [] },
        stats: {
          totalRolls: 0,
          totalDamage: 0,
          bestScore: 0,
          crits: 0,
          vaals: 0,
          exaltsFound: 0,
          topTierFound: 0,
          duelsWon: 0,
          duelsLost: 0,
          raidDamage: 0,
        },
        lastSeenAt: now,
        lastReport: null,
      };
    });

    const boss = getNewBoss({ level: 3, rng });
    boss.name = 'Кровавый Изгнанник';
    boss.maxHp = 2400;
    boss.hp = 1820;

    return {
      schema: SCHEMA_VERSION,
      meta: { createdAt: now, updatedAt: now, generation: 1 },
      settings: {
        dailyRollsDefault: TUNING.dailyRollsDefault,
        chatName: 'Убежище Изгнанников',
        ladderResetAt: null,
        announceTopTier: true,
      },
      players,
      chat: {
        id: 'chapel',
        name: 'Убежище Изгнанников',
        boss,
        defeatedBosses: 4,
        totalRolls: 0,
        createdAt: now,
      },
      raid: {
        fragments: { hydra: 0, chimera: 0, phoenix: 0, minotaur: 0 },
        active: null,
        bossIndex: 0,
        history: [],
        lastDefeated: null,
      },
      atlas: { activeRuns: {}, history: [] },
      duels: [],
      feed: [],
      meta_seed: { friends: friends.length },
    };
  }

  /* ── Миграции ── */

  migrate(raw) {
    const db = raw && typeof raw === 'object' ? raw : this.createSeed();
    const now = this.now();

    if (!db.schema) db.schema = 1;
    if (db.schema > SCHEMA_VERSION) {
      this.log(`⚠️ БД новее кода (${db.schema} > ${SCHEMA_VERSION}). Работаю как есть.`);
    }

    db.meta = db.meta || { createdAt: now, updatedAt: now, generation: 1 };
    db.settings = {
      dailyRollsDefault: TUNING.dailyRollsDefault,
      chatName: 'Убежище Изгнанников',
      ladderResetAt: null,
      announceTopTier: true,
      ...(db.settings || {}),
    };

    db.players = Array.isArray(db.players) ? db.players : [];
    db.players.forEach((player) => this.migratePlayer(player, now));

    db.chat = db.chat || {};
    db.chat.id = db.chat.id || 'chapel';
    db.chat.name = db.chat.name || db.settings.chatName;
    if (!db.chat.boss || typeof db.chat.boss.hp !== 'number') {
      db.chat.boss = getNewBoss({ level: 1, rng: createRng(now) });
    }
    db.chat.boss.maxHp = db.chat.boss.maxHp || 1000;
    db.chat.boss.hp = Math.max(0, Math.min(db.chat.boss.hp, db.chat.boss.maxHp));
    db.chat.defeatedBosses = db.chat.defeatedBosses || 0;
    db.chat.totalRolls = db.chat.totalRolls || 0;

    db.raid = db.raid || {};
    db.raid.fragments = { hydra: 0, chimera: 0, phoenix: 0, minotaur: 0, ...(db.raid.fragments || {}) };
    db.raid.bossIndex = db.raid.bossIndex || 0;
    db.raid.history = Array.isArray(db.raid.history) ? db.raid.history : [];
    if (db.raid.active && !db.raid.active.maxHp) db.raid.active = null;

    db.atlas = db.atlas && typeof db.atlas === 'object' ? db.atlas : { activeRuns: {} };
    db.atlas.activeRuns = db.atlas.activeRuns && typeof db.atlas.activeRuns === 'object' ? db.atlas.activeRuns : {};
    db.atlas.history = Array.isArray(db.atlas.history) ? db.atlas.history : [];

    db.duels = Array.isArray(db.duels) ? db.duels : [];
    db.feed = Array.isArray(db.feed) ? db.feed : [];

    // Чистим «осиротевшие» походы игроков, которых больше нет.
    for (const playerId of Object.keys(db.atlas.activeRuns)) {
      if (!db.players.some((p) => p.id === playerId)) delete db.atlas.activeRuns[playerId];
    }

    db.schema = SCHEMA_VERSION;
    db.meta.updatedAt = now;
    return db;
  }

  migratePlayer(player, now) {
    player.id = player.id || uid('p');
    player.name = player.name || 'Изгнанник';
    player.nickname = player.nickname || player.id;
    player.avatar = player.avatar || '🎲';
    player.role = player.role || 'Изгнанник';
    player.isAdmin = Boolean(player.isAdmin);
    player.createdAt = player.createdAt || now;
    player.lastSeenAt = player.lastSeenAt || now;

    player.dice = Array.isArray(player.dice) ? player.dice : [];
    player.dice.forEach((die) => {
      die.id = die.id || uid('die');
      die.ownerId = player.id;
      die.mods = Array.isArray(die.mods) ? die.mods : [];
      die.vaalImplicits = Array.isArray(die.vaalImplicits) ? die.vaalImplicits : [];
      die.quality = typeof die.quality === 'number' ? die.quality : 0;
      die.locked = Boolean(die.locked);
      die.corrupted = Boolean(die.corrupted);
      if (!die.baseId) die.baseId = 'bone_d6';
      if (!die.faces) die.faces = 6;
      if (!die.ilvl) die.ilvl = 1;
    });
    if (!player.dice.length) {
      player.dice = [generateDie({ rng: createRng(player.id), baseId: 'bone_d6', rarity: 'normal', ownerId: player.id })];
    }
    if (!player.dice.some((d) => d.id === player.equippedDieId)) {
      player.equippedDieId = player.dice[0].id;
    }

    player.inventory = { ...emptyInventory(), ...(player.inventory || {}) };
    for (const id of CURRENCY_DISPLAY_ORDER) {
      if (typeof player.inventory[id] !== 'number' || Number.isNaN(player.inventory[id])) {
        player.inventory[id] = 0;
      }
      player.inventory[id] = Math.max(0, Math.floor(player.inventory[id]));
    }

    player.maps = Array.isArray(player.maps) ? player.maps : [];
    player.maps.forEach((map) => {
      map.id = map.id || uid('map');
      map.ownerId = player.id;
      map.mods = Array.isArray(map.mods) ? map.mods.filter((id) => MAP_MODS[id]) : [];
      map.tier = Math.max(1, Math.min(16, Math.round(map.tier || 1)));
      map.rarity = RARITY[map.rarity] ? map.rarity : 'normal';
      map.quality = typeof map.quality === 'number' ? map.quality : 0;
    });

    player.fragments = { hydra: 0, chimera: 0, phoenix: 0, minotaur: 0, ...(player.fragments || {}) };
    player.atlasPoints = Math.max(0, Number(player.atlasPoints) || 0);
    player.atlasPassives = Array.isArray(player.atlasPassives)
      ? player.atlasPassives.filter((id) => ATLAS_PASSIVES[id])
      : [];
    player.atlasCompleted = Array.isArray(player.atlasCompleted) ? player.atlasCompleted : [];

    player.bossKills = Math.max(0, Number(player.bossKills) || 0);
    player.mapsCompleted = Math.max(0, Number(player.mapsCompleted) || 0);
    player.portals = typeof player.portals === 'number' ? Math.max(0, player.portals) : TUNING.defaultPortalsPerDay;
    player.dailyRollsUsed = Math.max(0, Number(player.dailyRollsUsed) || 0);
    player.lastRollDay = player.lastRollDay || null;
    player.cooldownUntil = Number(player.cooldownUntil) || 0;
    player.charges = Math.max(0, Math.min(3, Number(player.charges) || 0));
    player.xp = Math.max(0, Number(player.xp) || 0);
    player.levelClaimed = Math.max(1, Number(player.levelClaimed) || 1);
    player.lastChestDay = player.lastChestDay || null;
    player.chestBonusMaps = Math.max(0, Number(player.chestBonusMaps) || 0);
    player.daily = player.daily && typeof player.daily === 'object'
      ? player.daily
      : { day: dayKey(now), counters: emptyCounters(), claimed: [] };
    player.daily.counters = { ...emptyCounters(), ...(player.daily.counters || {}) };
    player.daily.claimed = Array.isArray(player.daily.claimed) ? player.daily.claimed : [];
    player.stats = {
      totalRolls: 0,
      totalDamage: 0,
      bestScore: 0,
      crits: 0,
      vaals: 0,
      exaltsFound: 0,
      topTierFound: 0,
      duelsWon: 0,
      duelsLost: 0,
      raidDamage: 0,
      ...(player.stats || {}),
    };
    return player;
  }

  /* ── Персистентность ── */

  /** Помечает состояние изменённым и планирует запись. */
  touch({ immediate = false } = {}) {
    this.version += 1;
    this.db.meta.updatedAt = this.now();
    if (!this.persist) return this.version;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (immediate) {
      this.flushSync();
      return this.version;
    }
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushSync();
    }, 400);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
    return this.version;
  }

  flushSync() {
    if (!this.persist || !this.db) return false;
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const tmp = `${this.dbPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.db), 'utf8');
      fs.renameSync(tmp, this.dbPath);
      this.lastSavedAt = this.now();
      if (typeof this.onSave === 'function') {
        try {
          this.onSave(this.db, this.version);
        } catch (error) {
          this.log(`⚠️ onSave: ${error.message}`);
        }
      }
      return true;
    } catch (error) {
      this.log(`⚠️ Ошибка записи БД: ${error.message}`);
      return false;
    }
  }

  snapshot() {
    return deepClone(this.db);
  }

  /* ── Игроки ── */

  getPlayer(playerId) {
    return this.db.players.find((p) => p.id === playerId) || null;
  }

  getPlayerByTelegram(telegramId) {
    if (!telegramId) return null;
    return this.db.players.find((p) => String(p.telegramId) === String(telegramId)) || null;
  }

  getAdminPlayer() {
    return this.db.players.find((p) => p.isAdmin) || null;
  }

  getEquippedDie(player) {
    return (player.dice || []).find((d) => d.id === player.equippedDieId) || player.dice?.[0] || null;
  }

  getDie(player, dieId) {
    return (player.dice || []).find((d) => d.id === dieId) || null;
  }

  touchPlayer(player) {
    player.lastSeenAt = this.now();
  }

  /** Регистрирует или обновляет игрока из Telegram. */
  ensureTelegramPlayer(telegramUser) {
    if (!telegramUser?.id) throw new Error('Нужен объект пользователя Telegram.');
    let player = this.getPlayerByTelegram(telegramUser.id);
    if (player) {
      player.name = telegramUser.first_name || player.name;
      if (telegramUser.username) player.nickname = telegramUser.username;
      player.avatar = player.avatar || '🎲';
      this.touch();
      return { player, created: false };
    }
    const free = this.db.players.find((p) => !p.telegramId);
    if (free) {
      free.telegramId = telegramUser.id;
      free.name = telegramUser.first_name || free.name;
      free.nickname = telegramUser.username || free.nickname;
      free.lastSeenAt = this.now();
      this.touch();
      return { player: free, created: true, linked: true };
    }
    player = this.migratePlayer({
      id: uid('p'),
      name: telegramUser.first_name || 'Изгнанник',
      nickname: telegramUser.username || `dice_${telegramUser.id}`,
      avatar: '🎲',
      telegramId: telegramUser.id,
      isAdmin: false,
      inventory: emptyInventory(),
      dice: [generateDie({ rng: createRng(String(telegramUser.id)), rarity: 'normal' })],
      maps: [createEmptyMap({ tier: 1 })],
      atlasPoints: 1,
      xp: 0,
    }, this.now());
    player.dice[0].ownerId = player.id;
    player.equippedDieId = player.dice[0].id;
    this.db.players.push(player);
    this.pushFeed({
      kind: 'join',
      playerId: player.id,
      playerName: player.name,
      text: `🎲 ${player.name} присоединился к Убежищу Изгнанников.`,
    });
    this.touch({ immediate: true });
    return { player, created: true, linked: false };
  }

  /* ── День / ежедневные сбросы ── */

  ensureDay(player, now = this.now()) {
    const today = dayKey(now);
    if (player.lastRollDay !== today) {
      player.lastRollDay = today;
      player.dailyRollsUsed = 0;
    }
    if (!player.daily || player.daily.day !== today) {
      player.daily = { day: today, counters: emptyCounters(), claimed: [] };
    }
    return today;
  }

  /** Ежедневный картографический сундук. */
  ensureDailyChest(player) {
    const today = dayKey(this.now());
    const effects = getAtlasEffects(player);
    if (player.lastChestDay === today) {
      return {
        granted: false,
        portalsLeft: player.portals,
        maps: player.maps.map((m) => ({ id: m.id, tier: m.tier, name: m.name, rarity: m.rarity })),
      };
    }
    const maps = rollDailyMaps({ rng: createRng(`${player.id}:${today}`), extraMaps: effects.extraMaps + (player.chestBonusMaps || 0) });
    player.chestBonusMaps = 0;
    for (const map of maps) {
      map.ownerId = player.id;
      player.maps.push(map);
    }
    player.portals = TUNING.defaultPortalsPerDay + effects.extraPortals;
    player.lastChestDay = today;
    this.pushFeed({
      kind: 'chest',
      playerId: player.id,
      playerName: player.name,
      text: `📦 ${player.name} открыл Картографический сундук: ${maps.length} карт(ы) и ${player.portals} порталов.`,
    });
    this.touch();
    return {
      granted: true,
      maps: maps.map((m) => ({ id: m.id, tier: m.tier, name: m.name, rarity: m.rarity })),
      portals: player.portals,
    };
  }

  getRollLimit(player) {
    return Math.max(1, Number(this.db.settings.dailyRollsDefault) || TUNING.dailyRollsDefault);
  }

  /* ── Опыт / уровни ── */

  grantXp(player, amount, { rng = createRng() } = {}) {
    if (!amount || amount <= 0) return { gained: 0, levelUp: false };
    const before = levelFromXp(player.xp || 0);
    player.xp = (player.xp || 0) + Math.round(amount);
    const after = levelFromXp(player.xp);
    if (after > before) {
      const rewards = {};
      for (let level = before + 1; level <= after; level += 1) {
        const loot = levelRewards(level, rng || createRng());
        for (const [orbId, count] of Object.entries(loot)) {
          rewards[orbId] = (rewards[orbId] || 0) + count;
        }
        if (level % 5 === 0) player.atlasPoints = (player.atlasPoints || 0) + 1;
      }
      for (const [orbId, count] of Object.entries(rewards)) {
        player.inventory[orbId] = (player.inventory[orbId] || 0) + count;
      }
      this.pushFeed({
        kind: 'level',
        playerId: player.id,
        playerName: player.name,
        text: `🎖️ ${player.name} достиг уровня ${after}!`,
        meta: { rewards },
      });
      return { gained: amount, levelUp: true, level: after, rewards };
    }
    return { gained: amount, levelUp: false, level: after };
  }

  /* ── Лента ── */

  pushFeed({ kind = 'info', playerId = null, playerName = null, text = '', meta = null }) {
    const entry = {
      id: uid('feed'),
      at: this.now(),
      kind,
      playerId,
      playerName,
      text,
      meta,
    };
    this.db.feed.unshift(entry);
    if (this.db.feed.length > TUNING.feedLimit) this.db.feed.length = TUNING.feedLimit;
    return entry;
  }

  /* ── Задания ── */

  getQuests(player) {
    this.ensureDay(player);
    const quests = questsForDay(player.daily.day);
    return quests.map((quest) => {
      const progress = Math.min(quest.target, player.daily.counters[quest.counter] || 0);
      return {
        ...quest,
        progress,
        done: progress >= quest.target,
        claimed: player.daily.claimed.includes(quest.id),
      };
    });
  }

  claimQuest(player, questId) {
    this.ensureDay(player);
    const quests = this.getQuests(player);
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return { ok: false, reason: 'Задание не найдено сегодня.' };
    if (!quest.done) return { ok: false, reason: 'Задание ещё не выполнено.' };
    if (quest.claimed) return { ok: false, reason: 'Награда уже получена.' };
    player.daily.claimed.push(quest.id);
    for (const [orbId, count] of Object.entries(quest.reward || {})) {
      player.inventory[orbId] = (player.inventory[orbId] || 0) + count;
    }
    if (quest.atlasPoint) player.atlasPoints = (player.atlasPoints || 0) + quest.atlasPoint;
    const xpResult = this.grantXp(player, quest.xp || 0);
    this.pushFeed({
      kind: 'quest',
      playerId: player.id,
      playerName: player.name,
      text: `📜 ${player.name} выполнил задание «${quest.name}»${quest.atlasPoint ? ' (+1 Очко Атласа)' : ''}.`,
    });
    this.touch();
    return {
      ok: true,
      quest,
      rewards: quest.reward,
      atlasPoint: quest.atlasPoint || 0,
      xp: xpResult,
      message: `📜 Награда за «${quest.name}» получена.`,
    };
  }

  incrementCounter(player, key, amount = 1) {
    this.ensureDay(player);
    player.daily.counters[key] = (player.daily.counters[key] || 0) + amount;
  }

  /* ── Ежедневный бросок ── */

  roll(player) {
    const now = this.now();
    this.ensureDay(player, now);
    if (player.cooldownUntil && player.cooldownUntil > now) {
      return {
        ok: false,
        reason: `Кулдаун до ${new Date(player.cooldownUntil).toLocaleTimeString('ru-RU')}.`,
        cooldownUntil: player.cooldownUntil,
      };
    }
    const limit = this.getRollLimit(player);
    if (player.dailyRollsUsed >= limit) {
      return {
        ok: false,
        reason: limit === 1 ? 'Сегодняшний бросок уже сделан. Возвращайтесь после 00:00.' : `Лимит бросков исчерпан (${limit}).`,
        rollsLeft: 0,
      };
    }
    const die = this.getEquippedDie(player);
    if (!die) return { ok: false, reason: 'Нет экипированного кубика.' };

    const rng = createRng(`${player.id}:${now}:${player.dailyRollsUsed}`);
    const partyAuras = getPartyAuras(this.db.players, { excludeId: player.id });
    const stats = getDieAggregatedStats(die);
    const buffs = { scoreBonus: 0 };
    const modifiers = {};
    if (player.charges > 0) {
      modifiers.incScorePct = 25;
      player.charges -= 1;
    }

    const result = rollDailyDie({
      die,
      rng,
      partyAuras,
      buffs,
      modifiers,
      bossKills: player.bossKills || 0,
    });

    player.dailyRollsUsed += 1;
    player.stats.totalRolls += 1;

    /* Урон боссу чата */
    const boss = this.db.chat.boss;
    const damageResult = applyBossDamage(boss, result.damage, {
      culling: stats.cullingStrike,
      rng,
    });
    player.stats.totalDamage += damageResult.applied;
    player.stats.bestScore = Math.max(player.stats.bestScore, result.score);
    if (result.crit) player.stats.crits += 1;
    this.db.chat.totalRolls += 1;
    this.incrementCounter(player, 'rolls', 1);

    /* Валюта */
    for (const orb of result.orbs) {
      player.inventory[orb.id] = (player.inventory[orb.id] || 0) + orb.count;
    }

    /* Заряды */
    if (stats.chargeChance > 0 && rng() * 100 < stats.chargeChance) {
      player.charges = Math.min(3, player.charges + 1);
      result.charges = player.charges;
    }

    /* Опыт */
    const xpGain = 10 + Math.round(result.score / 25);
    const xp = this.grantXp(player, xpGain, { rng });

    let bossDefeated = null;
    if (damageResult.killed) {
      const previousBoss = { ...boss };
      player.bossKills = (player.bossKills || 0) + 1;
      this.incrementCounter(player, 'bossKills', 1);
      this.db.chat.defeatedBosses = (this.db.chat.defeatedBosses || 0) + 1;
      const nextLevel = (boss.level || 1) + 1;
      this.db.chat.boss = getNewBoss({ level: nextLevel, rng });
      const bonus = rollOrbDrop({ rng, count: 5, rarityPct: 80 });
      for (const orb of bonus) {
        player.inventory[orb.id] = (player.inventory[orb.id] || 0) + orb.count;
      }
      bossDefeated = { boss: previousBoss, next: this.db.chat.boss, bonus };
      result.orbs.push(...bonus);
      this.pushFeed({
        kind: 'boss',
        playerId: player.id,
        playerName: player.name,
        text: `💀 ${player.name} добил ${previousBoss.icon} ${previousBoss.name}! Призван ${this.db.chat.boss.name} (${this.db.chat.boss.maxHp} HP).`,
        meta: { bonus },
      });
    }

    /* Лента */
    const tierEvent = this.pickFeedEvent(result, die, stats);
    this.pushFeed({
      kind: tierEvent.kind,
      playerId: player.id,
      playerName: player.name,
      text: tierEvent.text,
      meta: {
        score: result.score,
        damage: result.damage,
        crit: result.crit,
        orbs: result.orbs,
      },
    });

    /* Ачивки-статистика */
    for (const orb of result.orbs) {
      if (orb.id === 'exalted') player.stats.exaltsFound += 1;
    }
    if (hasTopTier(die, ['T1', 'T0'])) player.stats.topTierFound += 1;

    this.touch();
    return {
      ok: true,
      roll: result,
      damage: damageResult,
      boss: this.db.chat.boss,
      bossDefeated,
      orbs: result.orbs,
      partyAuras,
      xp,
      charges: player.charges,
      rollsLeft: Math.max(0, this.getRollLimit(player) - player.dailyRollsUsed),
      cooldownUntil: 0,
      feedEvent: tierEvent,
    };
  }

  pickFeedEvent(result, die, stats) {
    if (result.orbs.some((o) => o.id === 'divine')) {
      return { kind: 'divine', text: `✨ ${die.name}: выпал Дивайн!` };
    }
    if (result.orbs.some((o) => o.id === 'exalted')) {
      return { kind: 'exalt', text: `🌟 ${die.name}: выпал Экзальт!` };
    }
    if (hasTopTier(die, ['T1', 'T0']) && result.crit) {
      return { kind: 'top_tier', text: `🏆 ${die.name}: крит с [T1] модом на ${result.score} очков!` };
    }
    if (result.crit) {
      return { kind: 'crit', text: `💥 ${die.name}: КРИТ на ${result.score} очков и ${result.damage} урона.` };
    }
    if (result.echoes) {
      return { kind: 'echo', text: `🔁 ${die.name}: Эхо x${result.echoes}, ${result.score} очков.` };
    }
    return {
      kind: 'roll',
      text: `🎲 ${die.name}: ${result.score} очков, ${result.damage} урона по боссу.`,
    };
  }

  /* ── Крафт кубика ── */

  craftOrb(player, { dieId, orbId }) {
    const die = this.getDie(player, dieId) || this.getEquippedDie(player);
    if (!die) return { ok: false, reason: 'Кубик не найден.' };
    if ((player.inventory[orbId] || 0) <= 0) {
      return { ok: false, reason: `Нет сферы «${CURRENCIES[orbId]?.name || orbId}».` };
    }
    const usable = applyOrbToDie({ die, orbId, rng: createRng() });
    if (!usable.ok) return { ok: false, reason: usable.reason, die };

    player.inventory[orbId] = Math.max(0, (player.inventory[orbId] || 0) - 1);
    if (usable.freeOrb) {
      player.inventory[orbId] += 1;
    }
    this.incrementCounter(player, 'crafts', 1);
    this.grantXp(player, 6);

    const effects = getAtlasEffects(player);
    let bonusOrb = null;
    if (orbId === 'alteration' && effects.alterToChaos > 0 && Math.random() * 100 < effects.alterToChaos) {
      player.inventory.chaos = (player.inventory.chaos || 0) + 1;
      bonusOrb = 'chaos';
    }
    if (orbId === 'vaal') player.stats.vaals += 1;

    if (['exalt', 'divine', 'vaal_implicit', 'tier_zero'].includes(usable.event?.kind)
      || usable.event?.outcome === 'tier_zero') {
      this.pushFeed({
        kind: usable.event?.outcome === 'tier_zero' ? 'top_tier' : usable.event?.kind || 'exalt',
        playerId: player.id,
        playerName: player.name,
        text: `⚒️ ${player.name}: ${usable.message}`,
      });
    }

    this.touch();
    return {
      ok: true,
      die,
      message: usable.message,
      freeOrb: Boolean(usable.freeOrb),
      bonusOrb,
      event: usable.event,
      rarity: die.rarity,
      quality: die.quality,
      mods: die.mods,
      corrupted: die.corrupted,
    };
  }

  craftBench(player, { dieId, recipeId }) {
    const die = this.getDie(player, dieId) || this.getEquippedDie(player);
    if (!die) return { ok: false, reason: 'Кубик не найден.' };
    const recipe = BENCH_RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return { ok: false, reason: 'Неизвестный рецепт.' };
    const effects = getAtlasEffects(player);
    const cost = getBenchCost(recipe, effects.benchDiscount);
    for (const [orbId, amount] of Object.entries(cost)) {
      if ((player.inventory[orbId] || 0) < amount) {
        return {
          ok: false,
          reason: `Не хватает ${CURRENCIES[orbId]?.name} (нужно ${amount}, есть ${player.inventory[orbId] || 0}).`,
          cost,
        };
      }
    }
    const result = applyBenchRecipe({ die, recipeId });
    if (!result.ok) return { ok: false, reason: result.reason, die };
    for (const [orbId, amount] of Object.entries(cost)) {
      player.inventory[orbId] -= amount;
    }
    this.incrementCounter(player, 'crafts', 1);
    this.grantXp(player, 8);
    this.touch();
    return { ok: true, die, cost, message: result.message, recipe };
  }

  /* ── Инвентарь ── */

  equipDie(player, dieId) {
    const die = this.getDie(player, dieId);
    if (!die) return { ok: false, reason: 'Кубик не найден в инвентаре.' };
    player.equippedDieId = die.id;
    this.touch();
    return { ok: true, die, message: `Экипирован ${die.name}.` };
  }

  toggleLock(player, dieId) {
    const die = this.getDie(player, dieId);
    if (!die) return { ok: false, reason: 'Кубик не найден.' };
    die.locked = !die.locked;
    this.touch();
    return { ok: true, die, message: die.locked ? 'Кубик заперт.' : 'Замок снят.' };
  }

  buyBase(player, baseId) {
    const result = buyDieBase({ player, baseId, bossKills: player.bossKills });
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'buy',
      playerId: player.id,
      playerName: player.name,
      text: `🛒 ${player.name} купил базу ${result.die.name}.`,
    });
    this.touch();
    return result;
  }

  gambleUnique(player) {
    const result = gambleUnique({ player });
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'gamble',
      playerId: player.id,
      playerName: player.name,
      text: `🎰 ${player.name} выкрутил ${result.die.name} у Гвеннен!`,
    });
    this.touch();
    return result;
  }

  salvage(player, dieId) {
    const die = this.getDie(player, dieId);
    const result = salvageDie({ player, die });
    if (!result.ok) return result;
    this.touch();
    return result;
  }

  /* ── Обмен сферами ── */

  transferOrbs(player, { toPlayerId, orbId, amount }) {
    const target = this.getPlayer(toPlayerId);
    if (!target) return { ok: false, reason: 'Получатель не найден.' };
    if (target.id === player.id) return { ok: false, reason: 'Нельзя передать сферы самому себе.' };
    if (!CURRENCIES[orbId]) return { ok: false, reason: 'Неизвестная сфера.' };
    const count = Math.max(1, Math.floor(Number(amount) || 0));
    if ((player.inventory[orbId] || 0) < count) {
      return { ok: false, reason: 'Недостаточно сфер.' };
    }
    player.inventory[orbId] -= count;
    target.inventory[orbId] = (target.inventory[orbId] || 0) + count;
    this.pushFeed({
      kind: 'trade',
      playerId: player.id,
      playerName: player.name,
      text: `🤝 ${player.name} передал ${CURRENCIES[orbId].icon}${count} ${CURRENCIES[orbId].name} → ${target.name}.`,
    });
    this.touch();
    return { ok: true, message: 'Передача выполнена.', target: target.name, orb: CURRENCIES[orbId], amount: count };
  }

  /* ── Карты ── */

  craftMapOrb(player, { mapId, orbId }) {
    const map = (player.maps || []).find((m) => m.id === mapId);
    if (!map) return { ok: false, reason: 'Карта не найдена.' };
    if ((player.inventory[orbId] || 0) <= 0) {
      return { ok: false, reason: `Нет сферы «${CURRENCIES[orbId]?.name || orbId}».` };
    }
    const result = craftMap({ map, orbId, rng: createRng() });
    if (!result.ok) return { ok: false, reason: result.reason, map };
    player.inventory[orbId] = Math.max(0, (player.inventory[orbId] || 0) - 1);
    this.incrementCounter(player, 'crafts', 1);
    this.grantXp(player, 4);
    this.touch();
    return { ok: true, map, message: result.message, event: result.event };
  }

  buyMap(player) {
    const cost = kiracCost();
    for (const [orbId, amount] of Object.entries(cost)) {
      if ((player.inventory[orbId] || 0) < amount) {
        return {
          ok: false,
          reason: `Кирак просит ${Object.entries(cost).map(([id, n]) => `${CURRENCIES[id].icon}${n}`).join(' + ')}.`,
        };
      }
    }
    for (const [orbId, amount] of Object.entries(cost)) {
      player.inventory[orbId] -= amount;
    }
    const tier = randInt(createRng(`${player.id}:${Date.now()}`), 1, Math.max(1, Math.min(16, player.mapsCompleted + 2)));
    const map = createEmptyMap({ tier, ownerId: player.id });
    player.maps.push(map);
    this.touch();
    return { ok: true, map, message: `Кирак продал карту T${map.tier} «${map.name}».`, cost };
  }

  /* ── Поход по карте ── */

  startMap(player, { mapId, partnerId = null }) {
    if (this.db.atlas.activeRuns[player.id]) {
      return { ok: false, reason: 'Сначала завершите текущий поход.' };
    }
    const map = (player.maps || []).find((m) => m.id === mapId);
    if (!map) return { ok: false, reason: 'Карта не найдена в тайнике.' };
    if (player.portals <= 0) {
      return { ok: false, reason: 'Нет порталов. Новые появятся с ежедневным сундуком.' };
    }
    let partner = null;
    if (partnerId) {
      partner = this.getPlayer(partnerId);
      if (!partner || partner.id === player.id) return { ok: false, reason: 'Напарник не найден.' };
    }
    const rng = createRng(`${player.id}:${map.id}:${this.now()}`);
    const run = startRun({ player, map, partner, rng });
    player.maps = player.maps.filter((m) => m.id !== map.id);
    player.portals -= 1;
    this.db.atlas.activeRuns[player.id] = run;
    this.pushFeed({
      kind: 'map_start',
      playerId: player.id,
      playerName: player.name,
      text: `🗺️ ${player.name} вошёл в T${map.tier} «${map.name}»${partner ? ` вместе с ${partner.name}` : ''}.`,
    });
    this.touch();
    return { ok: true, run: publicRun(run), map: run.map, message: `Поход T${run.tier} начат. Узлов: ${run.graph.nodes.length}.` };
  }

  getActiveRun(player) {
    return this.db.atlas.activeRuns[player.id] || null;
  }

  chooseNode(player, { nodeId }) {
    const run = this.getActiveRun(player);
    if (!run) return { ok: false, reason: 'Нет активного похода.' };
    const result = chooseMapNode({ run, player, nodeId, rng: createRng() });
    if (!result.ok) return result;
    this.touch();
    return {
      ...result,
      run: publicRun(run),
      report: this.finalizeRunIfNeeded(player, run),
    };
  }

  mapTurn(player, { action, orbId }) {
    const run = this.getActiveRun(player);
    if (!run) return { ok: false, reason: 'Нет активного похода.' };
    const before = run.nodesCleared;
    const result = resolveMapTurn({ run, player, action, orbId, rng: createRng() });
    if (!result.ok) return result;
    if (run.nodesCleared > before) {
      this.incrementCounter(player, 'nodes', 1);
      this.grantXp(player, 8);
    }
    const report = this.finalizeRunIfNeeded(player, run);
    this.touch();
    return { ...result, run: publicRun(run), report };
  }

  retreat(player) {
    const run = this.getActiveRun(player);
    if (!run) return { ok: false, reason: 'Нет активного похода.' };
    const result = retreatRun({ run, player });
    if (!result.ok) return result;
    const report = this.finalizeRunIfNeeded(player, run);
    this.touch();
    return { ...result, report, run: publicRun(run) };
  }

  dismiss(player) {
    const run = this.getActiveRun(player);
    if (!run) return { ok: false, reason: 'Нет активного похода.' };
    if (![RUN_PHASES.victory, RUN_PHASES.defeat, RUN_PHASES.retreat].includes(run.phase)) {
      return { ok: false, reason: 'Поход ещё не завершён — отступите или добейте босса.' };
    }
    player.lastReport = run.report || null;
    delete this.db.atlas.activeRuns[player.id];
    this.db.atlas.history.unshift({
      runId: run.id,
      playerId: player.id,
      tier: run.tier,
      mapName: run.map?.name,
      outcome: run.phase,
      at: this.now(),
      report: run.report,
    });
    this.db.atlas.history = this.db.atlas.history.slice(0, 30);
    this.touch();
    return { ok: true, message: 'Отчёт закрыт.' };
  }

  autoRun(player, { mapId, partnerId = null }) {
    const started = this.startMap(player, { mapId, partnerId });
    if (!started.ok) return started;
    const run = this.getActiveRun(player);
    const result = autoResolveRun({ run, player, rng: createRng() });
    const report = this.finalizeRunIfNeeded(player, run);
    this.touch();
    return { ok: true, report, run: publicRun(run), turns: result.turns.length, message: report?.outcome === 'victory' ? 'Карта пройдена полностью!' : 'Поход завершён.' };
  }

  /** Начисляет награды и раздаёт добычу напарнику. */
  finalizeRunIfNeeded(player, run) {
    if (!run?.report || run.settled) return null;
    run.settled = true;
    const report = run.report;

    // Дуо: напарник получает половину валюты и половину опыта.
    if (run.partnerId) {
      const partner = this.getPlayer(run.partnerId);
      if (partner) {
        const shared = {};
        for (const [orbId, count] of Object.entries(report.gained || {})) {
          const half = Math.floor(count / 2);
          if (half > 0) {
            partner.inventory[orbId] = (partner.inventory[orbId] || 0) + half;
            shared[orbId] = half;
          }
        }
        report.partnerShare = shared;
        partner.mapsCompleted = (partner.mapsCompleted || 0) + (report.outcome === 'victory' ? 1 : 0);
        this.grantXp(partner, Math.round((report.outcome === 'victory' ? 30 : 10) / 2));
        this.pushFeed({
          kind: 'map_duo',
          playerId: partner.id,
          playerName: partner.name,
          text: `🤝 ${partner.name} получил долю добычи из похода T${report.tier}: ${Object.entries(shared).map(([id, n]) => `${CURRENCIES[id]?.icon || ''}${n}`).join(' ') || 'без валюты'}.`,
        });
      }
    }

    if (report.outcome === 'victory') {
      this.incrementCounter(player, 'maps', 1);
      this.grantXp(player, 25 + report.tier * 3);
      this.pushFeed({
        kind: 'map_win',
        playerId: player.id,
        playerName: player.name,
        text: `🏆 ${player.name} зачистил T${report.tier} «${report.mapName}»! ${report.atlas?.atlasPoint ? '+1 Очко Атласа. ' : ''}Добыча: ${Object.entries(report.gained).map(([id, n]) => `${CURRENCIES[id]?.icon || ''}${n}`).join(' ') || '—'}`,
      });
      for (const map of report.atlas?.maps || []) {
        this.pushFeed({
          kind: 'map_drop',
          playerId: player.id,
          playerName: player.name,
          text: `🗺️ ${player.name} выбил карту T${map.tier} «${map.name}».`,
        });
      }
    }
    return report;
  }

  /* ── Атлас ── */

  learnAtlasPassive(player, passiveId) {
    const result = learnPassive(player, passiveId);
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'atlas',
      playerId: player.id,
      playerName: player.name,
      text: `🌳 ${player.name} изучил пассивку ${result.passive.icon} ${result.passive.name}.`,
    });
    this.touch();
    return result;
  }

  depositFragment(player, fragmentId) {
    const result = depositFragment(this.db, player, fragmentId);
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'fragment',
      playerId: player.id,
      playerName: player.name,
      text: `💠 ${player.name} сдал фрагмент в Реликварий (${result.total}/4).`,
    });
    this.touch();
    return result;
  }

  /* ── Рейд ── */

  summonRaid(player) {
    const result = summonRaid(this.db, player);
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'raid_summon',
      playerId: player.id,
      playerName: player.name,
      text: `🚨 ${result.message}`,
    });
    this.touch();
    return result;
  }

  raidAttack(player) {
    const result = raidAttack({ db: this.db, player, rng: createRng() });
    if (!result.ok) return result;
    player.stats.raidDamage = (player.stats.raidDamage || 0) + result.damage;
    this.incrementCounter(player, 'raidDamage', result.damage);
    this.grantXp(player, Math.min(40, Math.round(result.damage / 50)));
    this.pushFeed({
      kind: result.killed ? 'raid_kill' : 'raid_attack',
      playerId: player.id,
      playerName: player.name,
      text: result.killed
        ? `🏆 ${player.name} нанёс последний удар! ${result.message}`
        : `🚨 ${player.name} нанёс ${result.damage} урона рейд-боссу.`,
    });
    this.touch();
    return result;
  }

  raidClaim(player) {
    const result = claimRaidLoot(this.db, player);
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'raid_loot',
      playerId: player.id,
      playerName: player.name,
      text: `🎁 ${player.name} забрал награду рейда${result.isMvp ? ' как MVP' : ''}.`,
    });
    this.touch();
    return result;
  }

  raidRollLoot(player) {
    const result = rollRaidLoot(this.db, player);
    if (!result.ok) return result;
    this.pushFeed({
      kind: 'raid_roll',
      playerId: player.id,
      playerName: player.name,
      text: `🎲 ${result.message}`,
    });
    this.touch();
    return result;
  }

  /* ── Дуэли ── */

  duel(player, { opponentId }) {
    const opponent = this.getPlayer(opponentId);
    if (!opponent) return { ok: false, reason: 'Противник не найден.' };
    if (opponent.id === player.id) return { ok: false, reason: 'Нельзя вызвать самого себя.' };
    this.ensureDay(player);
    if ((player.daily.counters.duels || 0) >= TUNING.duelDailyLimit) {
      return { ok: false, reason: `Лимит дуэлей на сегодня (${TUNING.duelDailyLimit}).` };
    }
    const rng = createRng(`${player.id}:${opponent.id}:${this.now()}`);
    const myRoll = rollDailyDie({ die: this.getEquippedDie(player), rng, bossKills: player.bossKills });
    const theirRoll = rollDailyDie({ die: this.getEquippedDie(opponent), rng, bossKills: opponent.bossKills });
    const myScore = myRoll.score;
    const theirScore = theirRoll.score;
    const won = myScore >= theirScore;
    const result = {
      id: uid('duel'),
      at: this.now(),
      challengerId: player.id,
      challengerName: player.name,
      opponentId: opponent.id,
      opponentName: opponent.name,
      challengerScore: myScore,
      opponentScore: theirScore,
      winnerId: won ? player.id : opponent.id,
      rolls: {
        challenger: { face: myRoll.sumFaces, crit: myRoll.crit, echoes: myRoll.echoes },
        opponent: { face: theirRoll.sumFaces, crit: theirRoll.crit, echoes: theirRoll.echoes },
      },
    };
    player.daily.counters.duels += 1;
    if (won) {
      player.daily.counters.duelWins = (player.daily.counters.duelWins || 0) + 1;
      player.stats.duelsWon += 1;
      const prize = Math.max(1, Math.round(theirScore / 40));
      player.inventory.chaos = (player.inventory.chaos || 0) + prize;
      this.grantXp(player, 15);
      this.pushFeed({
        kind: 'duel',
        playerId: player.id,
        playerName: player.name,
        text: `🤺 ${player.name} (${myScore}) победил ${opponent.name} (${theirScore}) в дуэли и забрал 🎭${prize}.`,
      });
      result.prize = { chaos: prize };
    } else {
      player.stats.duelsLost += 1;
      this.pushFeed({
        kind: 'duel',
        playerId: opponent.id,
        playerName: opponent.name,
        text: `🤺 ${opponent.name} (${theirScore}) обыграл ${player.name} (${myScore}) в дуэли.`,
      });
    }
    this.db.duels.unshift(result);
    this.db.duels = this.db.duels.slice(0, 30);
    this.touch();
    return { ok: true, duel: result, won, prize: result.prize || null, myRoll, theirRoll };
  }

  /* ── Админка ── */

  setDailyLimit(actor, limit) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    const value = Math.max(1, Math.min(10, Math.round(Number(limit) || 1)));
    this.db.settings.dailyRollsDefault = value;
    for (const player of this.db.players) {
      if (player.dailyRollsUsed > value) player.dailyRollsUsed = value;
    }
    this.pushFeed({
      kind: 'admin',
      playerId: actor.id,
      playerName: actor.name,
      text: `🛠️ ${actor.name} установил лимит броска: ${value}/день.`,
    });
    this.touch({ immediate: true });
    return { ok: true, limit: value };
  }

  resetCooldown(actor, playerId = null) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    const targets = playerId ? [this.getPlayer(playerId)].filter(Boolean) : this.db.players;
    for (const player of targets) {
      player.cooldownUntil = 0;
      player.dailyRollsUsed = 0;
      player.lastRollDay = null;
      player.portals = Math.max(player.portals, 1);
    }
    this.pushFeed({
      kind: 'admin',
      playerId: actor.id,
      playerName: actor.name,
      text: `🛠️ ${actor.name} сбросил кулдаун броска${playerId ? '' : ' всем'}.`,
    });
    this.touch({ immediate: true });
    return { ok: true, affected: targets.length };
  }

  resetBoss(actor) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    this.db.chat.boss = getNewBoss({ level: 1, rng: createRng(this.now()) });
    this.pushFeed({
      kind: 'admin',
      playerId: actor.id,
      playerName: actor.name,
      text: `🛠️ ${actor.name} призвал нового босса: ${this.db.chat.boss.name}.`,
    });
    this.touch({ immediate: true });
    return { ok: true, boss: this.db.chat.boss };
  }

  resetLadder(actor) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    for (const player of this.db.players) {
      player.stats.bestScore = 0;
      player.stats.totalDamage = 0;
    }
    this.db.settings.ladderResetAt = this.now();
    this.pushFeed({
      kind: 'admin',
      playerId: actor.id,
      playerName: actor.name,
      text: `🛠️ ${actor.name} обнулил ладдер.`,
    });
    this.touch({ immediate: true });
    return { ok: true };
  }

  resetAll(actor, code) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    if (String(code || '').trim().toUpperCase() !== 'ВАЙП') {
      return { ok: false, reason: 'Неверное кодовое слово. Введите ВАЙП.' };
    }
    const keepTelegram = this.db.players.map((p) => ({ id: p.id, telegramId: p.telegramId }));
    this.db = this.migrate(this.createSeed());
    for (const player of this.db.players) {
      const match = keepTelegram.find((k) => k.id === player.id);
      player.telegramId = match?.telegramId || null;
    }
    this.pushFeed({ kind: 'admin', text: '💥 Полный вайп прогресса. Атлас сброшен.' });
    this.touch({ immediate: true });
    return { ok: true, message: 'Полный вайп выполнен.' };
  }

  resetAtlas(actor, playerId) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    const player = this.getPlayer(playerId);
    if (!player) return { ok: false, reason: 'Игрок не найден.' };
    player.atlasPassives = [];
    player.atlasCompleted = [];
    player.atlasPoints = Math.max(1, player.atlasPoints);
    this.pushFeed({
      kind: 'admin',
      playerId: actor.id,
      playerName: actor.name,
      text: `🛠️ ${actor.name} сбросил дерево Атласа игрока ${player.name}.`,
    });
    this.touch({ immediate: true });
    return { ok: true, playerId };
  }

  setAtlasPoints(actor, playerId, points) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    const player = this.getPlayer(playerId);
    if (!player) return { ok: false, reason: 'Игрок не найден.' };
    player.atlasPoints = Math.max(0, Math.min(99, Math.round(Number(points) || 0)));
    this.touch({ immediate: true });
    return { ok: true, atlasPoints: player.atlasPoints };
  }

  cheatOrbs(actor, playerId, orbId, delta) {
    if (!this.isAdmin(actor)) return { ok: false, reason: 'Только администратор.' };
    const player = this.getPlayer(playerId);
    if (!player) return { ok: false, reason: 'Игрок не найден.' };
    if (!CURRENCIES[orbId]) return { ok: false, reason: 'Неизвестная сфера.' };
    player.inventory[orbId] = Math.max(0, (player.inventory[orbId] || 0) + Math.round(Number(delta) || 0));
    this.touch({ immediate: true });
    return { ok: true, inventory: player.inventory };
  }

  isAdmin(player) {
    if (!player) return false;
    if (player.isAdmin) return true;
    const adminTelegram = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;
    return Boolean(adminTelegram && String(player.telegramId) === adminTelegram);
  }

  /* ── Состояние для клиента ── */

  publicDie(die) {
    if (!die) return null;
    const stats = getDieAggregatedStats(die);
    return {
      ...die,
      power: estimateDiePower(die),
      stats,
      topTier: stats.topTier,
      modCount: die.mods.length,
      rarityLabel: RARITY[die.rarity]?.label || die.rarity,
      rarityIcon: RARITY[die.rarity]?.icon || '⚪',
    };
  }

  publicPlayer(player, { self = false } = {}) {
    const equipped = this.getEquippedDie(player);
    const level = xpProgress(player.xp || 0);
    const effects = getAtlasEffects(player);
    return {
      id: player.id,
      name: player.name,
      nickname: player.nickname,
      avatar: player.avatar,
      role: player.role,
      isAdmin: this.isAdmin(player),
      telegramLinked: Boolean(player.telegramId),
      equippedDieId: player.equippedDieId,
      equippedDie: this.publicDie(equipped),
      dice: player.dice.map((die) => this.publicDie(die)),
      power: estimateDiePower(equipped),
      level,
      atlasPoints: player.atlasPoints,
      atlasPassives: player.atlasPassives,
      atlasCompleted: player.atlasCompleted,
      atlasEffects: effects,
      bossKills: player.bossKills,
      mapsCompleted: player.mapsCompleted,
      portals: player.portals,
      fragments: player.fragments,
      charges: player.charges,
      xp: player.xp,
      stats: player.stats,
      quests: self ? this.getQuests(player) : undefined,
      inventory: self ? player.inventory : undefined,
      maps: self ? player.maps : undefined,
      lastReport: self ? player.lastReport : undefined,
      rollsLeft: Math.max(0, this.getRollLimit(player) - player.dailyRollsUsed),
      rollLimit: this.getRollLimit(player),
      cooldownUntil: player.cooldownUntil,
      dailyCounters: self ? player.daily.counters : undefined,
      activeRun: self ? publicRun(this.getActiveRun(player)) : undefined,
      lastSeenAt: player.lastSeenAt,
    };
  }

  getLadder() {
    return this.db.players
      .map((player) => {
        const equipped = this.getEquippedDie(player);
        const power = estimateDiePower(equipped);
        const level = levelFromXp(player.xp || 0);
        return {
          id: player.id,
          name: player.name,
          avatar: player.avatar,
          isAdmin: this.isAdmin(player),
          power,
          level,
          bossKills: player.bossKills,
          mapsCompleted: player.mapsCompleted,
          bestScore: player.stats.bestScore,
          totalDamage: player.stats.totalDamage,
          raidDamage: player.stats.raidDamage,
          score: Math.round(power * 3 + level * 8 + player.bossKills * 25 + player.mapsCompleted * 5),
          die: equipped ? { name: equipped.name, icon: equipped.icon, rarity: equipped.rarity } : null,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  /** Полный слепок состояния для клиента. */
  getState(player, { sinceVersion = null } = {}) {
    // Сначала отдаём «unchanged», чтобы поллинг не гонял тяжёлый слепок,
    // но ежедневный сундук всё равно проверяем (он меняет версию при выдаче).
    if (player) this.ensureDailyChest(player);
    if (sinceVersion !== null && Number(sinceVersion) === this.version) {
      return { unchanged: true, version: this.version };
    }
    const self = player;
    return {
      version: this.version,
      serverTime: this.now(),
      schema: this.db.schema,
      selfId: player?.id || null,
      self: player ? this.publicPlayer(player, { self: true }) : null,
      players: this.db.players.map((p) => this.publicPlayer(p, { self: p.id === player?.id })),
      chat: {
        id: this.db.chat.id,
        name: this.db.chat.name,
        boss: this.db.chat.boss,
        defeatedBosses: this.db.chat.defeatedBosses,
        totalRolls: this.db.chat.totalRolls,
      },
      settings: this.db.settings,
      feed: this.db.feed.slice(0, 40),
      ladder: this.getLadder(),
      raid: getRaidStatus(this.db, player?.id || null),
      duels: this.db.duels.slice(0, 10),
      activeRun: player ? publicRun(this.getActiveRun(player)) : null,
      atlasHistory: this.db.atlas.history.filter((h) => !player || h.playerId === player.id).slice(0, 8),
      constants: this.getConstantsForClient(),
    };
  }

  /** Неизменяемые справочники — отдаём один раз при инициализации. */
  getConstantsForClient() {
    return {
      currencies: CURRENCY_DISPLAY_ORDER.map((id) => CURRENCIES[id]),
      bases: DICE_BASE_LIST,
      rarities: RARITY,
      atlasPassives: ATLAS_PASSIVES,
      atlasBranches: ATLAS_BRANCHES,
      fragments: FRAGMENTS,
      raidBosses: RAID_BOSSES,
      raidConfig: RAID_CONFIG,
      mapZones: MAP_ZONES,
      mapMods: MAP_MODS,
      nodeTypes: MAP_NODE_TYPES,
      uniqueDice: Object.values(UNIQUE_DICE).map((u) => ({
        id: u.id, name: u.name, icon: u.icon, base: u.base, flavor: u.flavor, special: u.special,
      })),
      questPool: QUEST_POOL,
      affixes: AFFIX_LIST.map((affix) => ({
        id: affix.id,
        name: affix.name,
        type: affix.type,
        key: affix.key,
        stat: affix.stat,
        unit: affix.unit,
        weight: affix.weight,
        tiers: affix.tiers,
      })),
      benchRecipes: BENCH_RECIPES,
      combatActions: COMBAT_ACTIONS,
      battleOrbs: MAP_BATTLE_ORBS,
      bossIntents: BOSS_INTENTS,
      rarityOrder: RARITY_ORDER,
      gamblePrice: UNIQUE_GAMBLE_PRICE,
      kiracCost: kiracCost(),
      tuning: TUNING,
      levelCurve: Array.from({ length: 12 }, (_, i) => ({ level: i + 1, xp: xpForLevel(i + 1) })),
    };
  }

  /* ── Статистика для /health ── */

  healthInfo() {
    return {
      players: this.db.players.length,
      version: this.version,
      bossHp: this.db.chat.boss.hp,
      raidActive: Boolean(this.db.raid.active),
      activeRuns: Object.keys(this.db.atlas.activeRuns).length,
      feedSize: this.db.feed.length,
      savedAt: this.lastSavedAt,
    };
  }

  shutdown() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this.persist) this.flushSync();
  }
}

export { deepClone, emptyInventory, emptyCounters, questsForDay };
