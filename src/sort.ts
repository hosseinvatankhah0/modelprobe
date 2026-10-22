import type { ModelResult } from './types.js';

export type SortMode = 'bench' | 'speed' | 'name' | 'free';

export const SORT_MODES: SortMode[] = ['bench', 'speed', 'name', 'free'];

export function isSortMode(value: string): value is SortMode {
  return (SORT_MODES as string[]).includes(value);
}

const scoreOf = (r: ModelResult): number => r.bench?.score ?? -Infinity;

/**
 * مرتب‌سازی نتایج.
 *
 * - `bench` (default): strongest first, ties broken by response speed
 * - `speed`  : fastest response first
 * - `name`   : alphabetical
 * - `free`   : free models first, then strongest, then fastest
 */
export function sortResults(results: ModelResult[], mode: SortMode = 'bench'): ModelResult[] {
  const copy = [...results];

  switch (mode) {
    case 'speed':
      return copy.sort((a, b) => a.latencyMs - b.latencyMs || scoreOf(b) - scoreOf(a));

    case 'name':
      return copy.sort((a, b) => a.model.localeCompare(b.model));

    case 'free':
      return copy.sort((a, b) => {
        const freeA = a.free === true ? 0 : 1;
        const freeB = b.free === true ? 0 : 1;
        if (freeA !== freeB) return freeA - freeB;
        const bench = scoreOf(b) - scoreOf(a);
        if (bench !== 0) return bench;
        return a.latencyMs - b.latencyMs;
      });

    case 'bench':
    default:
      return copy.sort((a, b) => {
        const bench = scoreOf(b) - scoreOf(a);
        if (bench !== 0) return bench;
        return a.latencyMs - b.latencyMs;
      });
  }
}
