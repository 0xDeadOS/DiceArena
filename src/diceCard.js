/**
 * PATH OF DICE — src/diceCard.js
 * HTML-карточки для Telegram-бота: кубик игрока, босс чата, рейд.
 * Используют только разрешённые Telegram теги (b, i, u, s, code, a).
 */

import { CURRENCIES, DICE_BASES, RARITY, TUNING } from './engine/constants.js';
import { estimateDiePower, getDieAggregatedStats } from './engine/crafting.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function formatModLine(mod) {
  const sign = mod.unit === 'pct' ? '%' : '';
  const crafted = mod.crafted ? ' ✦' : '';
  const tier = mod.tier === 'T0' ? '<b>[T0]</b>' : `[${mod.tier}]`;
  return `${tier} ${mod.value}${sign} ${escapeHtml(mod.stat)}${crafted}`;
}

export function formatImplicitLine(implicit) {
  if (!implicit) return '';
  return `🔹 <i>${escapeHtml(implicit.text || implicit.name || '')}</i>`;
}

/**
 * Красивая HTML-карточка кубика для /start, /help, /web.
 */
export function formatDieCardHtml(die, { playerName = 'Изгнанник', playerLevel = 1 } = {}) {
  if (!die) {
    return '🎲 <b>Кубик Изгнанника</b>\n\nУ вас пока нет кубика. Откройте Web Mini App, чтобы получить стартовый набор.';
  }
  const base = DICE_BASES[die.baseId] || DICE_BASES.bone_d6;
  const rarity = RARITY[die.rarity] || RARITY.normal;
  const stats = getDieAggregatedStats(die);
  const power = estimateDiePower(die);

  const lines = [];
  lines.push(`🎲 <b>PATH OF DICE</b> · <i>Кубик Изгнанника</i>`);
  lines.push('');
  lines.push(`${die.icon || base.icon} <b>${escapeHtml(die.name)}</b> ${rarity.icon} <i>${rarity.label}</i>`);
  lines.push(`<code>${base.short} · ilvl ${die.ilvl} · ур. ${playerLevel} · мощь ${power}</code>`);
  if (die.corrupted) lines.push('🩸 <b>ОСКВЕРНЁН</b>');
  lines.push('');
  lines.push(`🔹 <i>${escapeHtml(base.implicit?.text || '')}</i>`);
  if ((die.vaalImplicits || []).length) {
    for (const implicit of die.vaalImplicits) lines.push(`🔸 <i>${escapeHtml(implicit.text)}</i>`);
  }
  if (die.quality) lines.push(`🪨 Качество: <b>${die.quality}%</b>`);
  if ((die.mods || []).length) {
    lines.push('');
    for (const mod of die.mods) lines.push(`• ${formatModLine(mod)}`);
  } else {
    lines.push('');
    lines.push('<i>Нет модов. Примените Трансмутку в Кузне.</i>');
  }
  lines.push('');
  lines.push(`⚔️ Грань 1–${stats.faces} · крит ${stats.baseCrit}% x${((stats.critMultiTotal || 150) / 100).toFixed(2)}`);
  lines.push(`⭐ Очки: +${stats.incScore}% · редкость: +${stats.rarityPct}%`);
  lines.push('');
  lines.push(`<i>${escapeHtml(base.flavor || '')}</i>`);
  lines.push('');
  lines.push(`👤 ${escapeHtml(playerName)} · жми «Открыть Кубик Изгнанника» ниже`);
  return lines.join('\n');
}

export function formatBossCardHtml(boss, { chatName = 'Убежище Изгнанников' } = {}) {
  if (!boss) return 'Босс чата не найден.';
  const pct = Math.max(0, Math.round((boss.hp / boss.maxHp) * 100));
  const bar = renderBar(pct, 12);
  return [
    `💀 <b>Общий Босс</b> · <i>${escapeHtml(chatName)}</i>`,
    '',
    `${boss.icon || '👹'} <b>${escapeHtml(boss.name)}</b> · уровень ${boss.level}`,
    `${bar} <b>${boss.hp}</b>/${boss.maxHp} HP`,
    '',
    '<i>Каждый бросок любого друга бьёт по этому боссу.</i>',
  ].join('\n');
}

export function renderBar(pct, size = 10) {
  const filled = Math.max(0, Math.min(size, Math.round((pct / 100) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)} ${pct}%`;
}

export function formatHelpHtml() {
  return [
    '📖 <b>PATH OF DICE — Кубик Изгнанника</b>',
    '',
    'Этот бот — только вход в игру. Вся игра живёт в <b>Web Mini App</b>:',
    '• 🎲 ежедневный бросок кубика',
    '• ⚒️ кузня, сферы и Мастерский верстак',
    '• 🗺️ Атлас Миров, карты T1–T16 и походы по развилкам',
    '• 🌳 дерево пассивок на 12 нод',
    '• 🚨 кооперативные рейд-боссы на 12 часов',
    '• 🤝 ладдер, обмен сферами и лента событий',
    '',
    '<b>Команды:</b>',
    '/start — карточка вашего кубика и вход в игру',
    '/help — эта справка',
    '/web — персональная подписанная ссылка на Mini App',
    '',
    '<i>В Telegram-боте нет игровых команд — только вход.</i>',
  ].join('\n');
}

export function formatOrbList(inventory) {
  return Object.entries(CURRENCIES)
    .filter(([id]) => (inventory?.[id] || 0) > 0)
    .map(([id, orb]) => `${orb.icon} ${inventory[id]}`)
    .join(' · ') || 'Тайник пуст';
}

export function formatDailyHint(player) {
  const left = Math.max(0, (TUNING.dailyRollsDefault || 1) - (player?.dailyRollsUsed || 0));
  return left > 0 ? `🎲 Доступно бросков: <b>${left}</b>` : '🎲 Бросок на сегодня сделан — возвращайтесь после 00:00';
}
