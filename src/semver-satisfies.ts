/**
 * Minimal SemVer 2.0.0 satisfies implementation.
 *
 * Purpose: verify that a host binary's `version` satisfies a license payload's
 * `product_version` range (RFC-002 §2.1). Kept inline (Alt-A per RFC-002 §7
 * OQ-4) to preserve license-client's zero-runtime-dependency guarantee.
 *
 * Supported range syntax:
 *   *                       any version
 *   1.2.3                   exact match (equivalent to =1.2.3)
 *   =1.2.3                  exact match
 *   >1.2.3  >=1.2.3  <1.2.3  <=1.2.3
 *   >=1.0.0 <2.0.0          space-separated AND
 *   ~1.2                    tilde: >=1.2.0 <1.3.0
 *   ~1.2.3                  tilde: >=1.2.3 <1.3.0
 *   ~1                      tilde: >=1.0.0 <2.0.0
 *   ^1.2.3                  caret: >=1.2.3 <2.0.0
 *   ^0.2.3                  caret: >=0.2.3 <0.3.0   (0.x special-case per SemVer)
 *   ^0.0.3                  caret: >=0.0.3 <0.0.4   (0.0.x special-case)
 *
 * NOT supported (throws / returns false):
 *   x-ranges (1.x, 1.x.x)   too rarely used in license ranges; explicitly rejected
 *   hyphen ranges (1 - 2)   ambiguous; use explicit comparators instead
 *   ||  (OR)                license.product_version is a single AND-only range
 *
 * Strict prerelease semantics (per SemVer 2.0.0 §11):
 *   satisfies('1.0.0-alpha.6', '>=1.0.0')  →  FALSE
 *   satisfies('1.0.0-alpha.6', '>=1.0.0-alpha.6 <1.0.1')  →  TRUE
 *
 *   The rationale is that a prerelease is a preview of a released version;
 *   licensing a "1.0.0 host" should NOT accept a 1.0.0-alpha build unless
 *   the range explicitly opts in via a prerelease comparator. This matches
 *   node-semver's default `{includePrerelease: false}` behavior and RFC-002
 *   §7 OQ-4 decision.
 */

/**
 * Parse a SemVer version string into structured parts.
 *
 * Grammar: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]
 *
 * Returns null on malformed input.
 */
export function parseVersion(v: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
} | null {
  if (typeof v !== 'string') return null;
  // Optional 'v' prefix is not spec but commonly seen — strip it defensively.
  const trimmed = v.trim().replace(/^v/i, '');

  const match = trimmed.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/,
  );
  if (!match) return null;

  const [, maj, min, pat, pre, bld] = match;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease: pre ? pre.split('.') : [],
    build: bld ? bld.split('.') : [],
  };
}

/**
 * Compare two SemVer versions.
 *
 * @returns  0 if a==b, negative if a<b, positive if a>b.
 * @throws {Error}  if either operand fails to parse.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`[semver] invalid version: ${JSON.stringify(a)}`);
  if (!pb) throw new Error(`[semver] invalid version: ${JSON.stringify(b)}`);

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // Prerelease rules (SemVer 2.0.0 §11):
  //   1. A version without prerelease > a version with prerelease.
  //   2. Prerelease identifiers compared left-to-right; numeric < alphanumeric;
  //      shorter prerelease < longer if all shared identifiers equal.
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;

  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const ai = pa.prerelease[i]!;
    const bi = pb.prerelease[i]!;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na !== nb) return na - nb;
    } else if (aIsNum) {
      return -1;
    } else if (bIsNum) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return pa.prerelease.length - pb.prerelease.length;
}

interface Comparator {
  op: '>' | '>=' | '<' | '<=' | '=';
  version: string;
}

/**
 * Expand a single range token into concrete comparators.
 *
 * Examples:
 *   '*'           → []            (empty = always satisfied)
 *   '1.2.3'       → [{=,'1.2.3'}]
 *   '>=1.0.0'     → [{>=,'1.0.0'}]
 *   '~1.2.3'      → [{>=,'1.2.3'}, {<,'1.3.0'}]
 *   '^1.2.3'      → [{>=,'1.2.3'}, {<,'2.0.0'}]
 *   '^0.2.3'      → [{>=,'0.2.3'}, {<,'0.3.0'}]
 *   '^0.0.3'      → [{>=,'0.0.3'}, {<,'0.0.4'}]
 */
function expandToken(token: string): Comparator[] {
  const t = token.trim();
  if (t === '' || t === '*') return [];

  // Tilde
  if (t.startsWith('~')) {
    const rest = t.slice(1);
    const parts = rest.split('.');
    const major = Number(parts[0]);
    const minor = parts.length >= 2 ? Number(parts[1]) : 0;
    const patch = parts.length >= 3 ? Number(parts[2]) : 0;
    if ([major, minor, patch].some((n) => !Number.isFinite(n))) {
      throw new Error(`[semver] invalid tilde range: ${JSON.stringify(t)}`);
    }
    const lower = `${major}.${minor}.${patch}`;
    // ~1.2.3 → <1.3.0; ~1 → <2.0.0
    const upper = parts.length === 1 ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    return [
      { op: '>=', version: lower },
      { op: '<', version: upper },
    ];
  }

  // Caret
  if (t.startsWith('^')) {
    const rest = t.slice(1);
    const parts = rest.split('.').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`[semver] invalid caret range: ${JSON.stringify(t)}`);
    }
    const major = parts[0] ?? 0;
    const minor = parts.length >= 2 ? parts[1] ?? 0 : 0;
    const patch = parts.length >= 3 ? parts[2] ?? 0 : 0;
    const lower = `${major}.${minor}.${patch}`;
    // SemVer caret rules:
    //   ^1.2.3  → <2.0.0
    //   ^0.2.3  → <0.3.0
    //   ^0.0.3  → <0.0.4
    let upper: string;
    if (major > 0) {
      upper = `${major + 1}.0.0`;
    } else if (minor > 0) {
      upper = `0.${minor + 1}.0`;
    } else {
      upper = `0.0.${patch + 1}`;
    }
    return [
      { op: '>=', version: lower },
      { op: '<', version: upper },
    ];
  }

  // Comparator operators
  const opMatch = t.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!opMatch) throw new Error(`[semver] invalid comparator: ${JSON.stringify(t)}`);
  const [, opRaw, versionRaw] = opMatch;
  const version = (versionRaw ?? '').trim();
  const op = (opRaw || '=') as Comparator['op'];

  if (!parseVersion(version)) {
    throw new Error(`[semver] invalid version in comparator ${JSON.stringify(t)}: ${JSON.stringify(version)}`);
  }
  return [{ op, version }];
}

/**
 * Parse a range string into a flat list of AND-conjoined comparators.
 *
 * @throws {Error} on invalid syntax.
 */
export function parseRange(range: string): Comparator[] {
  if (typeof range !== 'string') {
    throw new Error(`[semver] range must be a string: got ${typeof range}`);
  }
  const raw = range.trim();
  if (raw === '') {
    throw new Error('[semver] range must not be empty');
  }

  // Reject unsupported OR ranges — license.product_version is single AND range.
  if (raw.includes('||')) {
    throw new Error(`[semver] OR ranges (||) not supported: ${JSON.stringify(raw)}`);
  }
  // Reject hyphen ranges — ambiguous; use explicit comparators.
  if (/\s-\s/.test(raw)) {
    throw new Error(`[semver] hyphen ranges (a - b) not supported: ${JSON.stringify(raw)}`);
  }
  // Reject x-ranges — rarely useful for license bounds.
  if (/\bx\b/i.test(raw) || /\*(?!\s|$)/.test(raw)) {
    if (raw !== '*') {
      throw new Error(`[semver] x-ranges not supported: ${JSON.stringify(raw)}`);
    }
  }

  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  const comparators: Comparator[] = [];
  for (const tok of tokens) {
    for (const cmp of expandToken(tok)) {
      comparators.push(cmp);
    }
  }
  return comparators;
}

/**
 * Return true if `version` satisfies `range` under strict-SemVer semantics.
 *
 * Strict prerelease means: a prerelease version (e.g. 1.0.0-alpha.6) only
 * satisfies a range if the range EXPLICITLY includes a prerelease comparator
 * that admits it. A plain range like `>=1.0.0 <2.0.0` will NOT accept
 * 1.0.0-alpha.6, even though numerically it falls in that interval.
 *
 * @throws {Error} If `version` or `range` fails to parse.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`[semver] invalid version: ${JSON.stringify(version)}`);
  }
  const comparators = parseRange(range);
  if (comparators.length === 0) {
    // '*' or empty range → always satisfied, INCLUDING prereleases.
    return true;
  }

  // Strict prerelease semantics: if `version` is a prerelease, at least one
  // comparator in the range must reference the SAME major.minor.patch as a
  // prerelease bound. Otherwise reject.
  if (parsed.prerelease.length > 0) {
    const versionCore = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    const anyPrereleaseBoundInSameCore = comparators.some((c) => {
      const cp = parseVersion(c.version);
      if (!cp) return false;
      const cpCore = `${cp.major}.${cp.minor}.${cp.patch}`;
      return cp.prerelease.length > 0 && cpCore === versionCore;
    });
    if (!anyPrereleaseBoundInSameCore) return false;
  }

  // AND: all comparators must hold.
  for (const cmp of comparators) {
    const cmpResult = compareVersions(version, cmp.version);
    switch (cmp.op) {
      case '=':
        if (cmpResult !== 0) return false;
        break;
      case '>':
        if (cmpResult <= 0) return false;
        break;
      case '>=':
        if (cmpResult < 0) return false;
        break;
      case '<':
        if (cmpResult >= 0) return false;
        break;
      case '<=':
        if (cmpResult > 0) return false;
        break;
    }
  }
  return true;
}

/**
 * Validate that a string parses as a range without throwing. Useful for
 * server-side validation before signing a license.
 */
export function isValidRange(range: string): boolean {
  try {
    parseRange(range);
    return true;
  } catch {
    return false;
  }
}
