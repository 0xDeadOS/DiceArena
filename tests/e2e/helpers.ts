import type { Page } from '@playwright/test';
import type { HubDTO } from '@dicebound/shared-types';
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
          BackButton: {
            show() {},
            hide() {},
            onClick(callback: () => void) {
              (window as Window & { __testBack?: () => void }).__testBack = callback;
            },
            offClick(callback: () => void) {
              const win = window as Window & { __testBack?: () => void };
              if (win.__testBack === callback) delete win.__testBack;
            },
          },
        },
      },
    });
  }, initData);
  return initData;
}
export async function authenticatedPage(page: Page, hub: HubDTO = fixtureHub()) {
  const raw = await telegramLaunch(page);
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: { hub, authExpiresAt: '2026-11-05T12:00:00Z' } }),
  );
  await page.route('**/api/hub', (route) => route.fulfill({ json: hub }));
  return raw;
}
