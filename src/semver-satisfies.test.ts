import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isValidRange,
  parseRange,
  parseVersion,
  satisfies,
} from './semver-satisfies.js';

describe('parseVersion', () => {
  it.each([
    ['1.2.3', { major: 1, minor: 2, patch: 3, prerelease: [], build: [] }],
    ['0.0.0', { major: 0, minor: 0, patch: 0, prerelease: [], build: [] }],
    ['10.20.30', { major: 10, minor: 20, patch: 30, prerelease: [], build: [] }],
    ['1.0.0-alpha.6', { major: 1, minor: 0, patch: 0, prerelease: ['alpha', '6'], build: [] }],
    ['1.0.0+build.1', { major: 1, minor: 0, patch: 0, prerelease: [], build: ['build', '1'] }],
    [
      '1.2.3-rc.1+build.2',
      { major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'], build: ['build', '2'] },
    ],
    ['v1.2.3', { major: 1, minor: 2, patch: 3, prerelease: [], build: [] }],
  ])('parses %s', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });

  it.each(['1.2', '1', '01.2.3', '', 'foo', '1.2.3.4', null as unknown as string])(
    'rejects malformed %j',
    (bad) => {
      expect(parseVersion(bad)).toBeNull();
    }
  );
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '1.0.0', 1],
    ['1.0.0', '1.1.0', -1],
    ['1.1.0', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    // Prerelease < release
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0', '1.0.0-alpha', 1],
    // Prerelease compare: alpha < beta
    ['1.0.0-alpha', '1.0.0-beta', -1],
    // Prerelease compare: numeric < alpha
    ['1.0.0-1', '1.0.0-alpha', -1],
    // Prerelease compare: numeric ordering
    ['1.0.0-alpha.1', '1.0.0-alpha.2', -1],
    ['1.0.0-alpha.10', '1.0.0-alpha.2', 1],
    // Prerelease compare: shorter loses when shared identifiers equal
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
  ])('compareVersions(%s, %s) sign matches %d', (a, b, expected) => {
    const r = compareVersions(a, b);
    if (expected === 0) expect(r).toBe(0);
    else if (expected < 0) expect(r).toBeLessThan(0);
    else expect(r).toBeGreaterThan(0);
  });

  it('throws on invalid input', () => {
    expect(() => compareVersions('bad', '1.0.0')).toThrow(/invalid version/);
    expect(() => compareVersions('1.0.0', 'bad')).toThrow(/invalid version/);
  });
});

describe('parseRange', () => {
  it('accepts *', () => {
    expect(parseRange('*')).toEqual([]);
  });

  it('accepts exact version', () => {
    expect(parseRange('1.2.3')).toEqual([{ op: '=', version: '1.2.3' }]);
  });

  it('accepts =1.2.3', () => {
    expect(parseRange('=1.2.3')).toEqual([{ op: '=', version: '1.2.3' }]);
  });

  it('accepts comparators', () => {
    expect(parseRange('>=1.0.0 <2.0.0')).toEqual([
      { op: '>=', version: '1.0.0' },
      { op: '<', version: '2.0.0' },
    ]);
  });

  it('expands tilde ~1.2.3 to >=1.2.3 <1.3.0', () => {
    expect(parseRange('~1.2.3')).toEqual([
      { op: '>=', version: '1.2.3' },
      { op: '<', version: '1.3.0' },
    ]);
  });

  it('expands tilde ~1.2 to >=1.2.0 <1.3.0', () => {
    expect(parseRange('~1.2')).toEqual([
      { op: '>=', version: '1.2.0' },
      { op: '<', version: '1.3.0' },
    ]);
  });

  it('expands tilde ~1 to >=1.0.0 <2.0.0', () => {
    expect(parseRange('~1')).toEqual([
      { op: '>=', version: '1.0.0' },
      { op: '<', version: '2.0.0' },
    ]);
  });

  it('expands caret ^1.2.3 to >=1.2.3 <2.0.0', () => {
    expect(parseRange('^1.2.3')).toEqual([
      { op: '>=', version: '1.2.3' },
      { op: '<', version: '2.0.0' },
    ]);
  });

  it('expands caret ^0.2.3 to >=0.2.3 <0.3.0 (0.x special-case)', () => {
    expect(parseRange('^0.2.3')).toEqual([
      { op: '>=', version: '0.2.3' },
      { op: '<', version: '0.3.0' },
    ]);
  });

  it('expands caret ^0.0.3 to >=0.0.3 <0.0.4 (0.0.x special-case)', () => {
    expect(parseRange('^0.0.3')).toEqual([
      { op: '>=', version: '0.0.3' },
      { op: '<', version: '0.0.4' },
    ]);
  });

  it.each([
    ['1 || 2', /OR ranges/],
    ['1.0.0 - 2.0.0', /hyphen ranges/],
    ['1.x', /x-ranges/],
    ['', /must not be empty/],
    ['>=badversion', /invalid version/],
  ])('rejects %s', (bad, pattern) => {
    expect(() => parseRange(bad)).toThrow(pattern);
  });
});

describe('satisfies — basic', () => {
  it.each([
    // exact
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['1.2.3', '=1.2.3', true],
    // comparators
    ['1.2.3', '>=1.2.3', true],
    ['1.2.4', '>=1.2.3', true],
    ['1.2.2', '>=1.2.3', false],
    ['1.2.3', '>1.2.3', false],
    ['1.2.4', '>1.2.3', true],
    ['1.2.3', '<=1.2.3', true],
    ['1.2.2', '<=1.2.3', true],
    ['1.2.3', '<1.2.3', false],
    ['1.2.2', '<1.2.3', true],
    // AND ranges
    ['1.5.0', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['0.9.9', '>=1.0.0 <2.0.0', false],
    // *
    ['1.0.0', '*', true],
    ['0.0.1', '*', true],
    ['9.9.9-beta.1', '*', true],
  ])('satisfies(%s, %s) === %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe('satisfies — tilde', () => {
  it.each([
    ['1.2.3', '~1.2.3', true],
    ['1.2.4', '~1.2.3', true],
    ['1.2.99', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.2', '~1.2.3', false],
    // ~1.2 = >=1.2.0 <1.3.0
    ['1.2.0', '~1.2', true],
    ['1.2.99', '~1.2', true],
    ['1.3.0', '~1.2', false],
    // ~1 = >=1.0.0 <2.0.0
    ['1.99.99', '~1', true],
    ['2.0.0', '~1', false],
  ])('satisfies(%s, %s) === %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe('satisfies — caret', () => {
  it.each([
    ['1.2.3', '^1.2.3', true],
    ['1.9.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.2', '^1.2.3', false],
    // ^0.2.3 = >=0.2.3 <0.3.0
    ['0.2.3', '^0.2.3', true],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    // ^0.0.3 = >=0.0.3 <0.0.4
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
  ])('satisfies(%s, %s) === %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe('satisfies — strict prerelease semantics (RFC-002 OQ-4)', () => {
  it('rejects prerelease host under plain release range', () => {
    // A "1.0.0" license should NOT accept a 1.0.0-alpha.6 host by default.
    expect(satisfies('1.0.0-alpha.6', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha.6', '>=1.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha.6', '^1.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha.6', '~1.0.0')).toBe(false);
  });

  it('admits prerelease host when range explicitly includes a prerelease bound at same core', () => {
    // Admin can opt in via prerelease-inclusive range.
    expect(satisfies('1.0.0-alpha.6', '>=1.0.0-alpha.6 <1.0.1')).toBe(true);
    expect(satisfies('1.0.0-alpha.7', '>=1.0.0-alpha.6 <1.0.1')).toBe(true);
    expect(satisfies('1.0.0-alpha.5', '>=1.0.0-alpha.6 <1.0.1')).toBe(false);
  });

  it('release host is unaffected by prerelease bounds at different core', () => {
    // A prerelease bound at 1.0.0 does NOT enable prerelease at 2.0.0.
    expect(satisfies('2.0.0-alpha.1', '>=1.0.0-alpha.6 <3.0.0')).toBe(false);
  });

  it('star (*) accepts anything including prerelease', () => {
    expect(satisfies('1.0.0-alpha.6', '*')).toBe(true);
    expect(satisfies('9.9.9-beta.99', '*')).toBe(true);
  });

  it('release host under prerelease-inclusive range still needs to numerically satisfy', () => {
    // Prerelease bound is meant for prerelease bypass; release still evaluated numerically.
    expect(satisfies('1.0.0', '>=1.0.0-alpha.6 <1.0.1')).toBe(true);
    expect(satisfies('1.0.1', '>=1.0.0-alpha.6 <1.0.1')).toBe(false);
  });
});

describe('satisfies — real-world license scenarios', () => {
  it('license locked to 1.x major', () => {
    expect(satisfies('1.0.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('1.99.99', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('license locked to exact patch', () => {
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '=1.2.3')).toBe(false);
  });

  it('license for alpha channel', () => {
    expect(satisfies('1.0.0-alpha.6', '>=1.0.0-alpha <1.0.0')).toBe(true);
    expect(satisfies('1.0.0-alpha.999', '>=1.0.0-alpha <1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '>=1.0.0-alpha <1.0.0')).toBe(false);
  });

  it('unrestricted license (product_version: *)', () => {
    expect(satisfies('0.0.1', '*')).toBe(true);
    expect(satisfies('99.99.99', '*')).toBe(true);
  });
});

describe('isValidRange', () => {
  it.each(['*', '1.2.3', '=1.2.3', '>=1.0.0 <2.0.0', '~1.2', '^1.2.3'])('accepts %s', (r) => {
    expect(isValidRange(r)).toBe(true);
  });

  it.each(['1 || 2', 'x.y.z', '', 'not-a-version'])('rejects %s', (r) => {
    expect(isValidRange(r)).toBe(false);
  });
});
