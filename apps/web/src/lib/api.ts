import type { ApiErrorDTO } from '@dicebound/shared-types';

export async function apiRequest<T>(
  path: '/api/auth/session' | '/api/hub',
  initData: string,
): Promise<T> {
  const response = await fetch(path, {
    method: path.endsWith('/session') ? 'POST' : 'GET',
    headers: {
      Authorization: `tma ${initData}`,
      ...(path.endsWith('/session') ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(path.endsWith('/session') ? { body: '{}' } : {}),
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorDTO | null;
    throw new Error(
      payload?.error?.message ?? 'Не удалось связаться с Обителью. Попробуйте ещё раз.',
    );
  }
  return response.json() as Promise<T>;
}
