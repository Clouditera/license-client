/**
 * Internal Result<T, E> utility. Replaces the @shared/result dependency
 * carried in CortexDev-Agents so this module stays free of external coupling.
 *
 * Per §F8 / §三 N1: zero runtime third-party dependencies.
 */

export type Result<T, E> = { success: true; data: T } | { success: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}
