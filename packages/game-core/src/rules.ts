export class GameRuleError extends Error {
  readonly status = 409;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GameRuleError';
  }
}
export function requireRule(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new GameRuleError(code, message);
}
