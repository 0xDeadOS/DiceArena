/**
 * PATH OF DICE — public/assets.js
 * 1) SVG-иконки валют и кубиков (inline data-URI, без внешних запросов).
 * 2) Синтезатор звуков на Web Audio API: наковальня, шаг по узлу,
 *    Exalted / Divine / T1 дроп, крит, открытие ларца.
 */

/* ═══════════════════ SVG ИКОНКИ ═══════════════════ */

const ORB_PATHS = {
  whetstone: `<path d="M12 3l7 4v10l-7 4-7-4V7z" fill="none" stroke="C" stroke-width="1.6"/><path d="M8 12h8M12 8v8" stroke="C2" stroke-width="1.4"/>`,
  transmutation: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M12 6.5v11M8 9l8 6M16 9l-8 6" stroke="C2" stroke-width="1.2" opacity=".8"/>`,
  alteration: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M12 4.5c4 3 4 12 0 15-4-3-4-12 0-15z" fill="none" stroke="C2" stroke-width="1.3"/>`,
  augmentation: `<path d="M12 4l6 4v8l-6 4-6-4V8z" fill="none" stroke="C" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="C2"/>`,
  scouring: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M7.5 14.5c2-3 7-3 9 0M8 9h8" stroke="C2" stroke-width="1.4" fill="none"/>`,
  regal: `<path d="M4 16l2-8 3 4 3-6 3 6 3-4 2 8z" fill="none" stroke="C" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 18h16" stroke="C2" stroke-width="1.6"/>`,
  chaos: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M12 6v12M6.8 9l10.4 6M17.2 9L6.8 15" stroke="C2" stroke-width="1.3"/>`,
  annulment: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.6"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="C2" stroke-width="1.7"/>`,
  exalted: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.7"/><path d="M12 5.5l1.9 4.2 4.6.5-3.4 3.1.9 4.5-4-2.3-4 2.3.9-4.5L5.5 10.2l4.6-.5z" fill="C2" opacity=".85"/>`,
  divine: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="C" stroke-width="1.7"/><path d="M12 4v16M4 12h16M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="C2" stroke-width="1.1" opacity=".75"/><circle cx="12" cy="12" r="2.6" fill="C2"/>`,
  vaal: `<path d="M12 4c3 2.6 4.6 5.6 4.6 8.6 0 3.2-2 5.6-4.6 6.9-2.6-1.3-4.6-3.7-4.6-6.9C7.4 9.6 9 6.6 12 4z" fill="none" stroke="C" stroke-width="1.6"/><path d="M12 8.5v8" stroke="C2" stroke-width="1.6" stroke-linecap="round"/>`,
};

const DIE_PATHS = {
  bone_d6: `<path d="M12 3.5l7 4v9l-7 4-7-4v-9z" fill="none" stroke="C" stroke-width="1.5"/><circle cx="9.4" cy="10" r="1.1" fill="C2"/><circle cx="14.6" cy="10" r="1.1" fill="C2"/><circle cx="12" cy="14.6" r="1.1" fill="C2"/>`,
  diamond_d4: `<path d="M12 3.5l7.5 15h-15z" fill="none" stroke="C" stroke-width="1.5"/><path d="M12 3.5v15M4.5 18.5h15" stroke="C2" stroke-width="1" opacity=".7"/>`,
  weighted_d8: `<path d="M12 3l6.5 4.2v9.6L12 21l-6.5-4.2V7.2z" fill="none" stroke="C" stroke-width="1.5"/><path d="M12 3v18M5.5 7.2L18.5 16.8M18.5 7.2L5.5 16.8" stroke="C2" stroke-width=".9" opacity=".55"/>`,
  astral_d6: `<path d="M12 3.2l7.2 4.1v9.4L12 20.8l-7.2-4.1V7.3z" fill="none" stroke="C" stroke-width="1.5"/><path d="M12 7.5l1 2.4 2.6.2-2 1.7.6 2.6-2.2-1.4-2.2 1.4.6-2.6-2-1.7 2.6-.2z" fill="C2"/>`,
  prismatic_d10: `<path d="M12 2.8l6.4 5.6 3 8.4-6.4 4.4H8.4L2 16.8l3-8.4z" fill="none" stroke="C" stroke-width="1.4"/><circle cx="12" cy="12.4" r="2.7" fill="none" stroke="C2" stroke-width="1.2"/>`,
  runic_d12: `<path d="M12 3l6 3.5 2 7-4 6h-8l-4-6 2-7z" fill="none" stroke="C" stroke-width="1.5"/><path d="M9.5 9l5 6M14.5 9l-5 6" stroke="C2" stroke-width="1.2"/>`,
};

function svgData(inner, color, color2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48">`
    + inner.replaceAll('C2', color2).replaceAll('C', color)
    + '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const ORB_COLORS = {
  whetstone: ['#b9b1a2', '#e8dcc8'],
  transmutation: ['#6f9cff', '#b9cfff'],
  alteration: ['#7fb6d6', '#c9e8ff'],
  augmentation: ['#7ff0d0', '#c8fff1'],
  scouring: ['#9aa4ad', '#dfe6ec'],
  regal: ['#c9a227', '#ffe9a3'],
  chaos: ['#a88bff', '#dccbff'],
  annulment: ['#8d1f1f', '#ff9d9d'],
  exalted: ['#efc75e', '#fff3c4'],
  divine: ['#ffe9a3', '#ffffff'],
  vaal: ['#c83030', '#ff8a8a'],
};

export const DIE_COLORS = {
  bone_d6: ['#d8cbb4', '#f3ecdf'],
  diamond_d4: ['#8fd7ff', '#e2f6ff'],
  weighted_d8: ['#b7a58a', '#e4d8c1'],
  astral_d6: ['#a88bff', '#e0d4ff'],
  prismatic_d10: ['#7ff0d0', '#d4fff5'],
  runic_d12: ['#ffb347', '#ffe0ac'],
};

/** Возвращает data-URI с SVG-иконкой сферы. */
export function currencyIcon(id) {
  const inner = ORB_PATHS[id];
  if (!inner) return '';
  const [c1, c2] = ORB_COLORS[id] || ['#c9a227', '#efc75e'];
  return svgData(inner, c1, c2);
}

/** Возвращает data-URI с SVG-иконкой базы кубика. */
export function dieIcon(baseId) {
  const inner = DIE_PATHS[baseId];
  if (!inner) return '';
  const [c1, c2] = DIE_COLORS[baseId] || ['#d8cbb4', '#f3ecdf'];
  return svgData(inner, c1, c2);
}

/** Инлайн SVG-строка (для вставки в DOM без data-URI). */
export function currencySvg(id, size = 22) {
  const inner = ORB_PATHS[id];
  if (!inner) return '';
  const [c1, c2] = ORB_COLORS[id] || ['#c9a227', '#efc75e'];
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">`
    + inner.replaceAll('C2', c2).replaceAll('C', c1)
    + '</svg>';
}

export function dieSvg(baseId, size = 34) {
  const inner = DIE_PATHS[baseId];
  if (!inner) return '';
  const [c1, c2] = DIE_COLORS[baseId] || ['#d8cbb4', '#f3ecdf'];
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">`
    + inner.replaceAll('C2', c2).replaceAll('C', c1)
    + '</svg>';
}

/* ═══════════════════ СИНТЕЗАТОР ЗВУКОВ ═══════════════════ */

/**
 * Класс звукового движка на Web Audio API.
 * Все звуки синтезируются на лету — ни одного mp3/ogg в проекте.
 */
/**
 * Web Audio в Safari/старых WebView возвращает undefined из resume()/suspend().
 * Обёртка проглатывает и промис, и синхронную ошибку.
 */
function safeCall(fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* звук недоступен — молча продолжаем */
  }
}

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.5;
  }

  /** Ленивая инициализация: Web Audio требует жеста пользователя. */
  ensure() {
    if (!this.enabled) return null;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') safeCall(() => this.ctx.resume());
      return this.ctx;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.enabled = false;
      return null;
    }
    return this.ctx;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    if (!this.enabled && this.ctx) {
      safeCall(() => this.ctx.suspend());
    } else if (this.enabled) {
      this.ensure();
    }
    return this.enabled;
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.volume;
  }

  /* ── Примитивы ── */

  tone({ freq = 440, type = 'sine', duration = 0.25, attack = 0.006, decay = 0.2, gain = 0.25, detune = 0, slideTo = null, delay = 0, filter = null }) {
    const ctx = this.ensure();
    if (!ctx) return null;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);
    if (detune) osc.detune.setValueAtTime(detune, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    let node = osc;
    if (filter) {
      const biquad = ctx.createBiquadFilter();
      biquad.type = filter.type || 'lowpass';
      biquad.frequency.setValueAtTime(filter.freq || 1200, now);
      if (filter.q) biquad.Q.value = filter.q;
      node.connect(biquad);
      node = biquad;
    }
    node.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.05);
    return { osc, gain: g };
  }

  noise({ duration = 0.2, gain = 0.16, filterFreq = 2400, filterType = 'bandpass', q = 1.2, delay = 0, sweepTo = null }) {
    const ctx = this.ensure();
    if (!ctx) return null;
    const now = ctx.currentTime + delay;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      const decay = 1 - i / length;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const biquad = ctx.createBiquadFilter();
    biquad.type = filterType;
    biquad.frequency.setValueAtTime(filterFreq, now);
    biquad.Q.value = q;
    if (sweepTo) biquad.frequency.exponentialRampToValueAtTime(Math.max(80, sweepTo), now + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(biquad);
    biquad.connect(g);
    g.connect(this.master);
    src.start(now);
    return { src, gain: g };
  }

  /* ── Звуковые события игры ── */

  /** 🔨 Удар по наковальне при крафте. */
  anvil() {
    this.noise({ duration: 0.16, gain: 0.2, filterFreq: 3200, filterType: 'bandpass', q: 2.4 });
    this.tone({ freq: 2140, type: 'triangle', duration: 0.34, gain: 0.16, decay: 0.3 });
    this.tone({ freq: 1180, type: 'sine', duration: 0.28, gain: 0.12, decay: 0.24, delay: 0.008 });
    this.tone({ freq: 620, type: 'sine', duration: 0.22, gain: 0.09, decay: 0.2, delay: 0.012 });
  }

  /** 👣 Шаг по узлу карты. */
  step() {
    this.noise({ duration: 0.1, gain: 0.11, filterFreq: 620, filterType: 'lowpass', q: 0.8 });
    this.tone({ freq: 132, type: 'sine', duration: 0.16, gain: 0.1, decay: 0.14, slideTo: 88 });
  }

  /** 🎲 Бросок кубика (грохочущий деревянный перекат). */
  diceRoll() {
    for (let i = 0; i < 5; i += 1) {
      this.noise({
        duration: 0.07,
        gain: 0.09 - i * 0.012,
        filterFreq: 1500 + i * 420,
        filterType: 'bandpass',
        q: 2.6,
        delay: i * 0.075,
      });
      this.tone({
        freq: 320 + i * 60,
        type: 'triangle',
        duration: 0.09,
        gain: 0.05,
        decay: 0.07,
        delay: i * 0.075,
      });
    }
  }

  /** 🌟 Exalted Orb — мифический звон. */
  exalted() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.7, gain: 0.15, decay: 0.62, delay: i * 0.075, filter: { type: 'lowpass', freq: 4200 } });
      this.tone({ freq: freq * 2, type: 'sine', duration: 0.4, gain: 0.05, decay: 0.35, delay: i * 0.075 + 0.01 });
    });
    this.noise({ duration: 0.9, gain: 0.07, filterFreq: 5200, filterType: 'highpass', sweepTo: 900 });
  }

  /** ✨ Divine Orb — хрустальный аккорд. */
  divine() {
    const notes = [659.25, 987.77, 1318.5, 1567.98, 1975.5];
    notes.forEach((freq, i) => {
      this.tone({ freq, type: 'sine', duration: 0.85, gain: 0.12, decay: 0.78, delay: i * 0.055 });
    });
    this.noise({ duration: 0.7, gain: 0.05, filterFreq: 7000, filterType: 'highpass' });
    this.tone({ freq: 110, type: 'sine', duration: 1.1, gain: 0.1, decay: 1.0 });
  }

  /** 🏆 Дроп [T1] мода — резкий медный удар. */
  topTier() {
    this.tone({ freq: 1567.98, type: 'square', duration: 0.22, gain: 0.1, decay: 0.18, filter: { type: 'lowpass', freq: 2600 } });
    this.tone({ freq: 2093, type: 'triangle', duration: 0.5, gain: 0.13, decay: 0.44, delay: 0.06 });
    this.noise({ duration: 0.32, gain: 0.09, filterFreq: 4200, filterType: 'bandpass', q: 1.6 });
  }

  /** 💥 Критический удар. */
  crit() {
    this.noise({ duration: 0.24, gain: 0.2, filterFreq: 2600, filterType: 'lowpass', sweepTo: 260 });
    this.tone({ freq: 880, type: 'sawtooth', duration: 0.2, gain: 0.13, decay: 0.17, slideTo: 220 });
    this.tone({ freq: 1760, type: 'square', duration: 0.14, gain: 0.07, decay: 0.11, delay: 0.01 });
  }

  /** 💰 Открытие ларца. */
  chest() {
    this.noise({ duration: 0.18, gain: 0.12, filterFreq: 900, filterType: 'bandpass', q: 1.1 });
    [392, 523.25, 659.25].forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.34, gain: 0.1, decay: 0.3, delay: 0.06 + i * 0.06 });
    });
  }

  /** ⛩️ Святилище. */
  shrine() {
    [261.63, 392, 523.25].forEach((freq, i) => {
      this.tone({ freq, type: 'sine', duration: 0.9, gain: 0.11, decay: 0.85, delay: i * 0.1 });
    });
  }

  /** 🚨 Сирена рейда. */
  raidAlarm() {
    this.tone({ freq: 220, type: 'sawtooth', duration: 1.1, gain: 0.11, slideTo: 660, decay: 1.0, filter: { type: 'lowpass', freq: 1400 } });
    this.tone({ freq: 110, type: 'sine', duration: 1.3, gain: 0.1, decay: 1.2 });
  }

  /** ❌ Провал / промах. */
  fail() {
    this.tone({ freq: 196, type: 'sawtooth', duration: 0.3, gain: 0.1, decay: 0.26, slideTo: 96, filter: { type: 'lowpass', freq: 900 } });
  }

  /** ✅ Успех / подтверждение. */
  success() {
    [523.25, 783.99].forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.24, gain: 0.1, decay: 0.2, delay: i * 0.08 });
    });
  }

  /** 🔮 UI-клик. */
  click() {
    this.tone({ freq: 720, type: 'sine', duration: 0.05, gain: 0.05, decay: 0.04 });
  }

  /** 🩸 Ваал. */
  vaal() {
    this.tone({ freq: 82, type: 'sawtooth', duration: 1.2, gain: 0.16, decay: 1.1, slideTo: 48, filter: { type: 'lowpass', freq: 620 } });
    this.noise({ duration: 0.9, gain: 0.13, filterFreq: 420, filterType: 'lowpass', sweepTo: 90 });
    this.tone({ freq: 155, type: 'square', duration: 0.55, gain: 0.06, decay: 0.5, delay: 0.25 });
  }

  /** 🏆 Победа над боссом карты. */
  victory() {
    [523.25, 587.33, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.6, gain: 0.13, decay: 0.55, delay: i * 0.1, filter: { type: 'lowpass', freq: 3600 } });
    });
  }

  /** 🎯 Удар по рейд-боссу. */
  raidHit() {
    this.noise({ duration: 0.34, gain: 0.2, filterFreq: 320, filterType: 'lowpass', sweepTo: 70 });
    this.tone({ freq: 78, type: 'sine', duration: 0.5, gain: 0.17, decay: 0.46, slideTo: 40 });
  }
}

export const sound = new SoundEngine();

/** Разблокировка звука по первому жесту (требование мобильных браузеров). */
export function unlockAudio() {
  const ctx = sound.ensure();
  if (ctx && ctx.state === 'suspended') safeCall(() => ctx.resume());
}

/** Лут-фильтр: подбирает стиль баннера по событию. */
export const LOOT_STYLES = {
  exalted: { color: '#efc75e', glow: 'rgba(239,199,94,.6)', beam: 'rgba(255,236,170,.34)', sound: 'exalted', label: 'Exalted Orb', sub: 'Экзальт · мифическая сфера' },
  divine: { color: '#fff3c4', glow: 'rgba(255,243,196,.7)', beam: 'rgba(255,252,235,.4)', sound: 'divine', label: 'Divine Orb', sub: 'Дивайн · мифическая сфера' },
  t1: { color: '#ff9d5c', glow: 'rgba(255,122,61,.6)', beam: 'rgba(255,180,120,.3)', sound: 'topTier', label: '[T1] Affix', sub: 'Топовый тир мода' },
  t0: { color: '#ff6a55', glow: 'rgba(255,92,71,.65)', beam: 'rgba(255,140,120,.3)', sound: 'topTier', label: '[T0] Vaal Tier', sub: 'Тир, доступный только Ваалу' },
  vaal: { color: '#e05050', glow: 'rgba(200,48,48,.6)', beam: 'rgba(255,120,120,.28)', sound: 'vaal', label: 'Vaal Orb', sub: 'Осквернение' },
  chaos: { color: '#a88bff', glow: 'rgba(168,139,255,.5)', beam: 'rgba(200,180,255,.26)', sound: 'topTier', label: 'Chaos Orb', sub: 'Сфера Хаоса' },
  unique: { color: '#d98b3a', glow: 'rgba(217,139,58,.6)', beam: 'rgba(255,190,120,.3)', sound: 'exalted', label: 'Unique Die', sub: 'Уникальный кубик' },
  rare: { color: '#efc75e', glow: 'rgba(239,199,94,.4)', beam: 'rgba(255,230,160,.2)', sound: 'success', label: 'Rare Drop', sub: 'Редкий дроп' },
};

export default { sound, currencyIcon, dieIcon, currencySvg, dieSvg, LOOT_STYLES, unlockAudio, SoundEngine };
