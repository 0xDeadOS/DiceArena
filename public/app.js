/**
 * PATH OF DICE — public/app.js
 * Клиентский SPA-роутер экранов, поллинг /api/state?v=…, интерактивная карта
 * развилок (SVG-граф), арена боя, крафт, Атлас, Рейд и Лагерь Пати.
 */

import { LOOT_STYLES, dieSvg, sound, unlockAudio } from './assets.js';

/* ═══════════════════ DOM-хелперы ═══════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const byId = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const num = (n) => Number(n || 0).toLocaleString('ru-RU');

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Тир → CSS-класс. */
function tierClass(tier) {
  if (tier === 'T0') return 't0';
  if (tier === 'T1') return 't1';
  if (tier === 'T2') return 't2';
  return '';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'сейчас';
  if (min < 60) return `${min}м`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}ч`;
  return `${Math.floor(hours / 24)}д`;
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

/* ═══════════════════ Состояние ═══════════════════ */

const state = {
  token: null,
  data: null,
  me: null,
  screen: 'hub',
  selectedMapId: null,
  selectedDieId: null,
  partnerId: null,
  combatAction: 'attack',
  combatOrb: null,
  pollTimer: null,
  version: null,
  busy: false,
  soundOn: localStorage.getItem('pod_sound') !== 'off',
  codexTab: 'prefixes',
  lastFeedId: null,
  liveReport: null,
};

const CONST = {
  currencies: [],
  bases: [],
  rarities: {},
  atlasPassives: {},
  atlasBranches: {},
  fragments: {},
  raidBosses: [],
  raidConfig: {},
  mapZones: [],
  mapMods: {},
  nodeTypes: {},
  uniqueDice: [],
  gamblePrice: {},
  kiracCost: {},
  tuning: {},
};

const NODE_PRIORITY = { elite: 0, chest: 1, pack: 2, ambush: 3, shrine: 4, boss: 5 };

const COMBAT_ACTIONS_UI = [
  { id: 'attack', name: 'Атака', icon: '⚔️', cls: 'atk', desc: '+1 к броску · x1.0' },
  { id: 'defend', name: 'Защита', icon: '🛡️', cls: 'def', desc: '+1 · x0.4 урон и урон по вам' },
  { id: 'gamble', name: 'Рывок', icon: '🎯', cls: 'gam', desc: '−1 к броску · x1.9 урона' },
];

const BATTLE_ORBS_UI = {
  whetstone: { name: 'Точилка', icon: '🪨', desc: '+3 HP' },
  transmutation: { name: 'Трансмутка', icon: '🔵', desc: '+3 к броску' },
  augmentation: { name: 'Усилялка', icon: '💠', desc: 'x1.5 урона' },
  annulment: { name: 'Аннул', icon: '💀', desc: '−3 врагу' },
  scouring: { name: 'Скоуринг', icon: '🧼', desc: 'сбить щит' },
  chaos: { name: 'Хаос', icon: '🎭', desc: 'грань врага = 1' },
  exalted: { name: 'Экзальт', icon: '🌟', desc: 'x2 урона' },
  divine: { name: 'Дивайн', icon: '✨', desc: 'гарант. крит' },
  vaal: { name: 'Ваал', icon: '🩸', desc: 'x2 урона · −2 HP' },
};

/* ═══════════════════ API ═══════════════════ */

async function api(path, { method = 'GET', body = null, silent = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (!silent) toast(`Сеть недоступна: ${error.message}`, 'err');
    throw error;
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, reason: `HTTP ${response.status}` };
  }
  if (!response.ok || payload.ok === false) {
    if (!silent) toast(payload.reason || `Ошибка HTTP ${response.status}`, 'err');
    const error = new Error(payload.reason || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** Действие с блокировкой кнопок и звуком. */
async function act(button, fn, { soundKey = 'click' } = {}) {
  if (state.busy) return null;
  state.busy = true;
  const wasDisabled = button?.disabled;
  if (button) button.disabled = true;
  try {
    if (soundKey && sound[soundKey]) sound[soundKey]();
    return await fn();
  } catch (error) {
    return null;
  } finally {
    state.busy = false;
    if (button && !wasDisabled) button.disabled = false;
  }
}

/* ═══════════════════ Тосты и лут-фильтр ═══════════════════ */

function toast(text, kind = 'ok', ms = 3600) {
  const box = byId('toasts');
  if (!box) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = esc(text);
  box.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 320);
  }, ms);
}

let lootTimer = null;
function showLoot(styleKey, title = null, sub = null) {
  const style = LOOT_STYLES[styleKey] || LOOT_STYLES.rare;
  const banner = byId('lootBanner');
  if (!banner) return;
  banner.style.setProperty('--loot-color', style.color);
  banner.style.setProperty('--loot-glow', style.glow);
  banner.style.setProperty('--loot-beam', style.beam);
  byId('lootTitle').textContent = title || style.label;
  byId('lootSub').textContent = sub || style.sub;
  byId('lootIcon').textContent = styleKey === 'unique' ? '🎲' : styleKey === 't1' || styleKey === 't0' ? '🏆' : styleKey === 'vaal' ? '🩸' : styleKey === 'chaos' ? '🎭' : '🌟';
  banner.classList.remove('show');
  // eslint-disable-next-line no-unused-expressions
  void banner.offsetWidth;
  banner.classList.add('show');
  if (style.sound && sound[style.sound]) sound[style.sound]();
  clearTimeout(lootTimer);
  lootTimer = setTimeout(() => banner.classList.remove('show'), 4200);
}

/* ═══════════════════ Искры костра ═══════════════════ */

/** Безопасная проверка prefers-reduced-motion (WASM-окружения и старые WebView). */
function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

function startEmbers() {
  const canvas = byId('embers');
  if (!canvas) return;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;
  let width = 0;
  let height = 0;
  let sparks = [];
  const reduced = prefersReducedMotion();

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.round(clamp((width * height) / 26000, 26, 96));
    sparks = Array.from({ length: target }, () => makeSpark(true));
  };

  const makeSpark = (initial = false) => ({
    x: Math.random() * width,
    y: initial ? Math.random() * height : height + Math.random() * 60,
    vy: -(0.12 + Math.random() * 0.5),
    vx: (Math.random() - 0.5) * 0.24,
    size: 0.6 + Math.random() * 1.9,
    life: 0,
    maxLife: 320 + Math.random() * 520,
    hue: 18 + Math.random() * 34,
    alpha: 0.28 + Math.random() * 0.55,
  });

  const draw = () => {
    // Мягкая деградация: без rAF (старые WebView, тестовые DOM) искры просто не рисуем.
    if (typeof window.requestAnimationFrame !== 'function') return;
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < sparks.length; i += 1) {
      const spark = sparks[i];
      spark.life += 1;
      spark.x += spark.vx + Math.sin((spark.life + i * 40) / 90) * 0.16;
      spark.y += spark.vy;
      if (spark.life > spark.maxLife || spark.y < -20) {
        sparks[i] = makeSpark();
        continue;
      }
      const progress = spark.life / spark.maxLife;
      const alpha = spark.alpha * (1 - progress) * (0.4 + 0.6 * Math.sin(progress * Math.PI));
      const radius = spark.size * (1 - progress * 0.45);
      const gradient = ctx.createRadialGradient(spark.x, spark.y, 0, spark.x, spark.y, radius * 4.5);
      gradient.addColorStop(0, `hsla(${spark.hue}, 92%, 68%, ${alpha})`);
      gradient.addColorStop(0.45, `hsla(${spark.hue - 8}, 88%, 52%, ${alpha * 0.42})`);
      gradient.addColorStop(1, 'hsla(20, 80%, 40%, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, radius * 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };

  window.addEventListener('resize', resize, { passive: true });
  resize();
  if (!reduced) draw();
  else {
    ctx.clearRect(0, 0, width, height);
  }
}

/* ═══════════════════ Авторизация ═══════════════════ */

function parseQuery() {
  return new URLSearchParams(window.location.search);
}

function telegramInitData() {
  try {
    return window.Telegram?.WebApp?.initData || '';
  } catch {
    return '';
  }
}

function setupTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('#070504');
    tg.setBackgroundColor?.('#070504');
    tg.enableClosingConfirmation?.();
  } catch {
    /* среда без полноценного Telegram */
  }
}

async function authenticate() {
  const query = parseQuery();
  const initData = telegramInitData();
  const stored = localStorage.getItem('pod_token');

  const body = {};
  if (initData) body.initData = initData;
  else if (query.get('player') && query.get('sig')) {
    body.playerId = query.get('player');
    body.sig = query.get('sig');
  } else if (query.get('token')) body.token = query.get('token');
  else if (stored) body.token = stored;

  try {
    const session = await api('/auth/session', { method: 'POST', body, silent: true });
    state.token = session.token;
    localStorage.setItem('pod_token', session.token);
    if (session.notice) toast(session.notice, 'gold', 5200);
    if (query.has('token') || query.has('sig')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    return session;
  } catch (error) {
    // Гостевой режим: серверная запись отклонена, но state отдаётся всем.
    state.token = null;
    return null;
  }
}

/* ═══════════════════ Загрузка состояния ═══════════════════ */

async function loadState({ initial = false } = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const url = state.version && !initial ? `/api/state?v=${state.version}` : '/api/state';
  let payload;
  try {
    const response = await fetch(url, { headers });
    payload = await response.json();
  } catch {
    return;
  }
  if (payload.unchanged) return;

  state.data = payload;
  state.version = payload.version;
  Object.assign(CONST, payload.constants || {});
  state.me = payload.self || payload.players?.find((p) => p.id === payload.selfId) || payload.players?.[0] || null;

  if (!state.selectedDieId && state.me?.equippedDieId) state.selectedDieId = state.me.equippedDieId;
  if (state.selectedDieId && !state.me?.dice?.some((d) => d.id === state.selectedDieId)) {
    state.selectedDieId = state.me?.equippedDieId || null;
  }
  if (state.selectedMapId && !state.me?.maps?.some((m) => m.id === state.selectedMapId)) {
    state.selectedMapId = null;
  }
  if (state.me?.id) localStorage.setItem('pod_player', state.me.id);

  renderAll({ initial });
}

function renderAll({ initial = false } = {}) {
  renderHeader();
  renderHub();
  renderForge();
  renderMaps();
  renderAtlas();
  renderRaid();
  renderCamp();
  if (initial) {
    renderCodex();
  }
}

/* ═══════════════════ Роутер ═══════════════════ */

const SCREEN_TITLES = {
  hub: 'Sanctuary Hub',
  forge: 'Кузня и Тайник Сфер',
  maps: 'Картографический Стол',
  atlas: 'Дерево Пассивок Атласа',
  raid: 'Алтарь Рейд-Босса',
  camp: 'Лагерь Пати',
};

function goTo(screen, { silent: silentNav = false } = {}) {
  if (!SCREEN_TITLES[screen]) return;
  state.screen = screen;
  $$('.screen').forEach((node) => node.classList.toggle('active', node.dataset.screen === screen));
  if (!silentNav) sound.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.history.replaceState({}, '', `#${screen}`);
  if (screen === 'codex') openCodex();
}

function screenFromHash() {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'codex') {
    setTimeout(() => openCodex(), 300);
    return 'hub';
  }
  return SCREEN_TITLES[hash] ? hash : 'hub';
}

/* ═══════════════════ ШАПКА ═══════════════════ */

function renderHeader() {
  const me = state.me;
  if (!me) return;

  const switchBox = byId('profileSwitch');
  switchBox.innerHTML = (state.data.players || [])
    .map((player) => `<button class="profile-pill ${player.id === me.id ? 'active' : ''}" data-profile="${esc(player.id)}" title="${esc(player.role)}">
      <span>${esc(player.avatar)}</span><span>${esc(player.name)}</span>
    </button>`)
    .join('');

  /* Активный изгнанник — всегда виден в шапке */
  const avatar = byId('activePlayerAvatar');
  if (avatar) avatar.textContent = me.avatar || '🎲';
  const nameNode = byId('activePlayerName');
  if (nameNode) nameNode.textContent = me.name || '—';
  const subNode = byId('activePlayerSub');
  if (subNode) {
    subNode.textContent = `${me.role || 'изгнанник'} · ур. ${me.level?.level || 1} · ${num(me.power)} мощи`;
  }

  const boss = state.data.chat?.boss;
  const bossPct = boss ? Math.round((boss.hp / boss.maxHp) * 100) : 0;
  byId('miniStats').innerHTML = `
    <span class="mini-stat" title="${esc(me.equippedDie?.name || '—')}">${esc(me.equippedDie?.icon || '🎲')} <b>${num(me.power)}</b></span>
    <span class="mini-stat" title="Порталы">🌀 <b>${num(me.portals)}</b></span>
    <span class="mini-stat" title="HP общего босса">💀 <b>${bossPct}%</b></span>
    <span class="mini-stat" title="Уровень">⭐ <b>${me.level?.level || 1}</b></span>`;

  byId('soundBtn').textContent = state.soundOn ? '🔊' : '🔇';
  byId('soundBtn').classList.toggle('muted', !state.soundOn);
  byId('hubBtn').classList.toggle('active', state.screen === 'hub');
  byId('footerVersion').textContent = `v1.0 · ${esc(state.data.chat?.name || '')}`;
}

async function switchProfile(playerId) {
  if (!playerId || playerId === state.me?.id) return;
  const profile = (state.data.players || []).find((p) => p.id === playerId);
  if (!profile) return;
  try {
    const profiles = await api('/profiles');
    const entry = profiles.profiles.find((p) => p.id === playerId);
    const sig = new URL(entry.signLink).searchParams.get('sig');
    const session = await api('/auth/session', { method: 'POST', body: { playerId, sig } });
    state.token = session.token;
    localStorage.setItem('pod_token', session.token);
    state.version = null;
    state.selectedDieId = null;
    state.selectedMapId = null;
    await loadState({ initial: true });
    toast(`Профиль: ${profile.name} ${profile.avatar}`, 'gold');
  } catch {
    /* ошибка уже показана */
  }
}

/* ═══════════════════ ХАБ ═══════════════════ */

function renderHub() {
  const me = state.me;
  if (!me || !state.data) return;
  const die = me.equippedDie;
  const boss = state.data.chat?.boss;

  byId('hubChatName').textContent = state.data.chat?.name || 'Убежище Изгнанников';
  byId('hubPortalsPill').textContent = `🌀 ${me.portals} порталов`;
  byId('hubAtlasPill').textContent = `🌳 ${me.atlasPoints} очков`;

  byId('hubDieFace').innerHTML = die ? dieSvg(die.baseId, 52) || esc(die.icon) : '🎲';
  byId('hubDieName').textContent = die?.name || 'Нет кубика';
  byId('hubDieName').className = `die-hero-name rarity-${die?.rarity || 'normal'}`;
  byId('hubDieMeta').innerHTML = die
    ? `<span>${esc(die.icon)} ${esc(die.rarityLabel)}</span><span>${esc(die.short || '')}</span><span>ilvl ${die.ilvl}</span><span>мощь ${num(die.power)}</span><span>⭐ ур. ${me.level?.level || 1}</span>${die.corrupted ? '<span class="corrupt-tag">ОСКВЕРНЁН</span>' : ''}`
    : '';
  byId('hubDieMods').innerHTML = die
    ? [
      die.implicit?.text ? `<div class="implicit-row">🔹 ${esc(die.implicit.text)}</div>` : '',
      ...(die.mods || []).slice(0, 4).map((mod) => modRowHtml(mod)),
      (die.mods || []).length > 4 ? `<div class="implicit-row">…и ещё ${die.mods.length - 4} мод(ов)</div>` : '',
    ].join('')
    : '<div class="implicit-row">Купите базу в Кузне</div>';

  const rollBtn = byId('rollBtn');
  const left = me.rollsLeft ?? 0;
  rollBtn.disabled = left <= 0;
  $('.roll-label', rollBtn).textContent = left > 0 ? 'Ежедневный Бросок' : 'Бросок сделан';
  byId('rollSub').textContent = left > 0
    ? `${left} из ${me.rollLimit} доступен${left === 1 ? '' : 'но'}`
    : 'Возвращайтесь после 00:00';

  if (boss) {
    byId('bossIcon').textContent = boss.icon || '👹';
    byId('bossName').textContent = `${boss.name} · ур. ${boss.level}`;
    const pct = clamp(Math.round((boss.hp / boss.maxHp) * 100), 0, 100);
    byId('bossBar').style.width = `${pct}%`;
    byId('bossHp').textContent = `${num(boss.hp)} / ${num(boss.maxHp)} HP · ${pct}%`;
    byId('bossDefeatedCount').textContent = `${state.data.chat.defeatedBosses || 0} добито`;
  }

  const activeRun = state.data.activeRun;
  byId('navForgeBadge').textContent = `⚒️ ${num(me.dice?.length || 0)} кубиков`;
  byId('navMapsBadge').textContent = activeRun
    ? (activeRun.phase === 'combat' ? '⚔️ Идёт бой' : '🚶 Поход активен')
    : `🌀 ${me.portals} порталов · ${(me.maps || []).length} карт`;
  byId('navAtlasBadge').textContent = me.atlasPoints > 0 ? `✨ ${me.atlasPoints} не потрачено` : `🎯 ${(me.atlasCompleted || []).length}/16 тиров`;
  const raid = state.data.raid;
  byId('navRaidBadge').textContent = raid?.active
    ? (raid.active.defeated ? '🏆 Повержен' : `💀 ${Math.round((raid.active.hp / raid.active.maxHp) * 100)}% HP`)
    : `💠 ${raid?.total || 0}/4 фрагмента`;
  byId('navCampBadge').textContent = `🏆 ${state.data.ladder?.[0]?.name || '—'} впереди`;

  renderFeed(byId('hubFeed'), state.data.feed, 18);
  renderQuests();
}

function modRowHtml(mod) {
  const prefix = mod.type === 'prefix' ? 'prefix' : 'suffix';
  const unit = mod.unit === 'pct' ? '%' : '';
  const crafted = mod.crafted ? ' crafted' : '';
  return `<div class="mod-row ${prefix}${crafted}">
    <span class="mod-tier ${tierClass(mod.tier)}">${esc(mod.tier)}</span>
    <span class="mod-value">${mod.value}${unit}</span>
    <span class="mod-stat">${esc(mod.stat)}${mod.crafted ? ' ✦' : ''}</span>
  </div>`;
}

function renderFeed(target, feed, limit = 40) {
  if (!target) return;
  if (!feed || !feed.length) {
    target.innerHTML = '<div class="feed-empty">Пока тихо. Сделайте первый бросок.</div>';
    return;
  }
  target.innerHTML = feed.slice(0, limit).map((entry) => `
    <div class="feed-item" data-kind="${esc(entry.kind)}">
      <span class="feed-time">${timeAgo(entry.at)}</span>
      <span class="feed-text">${esc(entry.text)}</span>
    </div>`).join('');
}

function renderQuests() {
  const me = state.me;
  const box = byId('questList');
  if (!box) return;
  const quests = me?.quests || [];
  byId('questDate').textContent = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  if (!quests.length) {
    box.innerHTML = '<div class="feed-empty">Задания появятся после входа через Telegram.</div>';
    return;
  }
  box.innerHTML = quests.map((quest) => `
    <div class="quest ${quest.done ? 'done' : ''} ${quest.claimed ? 'claimed' : ''}">
      <div class="quest-top">
        <span class="q-icon">${esc(quest.icon)}</span>
        <span>${esc(quest.name)}</span>
        <span class="quest-reward">${quest.atlasPoint ? '🌳' : ''} ⭐${quest.xp}</span>
      </div>
      <div class="quest-text">${esc(quest.text)}</div>
      <div class="quest-progress">
        <div class="qbar"><span style="width:${Math.round((quest.progress / quest.target) * 100)}%"></span></div>
        <span class="q-num">${num(quest.progress)}/${num(quest.target)}</span>
      </div>
      ${quest.done && !quest.claimed ? `<button class="btn btn-primary btn-tiny q-btn" data-quest="${esc(quest.id)}">Забрать награду</button>` : ''}
      ${quest.claimed ? '<div class="q-num" style="margin-top:5px">✅ Получено</div>' : ''}
    </div>`).join('');
}

/* ═══════════════════ БРОСОК ═══════════════════ */

async function doRoll(button) {
  await act(button, async () => {
    button.classList.add('rolling');
    sound.diceRoll();
    try {
      const result = await api('/roll', { method: 'POST', body: {} });
      const roll = result.roll;
      setTimeout(() => {
        sound.crit && roll.crit ? sound.crit() : null;
      }, 300);
      showRollModal(roll, result);
      handleLootFromRoll(roll);
      await loadState();
    } finally {
      button.classList.remove('rolling');
    }
  }, { soundKey: null });
}

function handleLootFromRoll(roll) {
  if (!roll) return;
  const orbs = roll.orbs || [];
  if (orbs.some((o) => o.id === 'divine')) return showLoot('divine');
  if (orbs.some((o) => o.id === 'exalted')) return showLoot('exalted');
  if (orbs.some((o) => o.id === 'chaos')) return showLoot('chaos');
  if (orbs.some((o) => o.id === 'vaal')) return showLoot('vaal');
  if (roll.crit) return showLoot('t1', 'Критический бросок', `${roll.score} очков · ${roll.damage} урона`);
  if (roll.echoes > 0) return showLoot('rare', `Эхо Броска x${roll.echoes}`, `${roll.score} очков`);
  return null;
}

function showRollModal(roll, result) {
  const modal = byId('rollModal');
  const die = byId('rollDieAnim');
  die.textContent = '🎲';
  die.classList.remove('spin');
  // eslint-disable-next-line no-unused-expressions
  void die.offsetWidth;
  die.classList.add('spin');

  byId('rollModalTitle').textContent = `${roll.dieName} · ${roll.crit ? 'КРИТ!' : 'Бросок'}`;

  const chips = [];
  chips.push(`<span class="rb">Грань <b>${roll.primaryFace}</b>/${roll.faces}</span>`);
  if (roll.echoFaces?.length) chips.push(`<span class="rb">Эхо <b>+${roll.echoFaces.join('+')}</b></span>`);
  if (roll.lucky) chips.push(`<span class="rb">Lucky <b>${roll.luckyAlternate}</b></span>`);
  if (roll.flatAdd) chips.push(`<span class="rb">Плоско <b>+${roll.flatAdd}</b></span>`);
  if (roll.incPct) chips.push(`<span class="rb">Increased <b>${roll.incPct}%</b></span>`);
  if (roll.morePct) chips.push(`<span class="rb">More <b>${roll.morePct}%</b></span>`);
  chips.push(`<span class="rb">Шанс крита <b>${roll.critChancePct}%</b></span>`);
  if (roll.crit) chips.push(`<span class="rb crit">КРИТ x${(roll.critMultiPct / 100).toFixed(2)}</span>`);
  chips.push(`<span class="rb">Итог <b>${roll.score}</b> очков</span>`);
  byId('rollBreakdown').innerHTML = chips.join('');

  byId('rollOrbs').innerHTML = (roll.orbs || []).map((orb) => `
    <span class="roll-orb ${orb.tier === 'mythic' ? 'mythic' : ''}">${esc(orb.icon)} ${esc(orb.name)} ×${orb.count}</span>`).join('')
    || '<span class="rb">Валюта не выпала</span>';

  byId('rollDamage').innerHTML = `⚔️ ${num(roll.damage)} урона по боссу${result.damage?.culled ? ' · <b>CULLING STRIKE</b>' : ''}${result.damage?.killed ? ' · <b>БОСС ПОВЕРЖЕН!</b>' : ''}`;

  const events = [...(roll.events || []).map((e) => e.text)];
  if (result.partyAuras?.contributors?.length) {
    events.push(`🤝 Ауры пати: +${result.partyAuras.inc}% очков, +${result.partyAuras.crit}% крита (${result.partyAuras.contributors.join(', ')})`);
  }
  if (result.charges) events.push(`⚡ Заряд: следующий бросок +25% очков (${result.charges}/3)`);
  if (result.xp?.levelUp) events.push(`🎖️ Новый уровень: ${result.xp.level}!`);
  if (result.bossDefeated) events.push(`💀 ${result.bossDefeated.boss.name} повержен! Призван ${result.bossDefeated.next.name}.`);
  byId('rollEvents').innerHTML = events.map((text) => `<div class="roll-event">${esc(text)}</div>`).join('');

  openModal('#rollModal');
}

/* ═══════════════════ КУЗНЯ ═══════════════════ */

function currentDie() {
  const me = state.me;
  if (!me) return null;
  return me.dice?.find((d) => d.id === state.selectedDieId)
    || me.dice?.find((d) => d.id === me.equippedDieId)
    || me.dice?.[0]
    || null;
}

function renderForge() {
  const me = state.me;
  if (!me || !state.data) return;
  const die = currentDie();
  const inventory = me.inventory || {};
  const totalOrbs = Object.values(inventory).reduce((a, b) => a + b, 0);

  byId('forgeCurrencyPill').textContent = `💰 ${num(totalOrbs)} сфер`;
  byId('forgeDieHint').textContent = die ? `${esc(die.short || '')} · ilvl ${die.ilvl}` : '—';

  /* Детали кубика */
  byId('forgeDieDetail').innerHTML = die ? `
    <div class="die-detail-head">
      <div class="die-badge">${dieSvg(die.baseId, 34) || esc(die.icon)}</div>
      <div style="flex:1;min-width:0">
        <div class="die-detail-name rarity-${die.rarity}">${esc(die.name)}</div>
        <div class="die-detail-meta">
          <span>${esc(die.rarityIcon)} ${esc(die.rarityLabel)}</span>
          <span>грань 1–${die.stats?.faces || die.faces}</span>
          <span>мощь ${num(die.power)}</span>
          <span>качество ${die.quality}%</span>
          ${die.locked ? '<span>🔒 заперт</span>' : ''}
          ${die.corrupted ? '<span class="corrupt-tag">ОСКВЕРНЁН</span>' : ''}
        </div>
        <div class="die-detail-meta" style="margin-top:3px">
          <span>крит ${die.stats?.baseCrit}% × ${((die.stats?.critMultiTotal || 150) / 100).toFixed(2)}</span>
          <span>⭐ +${die.stats?.incScore || 0}% очков</span>
          <span>💰 +${die.stats?.rarityPct || 0}% редкости</span>
        </div>
      </div>
    </div>
    ${die.implicit?.text ? `<div class="implicit-row">🔹 ${esc(die.implicit.text)}</div>` : ''}
    ${(die.vaalImplicits || []).map((imp) => `<div class="vaal-row">🔸 ${esc(imp.text)}</div>`).join('')}
    <div class="mods-list">${(die.mods || []).map(modRowHtml).join('') || '<div class="implicit-row">Нет модов — начните с Трансмутки</div>'}</div>
  ` : '<div class="feed-empty">Нет кубика. Купите базу ниже.</div>';

  /* Сферы для крафта */
  const orbOrder = ['whetstone', 'transmutation', 'alteration', 'augmentation', 'scouring', 'regal', 'chaos', 'annulment', 'exalted', 'divine', 'vaal'];
  byId('forgeOrbs').innerHTML = orbOrder.map((id) => {
    const orb = CONST.currencies.find((c) => c.id === id);
    if (!orb) return '';
    const count = inventory[id] || 0;
    return `<button class="orb-btn" data-orb="${id}" data-tier="${esc(orb.tier)}" title="${esc(orb.description)}" ${(!die || count <= 0) ? 'disabled' : ''}>
      <span class="orb-icon">${esc(orb.icon)}</span>
      <span class="orb-name">${esc(orb.name)}</span>
      <span class="orb-count">${count}</span>
    </button>`;
  }).join('');

  /* Верстак */
  const discount = me.atlasEffects?.benchDiscount || 0;
  byId('benchDiscountHint').textContent = discount ? `−${discount}% цена (Атлас)` : 'гарантированный мод';
  const recipes = [
    { id: 'bench_flat', name: 'Гравировка грани', desc: '+2 к броску', cost: { whetstone: 4, transmutation: 2 } },
    { id: 'bench_inc', name: 'Резьба очков', desc: '+20% Increased очков', cost: { whetstone: 5, alteration: 2 } },
    { id: 'bench_crit', name: 'Клеймо крита', desc: '+22% шанса крита', cost: { whetstone: 5, augmentation: 2 } },
    { id: 'bench_multi', name: 'Печать множителя', desc: '+28% множителя крита', cost: { whetstone: 6, regal: 1 } },
    { id: 'bench_rarity', name: 'Аура жадности', desc: '+22% редкости валюты', cost: { whetstone: 4, scouring: 1 } },
    { id: 'bench_aura', name: 'Командный тотем', desc: '+11% очков всей пати', cost: { whetstone: 6, chaos: 1 } },
    { id: 'bench_remove', name: 'Снятие гравировки', desc: 'убрать крафтовый мод', cost: { scouring: 1 } },
  ];
  const mult = 1 - discount / 100;
  byId('benchList').innerHTML = recipes.map((recipe) => {
    const costHtml = Object.entries(recipe.cost).map(([id, amount]) => {
      const need = Math.max(1, Math.ceil(amount * mult));
      const have = inventory[id] || 0;
      const orb = CONST.currencies.find((c) => c.id === id);
      return `<span class="${have >= need ? 'ok' : 'short'}">${esc(orb?.icon || '')}${need}</span>`;
    }).join(' ');
    const craft = (die?.mods || []).find((m) => m.crafted);
    const disabled = !die || die.corrupted || die.rarity === 'unique'
      || (recipe.id === 'bench_remove' ? !craft : Boolean(craft));
    return `<div class="bench-item">
      <div class="bench-info">
        <div class="bench-name">${esc(recipe.name)}</div>
        <div class="bench-desc">${esc(recipe.desc)}</div>
        <div class="bench-cost">${costHtml}</div>
      </div>
      <button class="btn btn-tiny btn-ghost" data-bench="${recipe.id}" ${disabled ? 'disabled' : ''}>Сделать</button>
    </div>`;
  }).join('');

  /* Тайник */
  byId('stashGrid').innerHTML = CONST.currencies.map((orb) => {
    const count = inventory[orb.id] || 0;
    return `<div class="stash-cell ${count === 0 ? 'zero' : ''}" data-tier="${esc(orb.tier)}" title="${esc(orb.description)}">
      <span class="stash-icon">${esc(orb.icon)}</span>
      <span class="stash-count">${count}</span>
      <span class="stash-name">${esc(orb.name)}</span>
    </div>`;
  }).join('');

  /* Коллекция */
  byId('collectionCount').textContent = `${me.dice?.length || 0} шт. · мощь ${num(me.power)}`;
  byId('collection').innerHTML = (me.dice || []).slice().sort((a, b) => b.power - a.power).map((item) => `
    <div class="die-card ${item.id === me.equippedDieId ? 'equipped' : ''}" data-rarity="${esc(item.rarity)}">
      <div class="die-card-top">
        <span class="die-card-icon">${dieSvg(item.baseId, 26) || esc(item.icon)}</span>
        <div style="flex:1;min-width:0">
          <div class="die-card-name rarity-${item.rarity}">${esc(item.name)}</div>
          <div class="die-card-meta">${esc(item.rarityIcon)} ${esc(item.short || '')} · ilvl ${item.ilvl} · ${item.mods.length} мод</div>
          <div class="die-card-meta">⚡${num(item.power)} · ⭐+${item.stats?.incScore || 0}%${item.corrupted ? ' · 🩸' : ''}${item.locked ? ' · 🔒' : ''}</div>
        </div>
      </div>
      <div class="die-card-actions">
        <button class="btn btn-tiny" data-select-die="${esc(item.id)}">${item.id === state.selectedDieId ? '● Выбран' : 'Выбрать'}</button>
        ${item.id !== me.equippedDieId ? `<button class="btn btn-tiny btn-ghost" data-equip="${esc(item.id)}">Экипировать</button>` : '<span class="pill pill-good" style="font-size:8px">В руке</span>'}
        <button class="btn btn-tiny btn-ghost" data-lock="${esc(item.id)}">${item.locked ? '🔓' : '🔒'}</button>
        <button class="btn btn-tiny btn-ghost" data-salvage="${esc(item.id)}" ${me.dice.length <= 1 ? 'disabled' : ''}>♻️</button>
      </div>
    </div>`).join('');

  /* Лавка */
  byId('shopList').innerHTML = CONST.bases.map((base) => {
    const unlocked = (me.bossKills || 0) >= base.bossKillsRequired;
    const afford = (inventory.chaos || 0) >= base.price;
    return `<div class="shop-item ${unlocked ? '' : 'locked'}">
      <span class="shop-icon">${dieSvg(base.id, 24) || esc(base.icon)}</span>
      <div class="shop-info">
        <div class="shop-name">${esc(base.name)} <span style="color:var(--text-faint);font-size:9.5px">${esc(base.short)}</span></div>
        <div class="shop-meta">${unlocked ? 'Крит ' + base.baseCrit + '% · ' : `Нужно ${base.bossKillsRequired} босс(ов) · `}🎭${base.price}</div>
      </div>
      <button class="btn btn-tiny ${afford && unlocked ? 'btn-gold' : 'btn-ghost'}" data-buy="${esc(base.id)}" ${(!unlocked || !afford) ? 'disabled' : ''}>Купить</button>
    </div>`;
  }).join('');

  byId('gambleBtn').disabled = (inventory.chaos || 0) < (CONST.gamblePrice?.chaos || 20);
}

/* ═══════════════════ КАРТЫ ═══════════════════ */

function selectedMap() {
  return (state.me?.maps || []).find((m) => m.id === state.selectedMapId) || null;
}

function renderMaps() {
  const me = state.me;
  if (!me || !state.data) return;
  const inventory = me.inventory || {};
  byId('mapsPortalsPill').textContent = `🌀 ${me.portals} порталов`;
  byId('mapsCountPill').textContent = `🃏 ${(me.maps || []).length} карт`;

  /* Мап-девайс */
  const map = selectedMap();
  const slot = byId('deviceSlot');
  if (map) {
    const mods = (map.mods || []).map((id) => CONST.mapMods?.[id]).filter(Boolean);
    slot.innerHTML = `
      <div class="device-map">
        <div class="device-map-icon">${esc(map.icon || '🗺️')}</div>
        <div class="device-map-name">T${map.tier} ${esc(map.name)}</div>
        <div class="device-map-meta">${esc(CONST.rarities?.[map.rarity]?.label || map.rarity)} · качество ${map.quality}%${map.corrupted ? ' · 🩸 осквернена' : ''}</div>
        <div class="device-map-meta" style="margin-top:3px">👹 ${esc(map.bossName || '')}</div>
        <div class="device-map-mods">${mods.map((mod) => `<span class="chip" title="${esc(mod.risk)} → ${esc(mod.reward)}">${esc(mod.icon)} ${esc(mod.name)}</span>`).join('') || '<span class="chip">Без модов</span>'}</div>
      </div>`;
    byId('deviceHint').textContent = `босс: ${map.bossName}`;
  } else {
    slot.innerHTML = '<div class="device-empty">Вставьте карту из тайника ниже</div>';
    byId('deviceHint').textContent = 'выберите карту';
  }

  /* Крафт карты */
  const mapOrbIds = ['whetstone', 'transmutation', 'alteration', 'augmentation', 'scouring', 'regal', 'chaos', 'annulment', 'exalted', 'vaal'];
  byId('deviceActions').innerHTML = map ? mapOrbIds.map((id) => {
    const orb = CONST.currencies.find((c) => c.id === id);
    const count = inventory[id] || 0;
    if (!orb) return '';
    return `<button class="orb-btn" data-map-orb="${id}" title="${esc(orb.description)}" ${count <= 0 ? 'disabled' : ''}>
      <span class="orb-icon">${esc(orb.icon)}</span>
      <span class="orb-name">${esc(orb.name)}</span>
      <span class="orb-count">${count}</span>
    </button>`;
  }).join('') : '<div class="device-empty" style="grid-column:1/-1;font-size:10px">Сначала выберите карту</div>';

  /* Напарник */
  const others = (state.data.players || []).filter((p) => p.id !== me.id);
  byId('duoPicker').innerHTML = `
    <label>Напарник (дуо-поход)</label>
    <select id="partnerSelect" class="field" style="width:100%;padding:7px 9px;background:rgba(0,0,0,.45);border:1px solid var(--line);border-radius:7px;color:var(--text);font-size:11.5px">
      <option value="">— Соло —</option>
      ${others.map((p) => `<option value="${esc(p.id)}" ${state.partnerId === p.id ? 'selected' : ''}>${esc(p.avatar)} ${esc(p.name)} (⚡${num(p.power)})</option>`).join('')}
    </select>`;

  const activeRun = state.data.activeRun;
  const canStart = Boolean(map) && me.portals > 0 && !activeRun;
  byId('startRunBtn').disabled = !canStart;
  byId('autoRunBtn').disabled = !canStart;
  byId('startRunBtn').textContent = activeRun ? '🚪 Поход уже идёт' : '🚪 Войти в карту';

  /* Тайник карт */
  const maps = (me.maps || []).slice().sort((a, b) => b.tier - a.tier);
  byId('mapsList').innerHTML = maps.length ? maps.map((item) => {
    const zone = CONST.mapZones?.find((z) => z.tier === item.tier);
    const color = item.tier <= 5 ? 'white' : item.tier <= 10 ? 'yellow' : item.tier <= 15 ? 'red' : 'purple';
    return `<div class="map-row ${item.id === state.selectedMapId ? 'selected' : ''}" data-map="${esc(item.id)}" data-color="${color}">
      <span class="map-tier">T${item.tier}</span>
      <div class="map-info">
        <div class="map-name">${esc(item.name)}</div>
        <div class="map-meta">${esc(zone?.boss || '')} · ${esc(CONST.rarities?.[item.rarity]?.label || item.rarity)}${item.quality ? ` · ${item.quality}%` : ''}${item.corrupted ? ' · 🩸' : ''}</div>
      </div>
      <span class="map-mods-mini">${(item.mods || []).map((id) => esc(CONST.mapMods?.[id]?.icon || '')).join('') || ''}</span>
    </div>`;
  }).join('') : '<div class="feed-empty">Тайник пуст. Ежедневный сундук выдаётся автоматически, или купите карту у Кирака.</div>';

  const kirac = CONST.kiracCost || {};
  byId('kiracHint').innerHTML = `Кирак просит ${Object.entries(kirac).map(([id, n]) => {
    const orb = CONST.currencies.find((c) => c.id === id);
    const has = inventory[id] || 0;
    return `<span style="color:${has >= n ? 'var(--emerald)' : 'var(--crimson-bright)'}">${esc(orb?.icon || '')}${n}</span>`;
  }).join(' + ')}`;

  /* Моды карт */
  byId('mapModsChips').innerHTML = Object.values(CONST.mapMods || {}).map((mod) => `
    <div class="mod-chip">
      <b>${esc(mod.icon)} ${esc(mod.name)}</b>
      <span class="risk">риск: ${esc(mod.risk)}</span>
      <span class="reward">награда: ${esc(mod.reward)}</span>
    </div>`).join('');

  renderRun(activeRun);
}

/* ═══════════════════ ГРАФ КАРТЫ ═══════════════════ */

function renderRun(run) {
  const panel = byId('runPanel');
  if (!run) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const phaseLabels = {
    navigation: '🚶 выберите развилку',
    combat: '⚔️ бой',
    victory: '🏆 победа',
    defeat: '💀 поражение',
    retreat: '🏃 отступление',
  };
  byId('runTitle').textContent = `🗺️ T${run.tier} ${run.map?.name || ''}`;
  byId('runTitle').dataset.phase = run.phase;
  byId('runPhaseHint').textContent = phaseLabels[run.phase] || run.phase;

  const hpPct = clamp((run.hp / Math.max(1, run.maxHp)) * 100, 0, 100);
  byId('runHpBar').style.width = `${hpPct}%`;
  byId('runHpText').textContent = `${run.hp}/${run.maxHp}`;
  byId('runTierChip').textContent = `T${run.tier}`;
  byId('runComboChip').textContent = `🔥 ${run.combos || 0}`;
  byId('runBuffChip').textContent = `＋${run.buffs?.scoreBonus || 0}`;

  drawGraph(run);

  /* Подсказка */
  const hint = byId('runHint');
  const availableCount = (run.availableNodeIds || []).length;
  if (run.phase === 'combat') {
    hint.textContent = `⚔️ Бой с ${run.enemy?.name || 'врагом'} — выберите действие ниже`;
    hint.classList.add('urgent');
  } else if (run.phase === 'navigation') {
    hint.textContent = availableCount
      ? `Выберите одну из ${availableCount} развилок — кликните по подсвеченному узлу`
      : 'Путей дальше нет';
    hint.classList.remove('urgent');
  } else {
    hint.textContent = phaseLabels[run.phase] || '';
    hint.classList.remove('urgent');
  }

  renderCombat(run);
  renderRunLog(run);
  renderRunActions(run);
}

function drawGraph(run) {
  const svg = byId('mapGraph');
  const graph = run.graph;
  if (!graph || !graph.nodes?.length) {
    svg.innerHTML = '';
    return;
  }
  const W = 320;
  const layerCount = Math.max(2, graph.layerCount || 4);
  const H = 40 + (layerCount - 1) * 78;
  const padX = 34;
  const padTop = 22;
  const layerGap = (H - padTop * 2) / Math.max(1, layerCount - 1);

  const pos = new Map();
  for (const node of graph.nodes) {
    const x = padX + ((node.x ?? 50) / 100) * (W - padX * 2);
    const y = padTop + node.layer * layerGap;
    pos.set(node.id, { x, y });
  }

  const available = new Set(run.availableNodeIds || []);
  const edges = [];
  for (const node of graph.nodes) {
    for (const nextId of node.nextIds || []) {
      const a = pos.get(node.id);
      const b = pos.get(nextId);
      if (!a || !b) continue;
      const live = available.has(nextId);
      const walked = node.visited && (graph.nodes.find((n) => n.id === nextId)?.visited);
      const midY = (a.y + b.y) / 2;
      const path = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${a.x.toFixed(1)} ${midY.toFixed(1)}, ${b.x.toFixed(1)} ${midY.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      edges.push(`<path class="edge ${live ? 'live' : ''} ${walked ? 'walked' : ''}" d="${path}" />`);
    }
  }

  const nodes = graph.nodes.map((node) => {
    const { x, y } = pos.get(node.id);
    const isAvailable = available.has(node.id);
    const isCurrent = node.id === run.currentNodeId;
    const cls = [
      'node-group',
      isAvailable ? 'available' : '',
      node.visited ? 'visited' : '',
      isCurrent ? 'current' : '',
      node.type === 'boss' ? 'boss' : '',
    ].filter(Boolean).join(' ');
    const r = node.type === 'boss' ? 20 : node.type === 'entrance' ? 15 : 17;
    return `<g class="${cls}" data-node="${esc(node.id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle class="node-circle" r="${r}" />
      <text class="node-icon" y="0.5" font-size="${node.type === 'boss' ? 17 : 14}">${esc(node.icon)}</text>
      <text class="node-label" y="${r + 10}">${esc(shortNodeLabel(node))}</text>
    </g>`;
  }).join('');

  const layerLabels = [];
  for (let i = 0; i < layerCount; i += 1) {
    const y = padTop + i * layerGap;
    layerLabels.push(`<text class="node-layer-label" x="3" y="${(y + 3).toFixed(1)}">${i === 0 ? 'вх' : i === layerCount - 1 ? 'босс' : i}</text>`);
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = `<defs>
      <filter id="glowGold"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    ${layerLabels.join('')}
    ${edges.join('')}
    ${nodes}`;

  $$('.node-group.available', svg).forEach((group) => {
    group.addEventListener('click', () => chooseNode(group.dataset.node));
  });
}

function shortNodeLabel(node) {
  const labels = {
    entrance: 'Портал',
    pack: 'Пак',
    elite: 'Элита',
    chest: 'Ларец',
    shrine: 'Святилище',
    ambush: 'Разлом',
    boss: 'БОСС',
  };
  return labels[node.type] || node.name || '';
}

async function chooseNode(nodeId) {
  if (state.busy) return;
  await act(null, async () => {
    sound.step();
    const result = await api('/maps/node', { method: 'POST', body: { nodeId } });
    const effect = result.effect;
    if (effect?.kind === 'chest') {
      sound.chest();
      if (effect.bonusMap) showLoot('rare', 'Карта в ларце!', `T${effect.bonusMap.tier}`);
      else if (effect.orbs?.length) {
        const mythic = effect.orbs.find((o) => o.tier === 'mythic');
        if (mythic) showLoot(mythic.id === 'exalted' ? 'exalted' : mythic.id === 'divine' ? 'divine' : 'chaos');
      }
      toast('💰 Ларец картографа вскрыт');
    } else if (effect?.kind === 'shrine') {
      sound.shrine();
      toast(effect.mode === 'heal' ? `⛩️ Святилище: +${effect.healed} HP` : `⛩️ Святилище: +${effect.scoreBonus} к броску`, 'gold');
    } else if (result.enemy) {
      toast(`⚔️ Бой: ${result.enemy.name} (${result.enemy.hp} HP)`, 'err');
      sound.step();
    }
    state.liveReport = result.report || null;
    await loadState();
    if (result.report) showReport(result.report);
  }, { soundKey: null });
}

function renderCombat(run) {
  const panel = byId('combatPanel');
  const enemy = run.enemy;
  if (!enemy || run.phase !== 'combat') {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  const pct = clamp(Math.round((enemy.hp / enemy.maxHp) * 100), 0, 100);
  const orbKeys = Object.keys(BATTLE_ORBS_UI);
  const inventory = state.me?.inventory || {};

  panel.innerHTML = `
    <div class="combat-head">
      <div class="combat-enemy-icon">${esc(enemy.icon)}</div>
      <div class="combat-enemy-info">
        <div class="combat-enemy-name">${esc(enemy.name)}</div>
        <div class="combat-enemy-meta">Раунд ${enemy.round} · кубик D${enemy.faces}${enemy.bonus ? ` +${enemy.bonus}` : ''}${enemy.isBoss ? ' · БОСС' : ''}</div>
        <div class="hpbar" style="margin-top:5px"><span style="width:${pct}%"></span></div>
        <div class="combat-enemy-meta" style="margin-top:2px">${num(enemy.hp)} / ${num(enemy.maxHp)} HP</div>
      </div>
    </div>
    ${enemy.intent ? `<div class="combat-intent">${esc(enemy.intent.icon)} <b>${esc(enemy.intent.name)}</b> — ${esc(enemy.intent.description)}</div>` : ''}
    ${enemy.shieldActive ? `<div class="combat-shield">🛡️ Щит Пустоты: −60% урона · осталось ударов: ${enemy.shieldHitsLeft}</div>` : ''}
    ${enemy.enraged ? '<div class="combat-shield" style="color:#ffb3a8;border-color:rgba(255,92,71,.4)">💢 ЯРОСТЬ: +2 к броску босса</div>' : ''}
    <div class="combat-actions">
      ${COMBAT_ACTIONS_UI.map((action) => `<button class="action-btn ${action.cls} ${state.combatAction === action.id ? 'selected' : ''}" data-action="${action.id}">
        <span class="action-icon">${action.icon}</span>
        <span class="action-name">${action.name}</span>
        <span class="action-desc">${esc(action.desc)}</span>
      </button>`).join('')}
    </div>
    <div class="combat-orbs-label">Боевые сферы (необязательно)</div>
    <div class="combat-orbs">
      ${orbKeys.map((id) => {
        const orb = BATTLE_ORBS_UI[id];
        const count = inventory[id] || 0;
        return `<button class="combat-orb ${state.combatOrb === id ? 'selected' : ''}" data-orb-id="${id}" title="${esc(orb.desc)}" ${count <= 0 ? 'disabled' : ''}>
          <span class="co-icon">${esc(orb.icon)}</span>
          <span>${esc(orb.name)}</span>
          <span>×${count}</span>
        </button>`;
      }).join('')}
    </div>
    ${run.lastTurn ? turnResultHtml(run.lastTurn) : ''}`;

  $$('[data-action]', panel).forEach((btn) => btn.addEventListener('click', () => {
    state.combatAction = btn.dataset.action;
    sound.click();
    renderCombat(run);
  }));
  $$('[data-orb-id]', panel).forEach((btn) => btn.addEventListener('click', () => {
    state.combatOrb = state.combatOrb === btn.dataset.orbId ? null : btn.dataset.orbId;
    sound.click();
    renderCombat(run);
  }));
}

function turnResultHtml(turn) {
  return `<div class="turn-result ${turn.won ? 'win' : 'lose'}">
    <div class="turn-dice">
      <div class="td"><b style="color:var(--emerald)">${turn.playerScore}</b><small>вы</small></div>
      <div class="vs">vs</div>
      <div class="td"><b style="color:var(--crimson-bright)">${turn.enemyScore}</b><small>враг</small></div>
    </div>
    <div style="text-align:center">${esc(turn.text)}${turn.crit ? ' · 💥 КРИТ' : ''}${turn.intent ? ` · ${esc(turn.intent.icon)} ${esc(turn.intent.name)}` : ''}${turn.orb ? ` · ${esc(turn.orb.icon)}` : ''}</div>
    <div style="text-align:center;font-size:9.5px;color:var(--text-faint);margin-top:3px">броски: ${turn.playerFace} vs ${turn.enemyFace} · бонус мощи +${turn.powerBonus}${turn.allySupport ? ` · напарник +${turn.allySupport}` : ''}</div>
  </div>`;
}

function renderRunLog(run) {
  const box = byId('runLog');
  box.innerHTML = (run.log || []).map((line) => `<div class="log-line ${esc(line.kind || '')}">${esc(line.text)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

function renderRunActions(run) {
  const box = byId('runActions');
  if (run.phase === 'combat') {
    box.innerHTML = `<button class="btn btn-primary" id="turnBtn">⚔️ ${esc(COMBAT_ACTIONS_UI.find((a) => a.id === state.combatAction)?.name || 'Атака')}${state.combatOrb ? ` + ${esc(BATTLE_ORBS_UI[state.combatOrb]?.name || '')}` : ''}</button>
      <button class="btn btn-ghost" id="retreatBtn">🏃 Отступить</button>`;
    byId('turnBtn').addEventListener('click', (event) => doTurn(event.currentTarget));
    byId('retreatBtn').addEventListener('click', (event) => doRetreat(event.currentTarget));
    return;
  }
  if (run.phase === 'navigation') {
    const byPriority = [...(run.graph.nodes || [])]
      .filter((node) => (run.availableNodeIds || []).includes(node.id))
      .sort((a, b) => (NODE_PRIORITY[a.type] ?? 9) - (NODE_PRIORITY[b.type] ?? 9));
    box.innerHTML = `<button class="btn btn-ghost" id="retreatBtn">🏃 Отступить</button>
      ${byPriority.length ? `<span class="chip" style="flex:1;text-align:center">Доступно: ${byPriority.map((n) => esc(n.icon)).join(' ')}</span>` : ''}`;
    byId('retreatBtn').addEventListener('click', (event) => doRetreat(event.currentTarget));
    return;
  }
  box.innerHTML = `<button class="btn btn-primary" id="dismissBtn">📜 Закрыть отчёт</button>`;
  byId('dismissBtn').addEventListener('click', (event) => doDismiss(event.currentTarget));
}

async function doTurn(button) {
  await act(button, async () => {
    const result = await api('/maps/turn', {
      method: 'POST',
      body: { action: state.combatAction, orbId: state.combatOrb },
    });
    const turn = result.turn;
    if (turn.won) {
      sound.raidHit();
      if (turn.crit) sound.crit();
    } else {
      sound.fail();
    }
    if (result.nodeCleared) {
      showLoot('rare', 'Узел зачищен', `${turn.enemyName} повержен`);
    }
    state.combatOrb = null;
    state.liveReport = result.report || null;
    if (result.run?.phase === 'victory') showLoot('unique', 'Карта пройдена!', `T${result.run.tier} ${result.run.map?.name || ''}`);
    await loadState();
    if (result.report) showReport(result.report);
  }, { soundKey: null });
}

async function doRetreat(button) {
  await act(button, async () => {
    const result = await api('/maps/retreat', { method: 'POST', body: {} });
    toast('🏃 Отступление: половина лута сохранена', 'gold');
    state.liveReport = result.report;
    await loadState();
    if (result.report) showReport(result.report);
  });
}

async function doDismiss(button) {
  await act(button, async () => {
    await api('/maps/dismiss', { method: 'POST', body: {} });
    closeModal('#reportModal');
    await loadState();
    toast('Отчёт закрыт');
  });
}

async function startRun(button, auto = false) {
  const map = selectedMap();
  if (!map) return toast('Выберите карту', 'err');
  await act(button, async () => {
    const body = { mapId: map.id, partnerId: state.partnerId || null, auto };
    if (!auto) {
      const started = await api('/maps/start', { method: 'POST', body });
      sound.step();
      state.selectedMapId = null;
      toast(started.message || '🗺️ Поход начат — выбирайте развилки', 'gold');
      await loadState();
      goTo('maps');
      return;
    }
    const result = await api('/maps/run', { method: 'POST', body });
    sound.step();
    state.selectedMapId = null;
    toast('⚡ Авто-забег завершён', 'gold');
    await loadState();
    if (result.report) showReport(result.report);
  });
}

/* ═══════════════════ ОТЧЁТ ═══════════════════ */

function showReport(report) {
  if (!report) return;
  const win = report.outcome === 'victory';
  byId('reportTitle').textContent = win ? '🏆 Победа на карте' : report.outcome === 'retreat' ? '🏃 Отступление' : '💀 Поражение';
  const gained = Object.entries(report.gained || {});
  byId('reportBody').innerHTML = `
    <div class="report-outcome ${win ? 'win' : 'lose'}">T${report.tier} · ${esc(report.mapName || '')}</div>
    <div class="report-stats">
      <div class="report-stat"><b>${report.nodesCleared}</b><small>узлов</small></div>
      <div class="report-stat"><b>${report.turns}</b><small>раундов</small></div>
      <div class="report-stat"><b>${report.bestCombo}</b><small>комбо</small></div>
      <div class="report-stat"><b>${report.hp}/${report.maxHp}</b><small>HP</small></div>
      <div class="report-stat"><b>${Math.round(report.keepPct * 100)}%</b><small>лута</small></div>
    </div>
    <div class="report-loot">${gained.length
    ? gained.map(([id, count]) => {
      const orb = CONST.currencies.find((c) => c.id === id);
      return `<span class="roll-orb ${orb?.tier === 'mythic' ? 'mythic' : ''}">${esc(orb?.icon || '')} ${esc(orb?.name || id)} ×${count}</span>`;
    }).join('')
    : '<span class="chip">Валюта не выпала</span>'}</div>
    ${report.atlas?.atlasPoint ? '<div class="toast gold" style="position:static;animation:none">🌳 Bonus Objective выполнен: +1 Очко Атласа</div>' : ''}
    ${report.atlas?.fragment ? `<div class="toast gold" style="position:static;animation:none">💠 Выпал фрагмент рейда</div>` : ''}
    ${report.atlas?.exalt ? '<div class="toast myth" style="position:static;animation:none">🌟 Экзальт с босса карты!</div>' : ''}
    ${report.atlas?.rareDie ? `<div class="toast myth" style="position:static;animation:none">🎲 Дроп кубика: ${esc(report.atlas.rareDie.name)}</div>` : ''}
    ${(report.atlas?.maps || []).map((map) => `<div class="toast gold" style="position:static;animation:none">🗺️ Карта T${map.tier} ${esc(map.name)}</div>`).join('')}
    ${report.partnerShare ? `<div class="toast" style="position:static;animation:none">🤝 Доля напарника: ${Object.entries(report.partnerShare).map(([id, n]) => `${esc(CONST.currencies.find((c) => c.id === id)?.icon || '')}${n}`).join(' ')}</div>` : ''}
    <div class="report-log">${(report.logs || []).slice(-12).map((line) => `<div class="log-line ${esc(line.kind || '')}">${esc(line.text)}</div>`).join('')}</div>`;

  const dismissBtn = byId('reportDismissBtn');
  dismissBtn.disabled = false;
  openModal('#reportModal');
  if (win) sound.victory();
  if (report.atlas?.exalt) showLoot('exalted');
  else if (report.atlas?.rareDie?.rarity === 'unique') showLoot('unique');
}

/* ═══════════════════ АТЛАС ═══════════════════ */

function renderAtlas() {
  const me = state.me;
  if (!me || !state.data) return;
  byId('atlasPointsPill').textContent = `🌳 ${me.atlasPoints} очков`;
  byId('atlasBonusPill').textContent = `🎯 ${(me.atlasCompleted || []).length}/16`;

  const branches = Object.values(CONST.atlasBranches || {});
  byId('atlasBranches').innerHTML = branches.map((branch) => {
    const nodes = Object.values(CONST.atlasPassives || {}).filter((p) => p.branch === branch.id);
    const learned = nodes.filter((p) => (me.atlasPassives || []).includes(p.id)).length;
    return `<div class="branch" style="border-color:color-mix(in srgb, ${branch.color} 32%, transparent)">
      <div class="branch-head">
        <span class="branch-icon">${esc(branch.icon)}</span>
        <span class="branch-name" style="color:${branch.color}">${esc(branch.name)}</span>
        <span class="branch-count">${learned}/${nodes.length}</span>
      </div>
      ${nodes.map((passive) => {
        const isLearned = (me.atlasPassives || []).includes(passive.id);
        const missing = (passive.requires || []).filter((r) => !(me.atlasPassives || []).includes(r));
        const canLearn = !isLearned && !missing.length && me.atlasPoints >= passive.cost;
        const cls = isLearned ? 'learned' : canLearn ? 'available' : 'locked';
        return `<div class="passive-node ${cls}" ${canLearn ? `data-passive="${esc(passive.id)}"` : ''}>
          <span class="passive-icon">${esc(passive.icon)}</span>
          <div class="passive-info">
            <div class="passive-name">${esc(passive.name)}</div>
            <div class="passive-desc">${esc(passive.description)}</div>
            <div class="passive-cost">${isLearned ? '✅ изучено' : missing.length ? `требует: ${missing.map((r) => CONST.atlasPassives?.[r]?.name || r).join(', ')}` : `цена: ${passive.cost} 🌳`}</div>
          </div>
          <span class="passive-state">${isLearned ? '✓' : canLearn ? '+' : '🔒'}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  const requirementLabels = { magic: 'Маг.', rare: 'Редк.', rare_corrupted: 'Редк.+Ваал' };
  byId('bonusObjectives').innerHTML = (CONST.mapZones || []).map((zone) => {
    const done = (me.atlasCompleted || []).includes(zone.tier);
    const requirement = zone.tier <= 5 ? 'magic' : zone.tier <= 10 ? 'rare' : 'rare_corrupted';
    return `<div class="bonus-cell ${done ? 'done' : ''}">
      <b>${done ? '✅' : '🎯'} T${zone.tier}</b>
      <span class="req">${requirementLabels[requirement]}</span>
    </div>`;
  }).join('');

  $$('[data-passive]').forEach((node) => node.addEventListener('click', () => learnPassive(node.dataset.passive)));
}

async function learnPassive(passiveId) {
  await act(null, async () => {
    const result = await api('/atlas/point', { method: 'POST', body: { passiveId } });
    sound.success();
    toast(result.message, 'gold');
    await loadState();
  }, { soundKey: null });
}

/* ═══════════════════ РЕЙД ═══════════════════ */

function renderRaid() {
  const me = state.me;
  const raid = state.data?.raid;
  if (!me || !raid) return;
  byId('raidTotalPill').textContent = `💠 ${raid.total}/4`;

  const fragments = CONST.fragments || {};
  byId('reliquary').innerHTML = Object.entries(fragments).map(([id, fragment]) => {
    const bank = raid.bank?.[id] || 0;
    const mine = me.fragments?.[id] || 0;
    const filled = bank >= 1;
    return `<div class="fragment-slot ${filled ? 'filled' : ''}">
      <span class="f-icon">${esc(fragment.icon)}</span>
      <span class="f-name">${esc(fragment.name.replace('Фрагмент ', ''))}</span>
      <span class="f-bank">${bank}</span>
      <span class="f-mine">у вас: ${mine}</span>
      <button class="btn btn-tiny ${mine > 0 ? 'btn-gold' : 'btn-ghost'}" data-deposit="${esc(id)}" ${mine <= 0 ? 'disabled' : ''}>Сдать</button>
    </div>`;
  }).join('');

  byId('summonRaidBtn').disabled = !raid.ready || Boolean(raid.active);

  const active = raid.active;
  if (!active) {
    const next = raid.nextBoss || CONST.raidBosses?.[0];
    byId('raidBossTitle').textContent = 'Рейд не активен';
    byId('raidTimer').textContent = '—';
    byId('raidBossIcon').textContent = next?.icon || '👁️';
    byId('raidBossBar').style.width = '0%';
    byId('raidBossHp').textContent = `Следующий: ${next?.name || '—'} · ${num(next?.hp || 0)} HP`;
    byId('raidShield').innerHTML = `<span>Сдайте 4 разных фрагмента в Реликварий, чтобы призвать.</span>`;
    byId('rallyBar').style.width = '0%';
    byId('rallyText').textContent = 'Rally начнёт считать игроков после призыва.';
    byId('raidContrib').innerHTML = '';
    byId('raidAttackBtn').disabled = true;
    byId('raidAttackBtn').textContent = '⚔️ Рейд не начат';
  } else {
    byId('raidBossTitle').textContent = `${active.icon} ${active.name}${active.defeated ? ' · ПОВЕРЖЕН' : ''}`;
    byId('raidTimer').textContent = active.defeated ? '🏆 победа' : `⏳ ${fmtDuration(active.remainingMs)}`;
    byId('raidBossIcon').textContent = active.icon;
    const pct = clamp(Math.round((active.hp / active.maxHp) * 100), 0, 100);
    byId('raidBossBar').style.width = `${pct}%`;
    byId('raidBossHp').textContent = `${num(active.hp)} / ${num(active.maxHp)} HP · ${pct}%`;
    const shieldLines = [];
    if (active.shieldActive) shieldLines.push(`<div class="raid-shield active">🛡️ Щит Пустоты: −65% урона · выбейте ${active.shieldHitsLeft} макс-грани</div>`);
    if (active.enraged) shieldLines.push('<div class="raid-shield enraged">💢 ENRAGE: +50% шанс крита</div>');
    byId('raidShield').innerHTML = shieldLines.join('');

    const rally = active.rally || { players: 0, mult: 1 };
    const rallyPct = clamp((rally.players / 5) * 100, 0, 100);
    byId('rallyBar').style.width = `${rallyPct}%`;
    byId('rallyBar').classList.toggle('hot', rally.players >= 3);
    byId('rallyText').innerHTML = rally.players >= 5
      ? `🔥 ${rally.players} игроков в окне: <b>x2.0 урона и игнор щитов!</b>`
      : rally.players >= 3
        ? `⚡ ${rally.players} игрока за 10 минут: <b>x1.5 урона</b> (5+ → x2.0)`
        : `Игроков в окне 10 минут: ${rally.players}/3 · каждый удар усиливает группу`;

    const total = Object.values(active.contributors || {}).reduce((a, b) => a + b, 0) || 1;
    byId('raidContrib').innerHTML = Object.entries(active.contributors || {})
      .sort((a, b) => b[1] - a[1])
      .map(([playerId, damage]) => {
        const player = state.data.players.find((p) => p.id === playerId);
        return `<div class="contrib-row">
          <span>${esc(player?.avatar || '🎲')} ${esc(player?.name || playerId)}</span>
          <span class="cbar"><span style="width:${Math.round((damage / total) * 100)}%"></span></span>
          <span class="cnum">${num(damage)}</span>
        </div>`;
      }).join('') || '<div class="cnum">Ещё никто не бил.</div>';

    const attackBtn = byId('raidAttackBtn');
    const cd = active.cooldownLeft || 0;
    attackBtn.disabled = Boolean(active.defeated) || cd > 0;
    attackBtn.textContent = active.defeated ? '🏆 Босс повержен' : cd > 0 ? `⏳ Кулдаун ${Math.ceil(cd / 1000)}с` : '⚔️ Атаковать рейд-босса';
  }

  /* Банк лута */
  const source = active?.defeated ? active : raid.lastDefeated;
  const bags = source?.lootBank || [];
  const claimed = new Set(source?.claimed || []);
  byId('lootHint').textContent = source?.lootRoll ? 'уникальный кубик разыгран' : bags.length ? 'мешки участников' : '—';
  byId('lootBank').innerHTML = bags.length ? bags.map((bag) => {
    const player = state.data.players.find((p) => p.id === bag.playerId);
    const mine = bag.playerId === me.id;
    const isClaimed = bag.claimed || claimed.has(bag.playerId);
    return `<div class="loot-bag ${mine ? 'mine' : ''} ${isClaimed ? 'claimed' : ''}">
      <div class="loot-bag-top">
        <span>${esc(player?.avatar || '🎲')} ${esc(player?.name || bag.playerId)}</span>
        ${bag.isMvp ? '<span class="mvp">MVP</span>' : ''}
        ${mine && !isClaimed ? '<span class="pill pill-gold" style="font-size:8px;padding:1px 6px">ваш</span>' : ''}
        ${isClaimed ? '<span class="pill" style="font-size:8px;padding:1px 6px">получено</span>' : ''}
      </div>
      <div class="loot-orbs">${(bag.bag || []).map((orb) => {
        const def = CONST.currencies.find((c) => c.id === orb.id);
        return `<span>${esc(def?.icon || '')}${orb.count}</span>`;
      }).join(' ')}</div>
    </div>`;
  }).join('') : '<div class="loot-empty">Банк лута пуст. Победите рейд-босса.</div>';

  const myBag = bags.find((bag) => bag.playerId === me.id);
  byId('raidClaimBtn').disabled = !myBag || myBag.claimed || claimed.has(me.id);
  byId('raidRollBtn').disabled = !source || Boolean(source.lootRoll) || bags.length === 0;

  byId('raidHistory').innerHTML = (raid.history || []).length ? raid.history.map((entry) => `
    <div class="history-row">
      <span class="h-res">${entry.defeated ? '🏆' : '⌛'}</span>
      <span class="h-name">${esc(entry.name)}</span>
      <span class="cnum">${num(entry.maxHp)} HP</span>
      <span class="feed-time">${timeAgo(entry.at)}</span>
    </div>`).join('') : '<div class="loot-empty">Рейдов ещё не было.</div>';
}

async function raidAction(button, path, body = {}, { soundKey = 'click', onSuccess = null } = {}) {
  await act(button, async () => {
    const result = await api(path, { method: 'POST', body });
    if (onSuccess) onSuccess(result);
    else if (result.message) toast(result.message, result.killed ? 'myth' : 'ok');
    await loadState();
  }, { soundKey });
}

/* ═══════════════════ ЛАГЕРЬ ═══════════════════ */

function renderCamp() {
  const me = state.me;
  if (!me || !state.data) return;

  /* Ладдер */
  byId('ladder').innerHTML = (state.data.ladder || []).map((entry) => `
    <div class="ladder-row ${entry.id === me.id ? 'me' : ''}">
      <span class="ladder-rank">${entry.rank}</span>
      <span class="ladder-avatar">${esc(entry.avatar)}</span>
      <div class="ladder-info">
        <div class="ladder-name">${esc(entry.name)} ${entry.isAdmin ? '<span class="admin-tag">ADM</span>' : ''}</div>
        <div class="ladder-meta">⚡${num(entry.power)} · ⭐${entry.level} · 💀${entry.bossKills} · 🗺️${entry.mapsCompleted}${entry.die ? ` · ${esc(entry.die.icon)} ${esc(entry.die.name)}` : ''}</div>
      </div>
      <span class="ladder-score">${num(entry.score)}</span>
    </div>`).join('');

  /* Обмен */
  const others = (state.data.players || []).filter((p) => p.id !== me.id);
  const targetSelect = byId('tradeTarget');
  const prevTarget = targetSelect.value;
  targetSelect.innerHTML = others.map((p) => `<option value="${esc(p.id)}">${esc(p.avatar)} ${esc(p.name)}</option>`).join('');
  if (prevTarget && others.some((p) => p.id === prevTarget)) targetSelect.value = prevTarget;

  const orbSelect = byId('tradeOrb');
  const prevOrb = orbSelect.value;
  orbSelect.innerHTML = CONST.currencies
    .filter((orb) => (me.inventory?.[orb.id] || 0) > 0)
    .map((orb) => `<option value="${esc(orb.id)}">${esc(orb.icon)} ${esc(orb.name)} (${me.inventory[orb.id]})</option>`)
    .join('') || '<option value="">Тайник пуст</option>';
  if (prevOrb && CONST.currencies.some((c) => c.id === prevOrb && (me.inventory?.[c.id] || 0) > 0)) orbSelect.value = prevOrb;

  renderFeed(byId('campFeed'), state.data.feed, 40);

  /* Админка */
  const isAdmin = me.isAdmin;
  byId('adminPillWrap').innerHTML = isAdmin
    ? '<span class="pill pill-gold">🛠️ Администратор</span>'
    : '<span class="pill">👤 Игрок</span>';
  byId('adminHint').textContent = isAdmin ? 'доступ открыт' : 'только для администратора чата';
  renderAdminPanel(isAdmin);

  /* Дуэли */
  byId('duelList').innerHTML = (state.data.duels || []).length ? state.data.duels.slice(0, 8).map((duel) => `
    <div class="duel-row">
      <span>🤺</span>
      <span style="flex:1">${esc(duel.challengerName)} vs ${esc(duel.opponentName)}</span>
      <span class="duel-score">${duel.challengerScore}:${duel.opponentScore}</span>
      <span class="feed-time">${timeAgo(duel.at)}</span>
    </div>`).join('') : '<div class="loot-empty">Дуэлей ещё не было.</div>';

  byId('duelBtn').disabled = others.length === 0;
}

function renderAdminPanel(isAdmin) {
  const me = state.me;
  const box = byId('adminGrid');
  if (!isAdmin) {
    box.innerHTML = `<div class="admin-note">Админ-панель доступна профилю с флагом <b>isAdmin</b> (в сиде это Ксандр 🜲) или Telegram ID из переменной <code>ADMIN_ID</code>.
      <br><br>Возможности: лимит броска, сброс кулдауна, сброс босса/ладдера, полный вайп кодовым словом «ВАЙП», права на очки Атласа и чит-сферы.</div>`;
    return;
  }
  const others = (state.data.players || []);
  box.innerHTML = `
    <div class="admin-row">
      <label>Лимит броска / день</label>
      <input id="adminLimit" type="number" min="1" max="10" value="${state.data.settings?.dailyRollsDefault || 1}" />
      <button class="btn btn-tiny btn-gold" data-admin="limit">Применить</button>
    </div>
    <div class="admin-row">
      <label>Сброс кулдауна</label>
      <select id="adminPlayer">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn btn-tiny" data-admin="reset-cd">Игроку</button>
      <button class="btn btn-tiny" data-admin="reset-cd-all">Всем</button>
    </div>
    <div class="admin-row">
      <label>Босс чата</label>
      <button class="btn btn-tiny btn-danger" data-admin="reset-boss">🔄 Новый босс</button>
      <button class="btn btn-tiny" data-admin="reset-ladder">🏆 Обнулить ладдер</button>
    </div>
    <div class="admin-row">
      <label>Очки Атласа</label>
      <input id="adminAtlasPoints" type="number" min="0" max="99" value="1" />
      <button class="btn btn-tiny" data-admin="atlas-points">Выдать игроку</button>
      <button class="btn btn-tiny" data-admin="reset-atlas">Сбросить дерево</button>
    </div>
    <div class="admin-row">
      <label>Чит-сферы</label>
      <select id="adminOrb">${CONST.currencies.map((orb) => `<option value="${esc(orb.id)}">${esc(orb.icon)} ${esc(orb.name)}</option>`).join('')}</select>
      <input id="adminOrbAmount" type="number" min="1" max="999" value="10" style="width:64px" />
      <button class="btn btn-tiny btn-gold" data-admin="add-orbs">+ Добавить</button>
      <button class="btn btn-tiny btn-ghost" data-admin="modify-orbs">− Убрать</button>
    </div>
    <div class="admin-row">
      <label>Полный вайп</label>
      <input id="adminWipe" placeholder="ВАЙП" style="width:88px" />
      <button class="btn btn-tiny btn-danger" data-admin="wipe">💥 Вайп</button>
    </div>`;
}

async function adminAction(kind) {
  const me = state.me;
  const playerSelect = byId('adminPlayer');
  const playerId = playerSelect?.value || me.id;
  const message = (text, ok = true) => {
    const node = byId('adminMessage');
    if (node) {
      node.textContent = text;
      node.style.color = ok ? 'var(--emerald)' : 'var(--crimson-bright)';
    }
  };
  try {
    let result;
    switch (kind) {
      case 'limit':
        result = await api('/settings/daily-limit', { method: 'POST', body: { limit: Number(byId('adminLimit').value) } });
        message(`Лимит: ${result.limit}/день`);
        break;
      case 'reset-cd':
        result = await api('/settings/reset-cd', { method: 'POST', body: { playerId } });
        message(`Кулдаун сброшен (${result.affected} игрок(ов))`);
        break;
      case 'reset-cd-all':
        result = await api('/settings/reset-cd', { method: 'POST', body: {} });
        message(`Кулдаун сброшен всем (${result.affected})`);
        break;
      case 'reset-boss':
        result = await api('/settings/reset-boss', { method: 'POST', body: {} });
        message(`Новый босс: ${result.boss.name} (${result.boss.maxHp} HP)`);
        sound.fail();
        break;
      case 'reset-ladder':
        await api('/settings/reset-ladder', { method: 'POST', body: {} });
        message('Ладдер обнулён');
        break;
      case 'atlas-points':
        result = await api('/settings/atlas', {
          method: 'POST',
          body: { playerId, points: Number(byId('adminAtlasPoints').value) },
        });
        message(`Очки Атласа: ${result.atlasPoints}`);
        break;
      case 'reset-atlas':
        await api('/settings/reset-atlas', { method: 'POST', body: { playerId } });
        message('Дерево Атласа сброшено');
        break;
      case 'add-orbs':
        result = await api('/cheat/add-orbs', {
          method: 'POST',
          body: { playerId, orbId: byId('adminOrb').value, amount: Number(byId('adminOrbAmount').value) },
        });
        message(`Добавлено: ${byId('adminOrb').value}`);
        break;
      case 'modify-orbs':
        result = await api('/cheat/modify-orbs', {
          method: 'POST',
          body: { playerId, orbId: byId('adminOrb').value, delta: -Math.abs(Number(byId('adminOrbAmount').value)) },
        });
        message(`Убрано: ${byId('adminOrb').value}`);
        break;
      case 'wipe':
        result = await api('/settings/reset-all', { method: 'POST', body: { code: byId('adminWipe').value } });
        message(result.message || 'Вайп выполнен');
        state.selectedMapId = null;
        state.selectedDieId = null;
        break;
      default:
        return;
    }
    await loadState();
  } catch (error) {
    message(error.message, false);
  }
}

async function doTrade(button) {
  const toPlayerId = byId('tradeTarget').value;
  const orbId = byId('tradeOrb').value;
  const amount = Number(byId('tradeAmount').value);
  const box = byId('tradeMessage');
  if (!toPlayerId || !orbId) {
    box.textContent = 'Выберите друга и сферу.';
    box.className = 'trade-message err';
    return;
  }
  await act(button, async () => {
    try {
      const result = await api('/trade/transfer', { method: 'POST', body: { toPlayerId, orbId, amount } });
      box.textContent = `✅ ${result.orb.icon}${result.amount} ${result.orb.name} → ${result.target}`;
      box.className = 'trade-message ok';
      sound.success();
      await loadState();
    } catch (error) {
      box.textContent = error.message;
      box.className = 'trade-message err';
    }
  }, { soundKey: null });
}

async function doDuel(button) {
  const opponents = (state.data.players || []).filter((p) => p.id !== state.me.id);
  if (!opponents.length) return toast('Нет противников', 'err');
  const champion = (state.data.ladder || [])[0];
  const opponent = opponents.find((p) => p.id === champion?.id) || opponents[0];
  await act(button, async () => {
    const result = await api('/duel', { method: 'POST', body: { opponentId: opponent.id } });
    const duel = result.duel;
    if (result.won) {
      sound.victory();
      toast(`🤺 Победа! ${duel.challengerScore} : ${duel.opponentScore}. Приз: 🎭${result.prize?.chaos || 0}`, 'gold');
    } else {
      sound.fail();
      toast(`🤺 Поражение ${duel.challengerScore} : ${duel.opponentScore} от ${duel.opponentName}`, 'err');
    }
    await loadState();
  }, { soundKey: 'diceRoll' });
}

/* ═══════════════════ МОДАЛКИ ═══════════════════ */

function openModal(selector) {
  const modal = $(selector);
  if (!modal) return;
  modal.classList.add('open');
}

function closeModal(selector) {
  const modal = $(selector);
  if (!modal) return;
  modal.classList.remove('open');
}

/* ═══════════════════ КОДЕКС ═══════════════════ */

function renderCodex() {
  const body = byId('codexBody');
  if (!body) return;
  const tab = state.codexTab;

  if (tab === 'prefixes' || tab === 'suffixes') {
    const type = tab === 'prefixes' ? 'prefix' : 'suffix';
    const affixes = CONST.affixes || [];
    if (!affixes.length) {
      body.innerHTML = '<div class="codex-row"><div class="codex-desc">База модов недоступна — обновите страницу.</div></div>';
      return;
    }
    body.innerHTML = affixes.filter((a) => a.type === type).map((affix) => `
      <div class="codex-row">
        <div class="codex-row-top">
          <span class="codex-row-name">${esc(affix.name)}</span>
          <span class="codex-badge ${affix.type}">${affix.type === 'prefix' ? 'PREFIX' : 'SUFFIX'}</span>
          <span class="codex-key">${esc(affix.key)}</span>
        </div>
        <div class="codex-stat">${esc(affix.stat)}</div>
        <div class="codex-tiers">${Object.entries(affix.tiers || {}).map(([tier, range]) => `
          <span class="codex-tier ${tierClass(tier)}" title="${tier === 'T0' ? 'только Сфера Ваала' : `вес ${range.weight}`}">${tier} ${range.min}–${range.max}${affix.unit === 'pct' ? '%' : ''}</span>`).join('')}
        </div>
      </div>`).join('');
    return;
  }

  if (tab === 'bases') {
    body.innerHTML = (CONST.bases || []).map((base) => `
      <div class="codex-row">
        <div class="codex-row-top">
          <span>${esc(base.icon)}</span>
          <span class="codex-row-name">${esc(base.name)}</span>
          <span class="codex-badge">${esc(base.short)}</span>
          <span class="codex-key">крит ${base.baseCrit}%</span>
        </div>
        <div class="codex-stat">🔹 ${esc(base.implicit?.text || '')}</div>
        <div class="codex-stat">цена: 🎭${base.price} · требует добить боссов: ${base.bossKillsRequired}</div>
        <div class="codex-desc">${esc(base.flavor || '')}</div>
      </div>`).join('');
    return;
  }

  if (tab === 'currencies') {
    body.innerHTML = (CONST.currencies || []).map((orb) => `
      <div class="codex-row">
        <div class="codex-row-top">
          <span>${esc(orb.icon)}</span>
          <span class="codex-row-name">${esc(orb.name)}</span>
          <span class="codex-badge">${esc(orb.tier)}</span>
          <span class="codex-key">${esc(orb.full)}</span>
        </div>
        <div class="codex-stat">${esc(orb.description)}</div>
      </div>`).join('');
    return;
  }

  if (tab === 'mapmods') {
    body.innerHTML = Object.values(CONST.mapMods || {}).map((mod) => `
      <div class="codex-row">
        <div class="codex-row-top">
          <span>${esc(mod.icon)}</span>
          <span class="codex-row-name">${esc(mod.name)}</span>
          <span class="codex-key">${esc(mod.id)}</span>
        </div>
        <div class="codex-stat" style="color:#ff9d8f">риск: ${esc(mod.risk)}</div>
        <div class="codex-stat" style="color:#a8e8c8">награда: ${esc(mod.reward)}</div>
      </div>`).join('');
    return;
  }

  if (tab === 'uniques') {
    body.innerHTML = (CONST.uniqueDice || []).map((unique) => `
      <div class="codex-row">
        <div class="codex-row-top">
          <span>${esc(unique.icon)}</span>
          <span class="codex-row-name rarity-unique">${esc(unique.name)}</span>
          <span class="codex-key">${esc(unique.base)}</span>
        </div>
        <div class="codex-stat">🔸 ${esc(unique.special?.text || '')}</div>
        <div class="codex-desc">${esc(unique.flavor)}</div>
      </div>`).join('');
  }
}

function openCodex() {
  renderCodex();
  openModal('#codexModal');
}

/* ═══════════════════ События ═══════════════════ */

function bindEvents() {
  /* Навигация */
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go) {
      goTo(go.dataset.go);
      return;
    }
    const close = event.target.closest('[data-close]');
    if (close) {
      closeModal(close.dataset.close);
      return;
    }
    if (event.target.classList.contains('modal')) {
      event.target.classList.remove('open');
      return;
    }
    const profile = event.target.closest('[data-profile]');
    if (profile) {
      switchProfile(profile.dataset.profile);
      return;
    }
    const quest = event.target.closest('[data-quest]');
    if (quest) {
      act(quest, async () => {
        const result = await api('/quest/claim', { method: 'POST', body: { questId: quest.dataset.quest } });
        sound.success();
        toast(result.message, 'gold');
        await loadState();
      }, { soundKey: null });
      return;
    }

    /* Кузня */
    const orbBtn = event.target.closest('[data-orb]');
    if (orbBtn) {
      craftOrb(orbBtn.dataset.orb, orbBtn);
      return;
    }
    const benchBtn = event.target.closest('[data-bench]');
    if (benchBtn) {
      craftBench(benchBtn.dataset.bench, benchBtn);
      return;
    }
    const sellBtn = event.target.closest('[data-salvage]');
    if (sellBtn) {
      act(sellBtn, async () => {
        const result = await api('/inventory/salvage', { method: 'POST', body: { dieId: sellBtn.dataset.salvage } });
        sound.anvil();
        toast(result.message, 'gold');
        await loadState();
      }, { soundKey: null });
      return;
    }
    const selectDie = event.target.closest('[data-select-die]');
    if (selectDie) {
      state.selectedDieId = selectDie.dataset.selectDie;
      sound.click();
      renderForge();
      return;
    }
    const equipBtn = event.target.closest('[data-equip]');
    if (equipBtn) {
      act(equipBtn, async () => {
        const result = await api('/inventory/equip', { method: 'POST', body: { dieId: equipBtn.dataset.equip } });
        sound.success();
        toast(result.message, 'gold');
        await loadState();
      }, { soundKey: null });
      return;
    }
    const lockBtn = event.target.closest('[data-lock]');
    if (lockBtn) {
      act(lockBtn, async () => {
        const result = await api('/inventory/toggle-lock', { method: 'POST', body: { dieId: lockBtn.dataset.lock } });
        toast(result.message);
        await loadState();
      }, { soundKey: 'click' });
      return;
    }
    const buyBtn = event.target.closest('[data-buy]');
    if (buyBtn) {
      act(buyBtn, async () => {
        const result = await api('/inventory/buy-base', { method: 'POST', body: { baseId: buyBtn.dataset.buy } });
        sound.anvil();
        toast(result.message, 'gold');
        await loadState();
      }, { soundKey: null });
      return;
    }

    /* Карты */
    const mapRow = event.target.closest('[data-map]');
    if (mapRow) {
      state.selectedMapId = mapRow.dataset.map;
      sound.click();
      renderMaps();
      return;
    }
    const mapOrb = event.target.closest('[data-map-orb]');
    if (mapOrb) {
      act(mapOrb, async () => {
        const result = await api('/maps/craft', {
          method: 'POST',
          body: { mapId: state.selectedMapId, orbId: mapOrb.dataset.mapOrb },
        });
        sound.anvil();
        toast(result.message, 'ok');
        await loadState();
      }, { soundKey: null });
      return;
    }

    /* Атлас / рейд */
    const deposit = event.target.closest('[data-deposit]');
    if (deposit) {
      raidAction(deposit, '/atlas/deposit', { fragmentId: deposit.dataset.deposit }, { soundKey: 'success' });
      return;
    }

    /* Админка */
    const adminBtn = event.target.closest('[data-admin]');
    if (adminBtn) {
      adminAction(adminBtn.dataset.admin);
      return;
    }

    /* Кодекс-табы */
    const tabBtn = event.target.closest('.codex-tab');
    if (tabBtn) {
      state.codexTab = tabBtn.dataset.tab;
      $$('.codex-tab').forEach((tab) => tab.classList.toggle('active', tab === tabBtn));
      sound.click();
      renderCodex();
    }
  });

  /* Прямые обработчики */
  byId('rollBtn').addEventListener('click', (event) => doRoll(event.currentTarget));
  byId('gambleBtn').addEventListener('click', (event) => act(event.currentTarget, async () => {
    const result = await api('/inventory/gamble-unique', { method: 'POST', body: {} });
    sound.anvil();
    showLoot('unique', result.die.name, 'Уникальный кубик от Гвеннен');
    await loadState();
  }));

  byId('startRunBtn').addEventListener('click', (event) => startRun(event.currentTarget, false));
  byId('autoRunBtn').addEventListener('click', (event) => startRun(event.currentTarget, true));
  byId('buyMapBtn').addEventListener('click', (event) => act(event.currentTarget, async () => {
    const result = await api('/maps/buy', { method: 'POST', body: {} });
    sound.chest();
    toast(result.message, 'gold');
    await loadState();
  }));

  byId('summonRaidBtn').addEventListener('click', (event) => raidAction(event.currentTarget, '/raid/summon', {}, {
    soundKey: 'raidAlarm',
    onSuccess: (result) => {
      showLoot('unique', 'Рейд-Босс призван', result.raid?.name || '');
      toast(result.message, 'myth', 6000);
    },
  }));
  byId('raidAttackBtn').addEventListener('click', (event) => raidAction(event.currentTarget, '/raid/attack', {}, {
    soundKey: 'raidHit',
    onSuccess: (result) => {
      if (result.roll?.crit) sound.crit();
      if (result.killed) showLoot('unique', 'Рейд-босс повержен!', 'Забирайте банк лута');
      toast(result.message, result.killed ? 'myth' : 'ok');
    },
  }));
  byId('raidClaimBtn').addEventListener('click', (event) => raidAction(event.currentTarget, '/raid/claim', {}, {
    soundKey: 'chest',
    onSuccess: (result) => {
      showLoot('exalted', result.isMvp ? 'MVP награда!' : 'Мешок лута', result.isMvp ? 'Экзальт + Дивайн' : '');
      toast(result.message, 'gold');
    },
  }));
  byId('raidRollBtn').addEventListener('click', (event) => raidAction(event.currentTarget, '/raid/roll-loot', {}, {
    soundKey: 'exalted',
    onSuccess: (result) => {
      showLoot('unique', result.result?.dieName, `достаётся ${result.result?.winnerName}`);
      toast(result.message, 'myth', 6000);
    },
  }));

  byId('tradeBtn').addEventListener('click', (event) => doTrade(event.currentTarget));
  byId('duelBtn').addEventListener('click', (event) => doDuel(event.currentTarget));

  byId('soundBtn').addEventListener('click', () => {
    state.soundOn = sound.setEnabled(!state.soundOn);
    localStorage.setItem('pod_sound', state.soundOn ? 'on' : 'off');
    if (state.soundOn) {
      unlockAudio();
      sound.click();
    }
    byId('soundBtn').textContent = state.soundOn ? '🔊' : '🔇';
    byId('soundBtn').classList.toggle('muted', !state.soundOn);
    toast(state.soundOn ? '🔊 Звук включён' : '🔇 Звук выключен');
  });

  byId('codexBtn').addEventListener('click', () => {
    sound.click();
    openCodex();
  });
  byId('hubBtn').addEventListener('click', () => goTo('hub'));

  document.addEventListener('change', (event) => {
    if (event.target.id === 'partnerSelect') {
      state.partnerId = event.target.value || null;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal('#rollModal');
      closeModal('#reportModal');
      closeModal('#codexModal');
    }
  });

  window.addEventListener('hashchange', () => goTo(screenFromHash(), { silent: true }));
  ['pointerdown', 'touchstart', 'keydown'].forEach((type) => {
    window.addEventListener(type, () => unlockAudio(), { once: true, passive: true });
  });
}

/* ═══════════════════ Крафт-действия ═══════════════════ */

async function craftOrb(orbId, button) {
  const die = currentDie();
  if (!die) return toast('Нет кубика', 'err');
  await act(button, async () => {
    try {
      const result = await api('/craft/orb', { method: 'POST', body: { dieId: die.id, orbId } });
      const msgBox = byId('forgeMessage');
      msgBox.textContent = `${result.freeOrb ? '🆓 Сфера не потрачена! ' : ''}${result.message}${result.bonusOrb ? ' ✨ Бонус: сработала пассивка Золотая лихорадка (+1 Хаос)!' : ''}`;
      msgBox.className = 'forge-message success';

      if (orbId === 'vaal') {
        sound.vaal();
        showLoot('vaal', 'Vaal Orb', result.message.slice(0, 60));
      } else if (orbId === 'exalted') {
        showLoot('exalted');
      } else if (orbId === 'divine') {
        showLoot('divine');
      } else if (result.event?.tier === 'T1' || result.event?.tier === 'T0') {
        showLoot(result.event.tier === 'T0' ? 't0' : 't1');
      } else {
        sound.anvil();
      }
      await loadState();
    } catch (error) {
      const msgBox = byId('forgeMessage');
      msgBox.textContent = `⚠️ ${error.message}`;
      msgBox.className = 'forge-message error';
      sound.fail();
    }
  }, { soundKey: null });
}

async function craftBench(recipeId, button) {
  const die = currentDie();
  if (!die) return toast('Нет кубика', 'err');
  await act(button, async () => {
    try {
      const result = await api('/craft/bench', { method: 'POST', body: { dieId: die.id, recipeId } });
      const msgBox = byId('forgeMessage');
      msgBox.textContent = `${result.message} · цена: ${Object.entries(result.cost || {}).map(([id, n]) => `${CONST.currencies.find((c) => c.id === id)?.icon || ''}${n}`).join(' ')}`;
      msgBox.className = 'forge-message success';
      sound.anvil();
      await loadState();
    } catch (error) {
      const msgBox = byId('forgeMessage');
      msgBox.textContent = `⚠️ ${error.message}`;
      msgBox.className = 'forge-message error';
      sound.fail();
    }
  }, { soundKey: null });
}

/* ═══════════════════ Поллинг ═══════════════════ */

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    loadState().catch(() => {});
  }, 7000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadState().catch(() => {});
  });
}

/* ═══════════════════ Boot ═══════════════════ */

async function boot() {
  setupTelegram();
  bindEvents();
  sound.setEnabled(state.soundOn);
  // Декоративный слой (искры) — не критичен: ошибка не должна ломать игру.
  try {
    startEmbers();
  } catch (error) {
    console.warn('[app] embers disabled:', error.message);
  }

  // Справочники подтянем сразу, даже если авторизация не удалась.
  try {
    const session = await authenticate();
    if (session) {
      const me = session.player;
      if (me) {
        toast(`Добро пожаловать, ${me.name} ${me.avatar || ''}`, 'gold', 3000);
      }
    }
  } catch {
    /* гость */
  }

  await loadState({ initial: true });

  if (!state.data) {
    byId('boot').classList.add('gone');
    byId('app').classList.remove('hidden');
    toast('Сервер недоступен — обновите страницу', 'err', 8000);
    return;
  }

  goTo(screenFromHash(), { silent: true });
  byId('boot').classList.add('gone');
  byId('app').classList.remove('hidden');
  startPolling();

  // Если есть завершённый поход — предложим отчёт.
  const run = state.data.activeRun;
  if (run && run.report && run.phase !== 'combat' && run.phase !== 'navigation') {
    setTimeout(() => showReport(run.report), 700);
  }
}

boot().catch((error) => {
  console.error('[app] fatal', error);
  byId('boot').classList.add('gone');
  byId('app').classList.remove('hidden');
  toast(`Ошибка инициализации: ${error.message}`, 'err', 9000);
});
