interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
}
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** The launch hash is used only to decide whether to load the official SDK. */
export async function loadTelegram(): Promise<TelegramWebApp | undefined> {
  if (window.Telegram?.WebApp) return window.Telegram.WebApp;
  if (!/(?:^|[?#&])tgWebAppData=/.test(location.hash + location.search)) return undefined;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(
        new Error(
          'Не удалось загрузить Telegram SDK. Проверьте соединение и откройте игру заново.',
        ),
      );
    }, 8_000);
    script.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error('Telegram SDK недоступен. Откройте игру заново.'));
    };
    document.head.append(script);
  });
  const app = window.Telegram?.WebApp;
  if (!app?.initData)
    throw new Error('Нет данных входа. Используйте кнопку /game в Telegram-чате.');
  return app;
}
