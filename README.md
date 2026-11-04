# Dicebound: Chat Raiders

Асинхронный roguelike для дружеских Telegram-чатов. Один чат — одна **Обитель**, отдельный герой и один активный боевой кубик.

**Реализован этап 1 спецификации v2.0 — основание проекта, не весь игровой MVP.**

## Что уже работает

- npm-монорепозиторий: Fastify API, grammY-бот, React 18 / Vite / Tailwind / Zustand Mini App, общие типы, игровое ядро и Prisma.
- PostgreSQL-схема и начальная SQL-миграция с enum, FK, CHECK и частичными уникальными индексами.
- `/game` в группе создаёт комнату со стабильным `r_<nanoid(8)>` и отправляет **URL-кнопку**, не `web_app`.
- Проверка Telegram HMAC через `timingSafeEqual`, срока подписи и членства через `getChatMember`; ограниченный участник допускается только при `is_member = true`.
- Атомарная регистрация `(telegram_user_id, room_id)`, в том числе при параллельном первом входе.
- Стартовый костяной кубик с **55 PS**, 150 золота, 3 сферы Отливки, 2 Закалки и **1 Гранения**. Кошелёк не занимает слоты сумки.
- `POST /api/auth/session`, `GET /api/hub`, health checks, 5 запросов/с на подписанного Telegram-пользователя.
- Ленивое восстановление бодрости по UTC: +3 в сутки, максимум 6; без cron.
- Хаб, просмотр 12 слотов сумки, шести граней / противоположных пар и кошелька сфер. Мобильная навигация, клавиатурные диалоги и Telegram BackButton.
- Обработка миграции группы в супергруппу и изменения прав бота.

### Чего ещё нет

Боёв, бросков, генерации маршрутов, расходования бодрости, крафта, смены/распыления кубиков, рейдовых атак, наград, онбординг-похода и рассылки игровых анонсов. Таблицы для следующих этапов подготовлены, но **наличие таблицы не означает готовый сервис**. `IdempotencyRecord` пока не используется крафтом — endpoint крафта ещё не реализован.

В обычном браузере показывается явно обозначенный **обзор интерфейса** с тестовыми данными. Он не обращается к защищённому API, не сохраняет прогресс и не является обходом Telegram-авторизации. При ошибке настоящей Telegram-авторизации приложение показывает ошибку, а не подменяет профиль демонстрационным.

## Быстрый просмотр интерфейса

Нужны **Node.js 22.12+** (также поддерживается 20.19+) и **npm 11.6.2+**.

```bash
npm ci
npm run dev:web
```

Откройте `http://localhost:5173`. База данных и Telegram-токен для просмотра не нужны. Сервер слушает `0.0.0.0`; разрешены preview-хосты `*.e2b.app`. Шрифты включены локально, внешние CDN для обзора не нужны.

## Полный локальный запуск

### 1. Окружение и PostgreSQL 16

```bash
cp .env.example .env
# Отредактируйте .env локально: DATABASE_URL, BOT_TOKEN, APP_SHORT_NAME.
# Не отправляйте токен в чат и не добавляйте .env в Git.

npm ci
docker compose up -d --wait db
npm run db:generate
npm run db:migrate
npm run dev
```

`compose.yaml` поднимает **только локальную БД**, привязанную к `127.0.0.1:5432`. Для production используйте отдельные учётные данные, TLS, резервные копии и закрытую сеть. Пароль из примера — исключительно для разработки.

`npm run dev` собирает общие пакеты и запускает API, бота и web. После изменения общих серверных пакетов перезапустите эту команду. Отдельно доступны:

```bash
npm run dev:api       # :3001, с предварительной сборкой общих пакетов
npm run dev:bot       # long polling
npm run dev:web       # :5173, без БД и токена
```

### 2. Настройка Telegram

1. Создайте бота у BotFather. Сохраните его токен **только в локальном `.env` / секретах хостинга**.
2. Создайте Mini App через `/newapp`, задайте HTTPS URL фронтенда и short name. Этот short name укажите в `APP_SHORT_NAME`. Имя бота берётся из `getMe`, а не из клиентского запроса.
3. Веб-страница и `/api` должны быть доступны через **один HTTPS-origin**. В разработке Vite проксирует `/api` на `API_PROXY_TARGET`. Браузер никогда не обращается к `localhost` другого сервиса.
4. Добавьте бота в тестовую группу и назначьте администратором. Это необходимо для гарантированной проверки других участников через `getChatMember`; права удаления сообщений/блокировки людей не требуются.
5. Отправьте `/game`. Ссылка будет вида `https://t.me/<bot>/<app>?startapp=r_abcdefgh`.
6. Откройте кнопку внутри Telegram: сервер проверит подписанный `start_param`, членство и выдаст стартовый комплект.

Не запускайте два polling-процесса для одного токена. Бот отказывается стартовать при уже настроенном webhook, чтобы не переключить существующий deployment на polling. Для ручной проверки Telegram нужен доступ сервера к `api.telegram.org` и браузера к официальному SDK на `telegram.org`.

### 3. Сборка и deployment

```bash
npm run build
npm run start -w @dicebound/api
# В отдельном процессе:
npm run start -w @dicebound/bot
```

Статические файлы — `apps/web/dist`. На HTTPS reverse proxy направьте `/api/*` в API на `3001`, остальные запросы — к статике (SPA fallback на `index.html`). Не используйте Vite dev server для production. Native Telegram WebView и web.telegram.org должны иметь возможность открыть страницу; не устанавливайте `X-Frame-Options: DENY` для Mini App.

API не доверяет произвольному `X-Forwarded-For`. За reverse proxy его дополнительный IP-лимит будет общим для адреса прокси; при масштабировании задайте доверенные адреса прокси явно, не включайте безусловное `trustProxy: true`.

## API этого этапа

| Метод | Путь                | Назначение                                                               |
| ----- | ------------------- | ------------------------------------------------------------------------ |
| POST  | `/api/auth/session` | Проверка входа, создание/загрузка профиля, стартовый комплект один раз   |
| GET   | `/api/hub`          | Актуальные баланс, инвентарь, бодрость и безопасные summary похода/рейда |
| GET   | `/health/live`      | Жив ли процесс                                                           |
| GET   | `/health/ready`     | Доступен ли PostgreSQL                                                   |

Игровые запросы требуют `Authorization: tma <Telegram.WebApp.initData>`. Тело `POST /api/auth/session` — `{}`. `user_id`, `chat_id`, slug из URL браузера и `initDataUnsafe` не используются как источник идентичности.

«Session» здесь — операция инициализации, **не новый JWT**: каждый следующий запрос повторно проверяет `initData`. Срок действия — до 24 часов; после истечения нужно заново открыть Mini App через `/game`. `initData` остаётся только в памяти браузера, не попадает в storage или логи.

```bash
# INIT_DATA задаётся локально из собственного тестового запуска Telegram.
curl http://localhost:3001/api/auth/session \
  -H "Authorization: tma $INIT_DATA" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Ошибки имеют единый формат `{ "error": { "code", "message", "requestId" } }`. Ответы с профилем не кэшируются. Seed, Telegram ID и полные ORM-записи не выдаются клиенту.

## Проверки

```bash
npm run db:generate
npm run db:validate
npm run typecheck
npm test                     # unit + HTTP + mock Bot API
npm run format:check
npm run build
npm audit
```

Интеграционные тесты требуют отдельной PostgreSQL-базы с именем, заканчивающимся на `_test`. Они создают собственную случайную схему, применяют **реальный SQL миграции**, затем удаляют только эту схему.

```bash
# Например, для локального compose (создать один раз):
docker compose exec db createdb -U dicebound dicebound_test
TEST_DATABASE_URL='postgresql://dicebound:dicebound@localhost:5432/dicebound_test' \
  npm run test:integration
```

Проверяются: 20 параллельных регистраций без повторной выдачи ресурсов; откат при ошибке кошелька; отдельные профили одного пользователя в двух чатах; FK экипировки; CHECK/partial indexes; конкурентное восстановление бодрости; безопасные DTO; сохранение комнаты после миграции; HTTP → авторизация → БД.

```bash
npx playwright install --with-deps chromium
npm run test:e2e              # desktop + mobile; Telegram SDK/API подменяются в UI-тестах
```

E2E проверяют навигацию, противоположные грани, шесть сфер, фокус/закрытие диалогов, ошибки входа, передачу `initData`, отсутствие запросов к API в обзоре и отсутствие горизонтального overflow на ширинах 320–1440 px. Это **не** проверка реального Telegram-клиента. Для уже установленного Chromium можно задать `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

CI: `.github/workflows/ci.yml` — PostgreSQL 16, миграции, TypeScript, unit/integration, сборка и Chromium E2E.

## Структура

```text
apps/
  api/                 Fastify, Telegram HMAC, membership cache, безопасные DTO
  bot/                 grammY, /game /start /help, миграция чата, права бота
  web/                 React Mini App и отдельный UI-only обзор
packages/
  shared-types/        Публичные контракты без серверных секретов
  game-core/           Стартовый комплект, базовая формула ETV/PS, пары, бодрость
  db/                  Prisma 7, pg adapter, репозитории, schema и SQL-миграции
tests/                 Fixtures и Playwright
```

- [Архитектурные решения и границы безопасности](docs/architecture.md)
- [Ручная приёмка и следующие этапы](docs/acceptance.md)

> `prisma migrate` требует нативный schema-engine. При первой установке Prisma загружает его с `binaries.prisma.sh`; в среде с ограниченным egress этот домен может быть недоступен. Это не причина заменять PostgreSQL mock-данными или пропускать миграции в production. В данной sandbox SQL проверен непосредственно на PostgreSQL 16; реальный `migrate deploy` и Telegram smoke-test нужно выполнить в окружении с соответствующим сетевым доступом.
