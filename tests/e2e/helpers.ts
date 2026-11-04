import type { Page } from '@playwright/test';
import { fixtureHub, signedInitData } from '../fixtures.js';
export async function telegramLaunch(page: Page) {
  const initData = signedInitData();
  await page.addInitScript((raw) => {
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: raw,
          ready() {},
          expand() {},
          setHeaderColor() {},
          setBackgroundColor() {},
          BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
        },
      },
    });
  }, initData);
  return initData;
}
export async function authenticatedPage(page: Page) {
  const raw = await telegramLaunch(page);
  const hub = fixtureHub();
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: { hub, authExpiresAt: '2026-11-05T12:00:00Z' } }),
  );
  await page.route('**/api/hub', (route) => route.fulfill({ json: hub }));
  return raw;
}
