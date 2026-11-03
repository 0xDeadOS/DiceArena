/**
 * Статический UI и бот-карточки: проверяем контракт фронтенда без браузера —
 * разметка экранов, data-атрибуты, стили графа, лут-фильтр, SVG-иконки,
 * Web Audio синтезатор и HTML-карточку кубика для grammy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  buildEntryKeyboard,
  getWebAppUrl,
  prepareEntry,
} from '../src/bot.js';
import {
  formatBossCardHtml,
  formatDailyHint,
  formatDieCardHtml,
  formatHelpHtml,
  formatModLine,
  renderBar,
} from '../src/diceCard.js';
import { buildSignedLink, verifySignedLink } from '../src/auth.js';
import { CURRENCIES, DICE_BASES, MAP_NODE_TYPES } from '../src/engine/constants.js';
import { generateDie, createRng } from '../src/engine/crafting.js';
import { makeStore } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const assetsJs = fs.readFileSync(path.join(PUBLIC, 'assets.js'), 'utf8');

const SCREENS = ['hub', 'forge', 'maps', 'atlas', 'raid', 'camp'];

describe('index.html: каркас Web Mini App', () => {
  it('подключает Telegram WebApp SDK, стили и скрипты', () => {
    assert.match(html, /telegram-web-app\.js/);
    assert.match(html, /\/styles\.css/);
    assert.match(html, /\/app\.js/);
    assert.match(html, /<html lang="ru">/);
    assert.match(html, /name="viewport"[^>]*width=device-width/);
  });

  it('содержит ровно шесть полноэкранных разделов и Хаб', () => {
    for (const screen of SCREENS) {
      assert.ok(html.includes(`data-screen="${screen}"`), `нет экрана ${screen}`);
    }
    // Никакой трёхколоночной сетки: только .hub-grid / .nav-cards
    assert.ok(!html.includes('col-1') && !html.includes('sidebar'));
  });

  it('главный экран — Хаб с карточкой кубика и кнопкой броска', () => {
    assert.match(html, /Sanctuary Hub/);
    assert.match(html, /id="rollBtn"/);
    assert.match(html, /В Хаб/);
    assert.match(html, /id="bossBar"/);
    assert.match(html, /id="hubFeed"/);
  });

  it('карточки-переходы во все механики с индикаторами', () => {
    for (const go of ['forge', 'maps', 'atlas', 'raid', 'camp']) {
      assert.ok(html.includes(`data-go="${go}"`), `нет перехода ${go}`);
    }
    for (const badge of ['navForgeBadge', 'navMapsBadge', 'navAtlasBadge', 'navRaidBadge', 'navCampBadge']) {
      assert.ok(html.includes(`id="${badge}"`));
    }
  });

  it('есть контейнеры карты развилок, боя, рейда и верстака', () => {
    for (const id of ['mapGraph', 'combatPanel', 'runLog', 'runActions', 'reliquary', 'benchList', 'forgeOrbs', 'deviceSlot', 'atlasBranches']) {
      assert.ok(html.includes(`id="${id}"`), `нет контейнера ${id}`);
    }
    assert.match(html, /<svg id="mapGraph"/);
  });

  it('есть лут-баннер NeverSink, модалки броска/кодекса/отчёта и тосты', () => {
    for (const id of ['lootBanner', 'rollModal', 'codexModal', 'reportModal', 'toasts']) {
      assert.ok(html.includes(`id="${id}"`));
    }
    assert.match(html, /loot-beam/);
    assert.match(html, /База Модов \(Codex\)/);
  });

  it('кодекс имеет 6 вкладок: префиксы, суффиксы, базы, сферы, моды карт, уникальные', () => {
    const tabs = html.match(/class="codex-tab[^"]*" data-tab="[^"]+"/g) || [];
    assert.equal(tabs.length, 6);
    for (const tab of ['prefixes', 'suffixes', 'bases', 'currencies', 'mapmods', 'uniques']) {
      assert.ok(html.includes(`data-tab="${tab}"`));
    }
  });

  it('переключатель профилей друзей и кнопка звука присутствуют', () => {
    assert.match(html, /id="profileSwitch"/);
    assert.match(html, /id="soundBtn"/);
    assert.match(html, /id="codexBtn"/);
  });

  it('нет заглушек TODO/FIXME', () => {
    for (const source of [html, css, appJs, assetsJs]) {
      assert.ok(!/\/\/\s*TODO|\/\/\s*FIXME|Тут будет/.test(source));
    }
  });
});

describe('styles.css: тёмная тема PoE и адаптив', () => {
  it('палитра, шрифты Cinzel/Inter, тёмный фон', () => {
    assert.match(css, /--bg-0:\s*#0[0-9a-f]{5}/i);
    assert.match(css, /Cinzel/);
    assert.match(css, /Inter/);
    assert.match(css, /--gold:\s*#c9a227/i);
  });

  it('стилизует граф путей карты: рёбра, доступные/посещённые узлы, босса', () => {
    for (const klass of ['.edge', '.edge.live', '.node-group.available', '.node-group.visited', '.node-group.current', '.node-group.boss']) {
      assert.ok(css.includes(klass), `нет стиля ${klass}`);
    }
    assert.match(css, /nodePulse/);
  });

  it('лут-фильтр NeverSink с лучом', () => {
    assert.match(css, /\.loot-banner/);
    assert.match(css, /\.loot-beam/);
    assert.match(css, /beamSweep/);
  });

  it('адаптив под телефон и reduced-motion', () => {
    assert.match(css, /@media \(max-width: 760px\)/);
    assert.match(css, /@media \(max-width: 420px\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /safe-area-inset-top/);
  });

  it('не содержит фиксированной трёхколоночной сетки', () => {
    assert.ok(!/grid-template-columns:\s*[\d.]+fr\s+[\d.]+fr\s+[\d.]+fr\s+[\d.]+fr/.test(css));
  });
});

describe('app.js: SPA-роутер и механики', () => {
  it('роутер знает все экраны и подхватывает hash', () => {
    for (const screen of SCREENS) {
      assert.ok(appJs.includes(`${screen}:`), `роутер не знает ${screen}`);
    }
    assert.match(appJs, /hashchange/);
    assert.match(appJs, /history\.replaceState/);
  });

  it('поллинг /api/state?v=… и инкрементальные обновления', () => {
    assert.match(appJs, /\/api\/state\?v=/);
    assert.match(appJs, /payload\.unchanged/);
    assert.match(appJs, /startPolling/);
  });

  it('обращается ко всем ключевым эндпоинтам API', () => {
    const endpoints = [
      '/auth/session', '/roll', '/craft/orb', '/craft/bench',
      '/inventory/equip', '/inventory/toggle-lock', '/inventory/buy-base',
      '/inventory/gamble-unique', '/inventory/salvage', '/trade/transfer',
      '/maps/craft', '/maps/buy', '/maps/start', '/maps/node', '/maps/turn',
      '/maps/retreat', '/maps/dismiss', '/maps/run',
      '/atlas/point', '/atlas/deposit',
      '/raid/summon', '/raid/attack', '/raid/claim', '/raid/roll-loot',
      '/quest/claim', '/duel',
      '/settings/daily-limit', '/settings/reset-cd', '/settings/reset-boss',
      '/settings/reset-ladder', '/settings/reset-all', '/settings/atlas',
      '/settings/reset-atlas', '/cheat/add-orbs', '/cheat/modify-orbs',
    ];
    for (const endpoint of endpoints) {
      assert.ok(appJs.includes(`'${endpoint}'`) || appJs.includes(`"${endpoint}"`) || appJs.includes(endpoint),
        `нет вызова ${endpoint}`);
    }
  });

  it('рисует интерактивный граф развилок на SVG с кликабельными узлами', () => {
    assert.match(appJs, /drawGraph/);
    assert.match(appJs, /node-group/);
    assert.match(appJs, /available/);
    assert.match(appJs, /addEventListener\('click'/);
    assert.match(appJs, /chooseNode/);
    assert.match(appJs, /viewBox/);
  });

  it('арена боя: три действия и девять боевых сфер', () => {
    for (const action of ['attack', 'defend', 'gamble']) {
      assert.ok(appJs.includes(`id: '${action}'`), `нет действия ${action}`);
    }
    for (const orb of ['whetstone', 'transmutation', 'augmentation', 'annulment', 'scouring', 'chaos', 'exalted', 'divine', 'vaal']) {
      assert.ok(appJs.includes(`${orb}: {`), `нет боевой сферы ${orb}`);
    }
    assert.match(appJs, /combatAction/);
    assert.match(appJs, /combatOrb/);
  });

  it('лут-фильтр и звуки вызываются на мифических событиях', () => {
    assert.match(appJs, /showLoot\('exalted'\)/);
    assert.match(appJs, /showLoot\('divine'\)/);
    assert.match(appJs, /LOOT_STYLES/);
    assert.match(appJs, /sound\.anvil\(\)/);
    assert.match(appJs, /sound\.step\(\)/);
  });

  it('экранирует пользовательские строки перед вставкой в HTML', () => {
    // Имена игроков, названия кубиков и тексты ленты — потенциально «грязные» данные.
    for (const field of ['player.name', 'player.avatar', 'die.name', 'entry.text', 'item.name', 'duel.challengerName']) {
      assert.ok(appJs.includes(`esc(${field})`) || appJs.includes(`esc(${field.split('.')[1]})`),
        `${field} должен проходить через esc()`);
    }
    assert.match(appJs, /function esc\(value\)/);
    assert.ok(appJs.includes('replaceAll(\'&\', \'&amp;\')'));
  });
});

describe('assets.js: SVG-иконки и Web Audio', () => {
  it('SVG-иконки для всех 11 валют и 6 баз', async () => {
    const { currencyIcon, dieIcon, currencySvg, dieSvg } = await import('../public/assets.js');
    for (const id of Object.keys(CURRENCIES)) {
      const uri = currencyIcon(id);
      assert.ok(uri.startsWith('data:image/svg+xml'), `иконка ${id} не SVG`);
      assert.ok(decodeURIComponent(uri).includes('<svg'));
    }
    for (const id of Object.keys(DICE_BASES)) {
      assert.ok(dieIcon(id).includes('svg'), `кубик ${id}`);
      assert.ok(dieSvg(id, 32).includes('<svg'));
    }
    assert.equal(currencySvg('exalted', 24).includes('width="24"'), true);
  });

  it('синтезатор Web Audio API реализует наковальню, шаг, Exalted/Divine/T1', () => {
    assert.match(assetsJs, /class SoundEngine/);
    assert.match(assetsJs, /AudioContext/);
    assert.match(assetsJs, /createOscillator/);
    assert.match(assetsJs, /createBuffer/);
    assert.match(assetsJs, /createBiquadFilter/);
    for (const method of ['anvil', 'step', 'exalted', 'divine', 'topTier', 'crit', 'chest', 'shrine', 'raidAlarm', 'vaal', 'victory', 'raidHit']) {
      assert.ok(new RegExp(`${method}\\(`).test(assetsJs), `нет звука ${method}`);
    }
    // Ни одного аудиофайла: всё синтезируется на лету.
    assert.ok(!/\.(mp3|ogg|wav)['"]/.test(assetsJs));
  });

  it('LOOT_STYLES описывает баннеры лут-фильтра', async () => {
    const { LOOT_STYLES } = await import('../public/assets.js');
    for (const key of ['exalted', 'divine', 't1', 't0', 'vaal', 'chaos', 'unique']) {
      assert.ok(LOOT_STYLES[key], `нет стиля ${key}`);
      assert.ok(LOOT_STYLES[key].color.startsWith('#'));
      assert.ok(LOOT_STYLES[key].sound);
    }
  });
});

describe('Telegram-бот: карточка кубика и клавиатура входа', () => {
  it('formatDieCardHtml отдаёт валидный HTML с кубиком, модами и мощью', () => {
    const die = generateDie({ rng: createRng(5), baseId: 'runic_d12', rarity: 'rare', ilvl: 100, topTierOnly: true });
    die.quality = 10;
    die.vaalImplicits = [{ text: '+40% Increased очков за каждый потраченный Хаос' }];
    die.corrupted = true;
    const html2 = formatDieCardHtml(die, { playerName: 'Ксандр', playerLevel: 12 });
    assert.match(html2, /PATH OF DICE/);
    assert.match(html2, /Кубик Изгнанника/);
    assert.match(html2, /<b>/, 'должен быть HTML-формат');
    assert.match(html2, /ОСКВЕРНЁН/);
    assert.match(html2, /Качество: <b>10%<\/b>/);
    assert.match(html2, /Ксандр/);
    assert.ok((html2.match(/• \[T/g) || []).length >= 3, 'моды в карточке');
    // Запрещённые Telegram-теги не должны встречаться
    assert.ok(!/<div>|<span|<script/i.test(html2));
    assert.ok(!html2.includes('undefined'));
  });

  it('карточка без кубика и escape HTML работают корректно', () => {
    assert.match(formatDieCardHtml(null), /нет кубика/i);
    const hostile = generateDie({ rng: createRng(1), rarity: 'rare', ilvl: 50 });
    hostile.name = '<script>alert(1)</script>';
    const card = formatDieCardHtml(hostile, { playerName: '<b>Взлом</b>' });
    assert.ok(!card.includes('<script>'));
    assert.ok(card.includes('&lt;script&gt;'));
  });

  it('formatModLine рендерит тиры, проценты и крафтовый мод', () => {
    const line = formatModLine({ tier: 'T0', value: 40, unit: 'pct', stat: 'More очков', crafted: true });
    assert.match(line, /\[T0\]/);
    assert.match(line, /40%/);
    assert.match(line, /✦/);
  });

  it('formatBossCardHtml показывает HP-бар и имя босса', () => {
    const card = formatBossCardHtml({ name: 'Кровавый Изгнанник', hp: 500, maxHp: 1000, level: 9, icon: '💀' });
    assert.match(card, /Кровавый Изгнанник/);
    assert.match(card, /500/);
    assert.match(card, /█|░/);
    assert.equal(renderBar(50, 10).includes('50%'), true);
  });

  it('formatHelpHtml перечисляет только 3 команды и не содержит игровых', () => {
    const help = formatHelpHtml();
    for (const cmd of ['/start', '/help', '/web']) assert.ok(help.includes(cmd));
    for (const forbidden of ['/roll', '/craft', '/map', '/raid']) {
      assert.ok(!help.includes(forbidden), `бот не должен знать ${forbidden}`);
    }
  });

  it('formatDailyHint сообщает об остатке бросков', () => {
    assert.match(formatDailyHint({ dailyRollsUsed: 0 }), /Доступно бросков/);
    assert.match(formatDailyHint({ dailyRollsUsed: 5 }), /после 00:00/);
  });

  it('клавиатура входа: web_app/host-safe + персональная подписанная ссылка', () => {
    const keyboard = buildEntryKeyboard({ playerId: 'p2', baseUrl: 'https://dice.example.com/' });
    const json = JSON.stringify(keyboard);
    assert.ok(json.includes('https://dice.example.com/'), json);
    assert.ok(json.includes('player=p2'), 'есть персональная ссылка');
    assert.ok(json.includes('sig='), 'ссылка подписана');
    // Кнопка web_app появляется только для HTTPS
    const local = buildEntryKeyboard({ playerId: 'p2', baseUrl: 'http://localhost:3000/' });
    assert.ok(!JSON.stringify(local).includes('"web_app"'));
    const signed = buildSignedLink({ playerId: 'p2', baseUrl: 'https://dice.example.com/' });
    const url = new URL(signed);
    assert.equal(verifySignedLink({ playerId: 'p2', sig: url.searchParams.get('sig') }).ok, true);
  });

  it('getWebAppUrl всегда отдаёт корень сайта', () => {
    process.env.WEBAPP_URL = 'https://path-of-dice.onrender.com/some/path';
    assert.equal(getWebAppUrl(), 'https://path-of-dice.onrender.com/');
    process.env.WEBAPP_URL = 'невалидный url';
    assert.match(getWebAppUrl(), /^http:\/\/localhost:/);
  });

  it('prepareEntry регистрирует игрока и отдаёт карточку с ежедневной подсказкой', () => {
    const store = makeStore();
    store.db.players.forEach((p) => { p.telegramId = null; });
    const entry = prepareEntry(store, { id: 987654, first_name: 'Изгнанник', username: 'exile' });
    assert.ok(entry.player);
    assert.equal(entry.player.telegramId, 987654);
    assert.match(entry.text, /PATH OF DICE/);
    assert.match(entry.text, /Доступно бросков/);
    assert.ok(entry.token.includes('.'));
  });
});

describe('Согласованность констант и UI', () => {
  it('все типы узлов имеют иконку и используются фронтом', () => {
    for (const type of Object.keys(MAP_NODE_TYPES)) {
      assert.ok(MAP_NODE_TYPES[type].icon);
      assert.ok(appJs.includes(type), `фронт не знает тип узла ${type}`);
    }
  });

  it('все 11 сфер показаны в тайнике и крафте', () => {
    for (const id of Object.keys(CURRENCIES)) {
      assert.ok(appJs.includes(id), `фронт не знает сферу ${id}`);
    }
    assert.ok(!appJs.includes('alchemy'), 'Сферы Алхимии не существует');
  });

  it('CSS/HTML не ссылаются на отсутствующие файлы', () => {
    const referenced = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
    for (const ref of referenced) {
      const filePath = path.join(PUBLIC, ref.replace(/^\//, '').split('?')[0]);
      assert.ok(fs.existsSync(filePath), `нет файла ${ref}`);
    }
  });
});
