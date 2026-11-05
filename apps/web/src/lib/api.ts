import type { ApiErrorDTO } from '@dicebound/shared-types';
export type GamePath =
  | '/api/map/start'
  | '/api/expedition/start'
  | '/api/map/step'
  | '/api/map/retreat'
  | '/api/battle/roll'
  | '/api/battle/decision';
export type InventoryPath =
  | '/api/tutorial/reward'
  | '/api/tutorial/complete'
  | '/api/inventory/claim'
  | '/api/inventory/equip'
  | '/api/inventory/lock'
  | '/api/inventory/dismantle'
  | '/api/workshop/craft'
  | '/api/workshop/master-facet';
export type ApiPath =
  | GamePath
  | InventoryPath
  | '/api/inventory'
  | '/api/map/current'
  | '/api/auth/session'
  | '/api/hub';
export interface Mutation {
  key: string;
  body: Record<string, unknown>;
}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function apiRequest<T>(
  path: ApiPath,
  initData: string,
  mutation?: Mutation,
): Promise<T> {
  const post = path === '/api/auth/session' || !!mutation;
  const response = await fetch(path, {
    method: post ? 'POST' : 'GET',
    headers: {
      Authorization: `tma ${initData}`,
      ...(post ? { 'Content-Type': 'application/json' } : {}),
      ...(mutation ? { 'Idempotency-Key': mutation.key } : {}),
    },
    ...(post ? { body: JSON.stringify(mutation?.body ?? {}) } : {}),
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorDTO | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? 'Не удалось связаться с Обителью. Попробуйте ещё раз.',
    );
  }
  return response.json() as Promise<T>;
}
