import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetHostProductIdentityForTest,
  getHostProductIdentity,
  setHostProductIdentity,
} from './host-identity.js';

describe('host-identity', () => {
  afterEach(() => {
    _resetHostProductIdentityForTest();
  });

  it('starts null', () => {
    expect(getHostProductIdentity()).toBeNull();
  });

  it('accepts a well-formed identity and returns it', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    expect(getHostProductIdentity()).toEqual({
      product: 'devagent-cli',
      version: '1.0.0',
    });
  });

  it('is a no-op when called twice with the same product + version', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    expect(getHostProductIdentity()).toEqual({
      product: 'devagent-cli',
      version: '1.0.0',
    });
  });

  it('accepts version change under the same product (hot-reload / auto-update)', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.1' });
    expect(getHostProductIdentity()).toEqual({
      product: 'devagent-cli',
      version: '1.0.1',
    });
  });

  it('throws when called with a DIFFERENT product', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    expect(() => setHostProductIdentity({ product: 'devagent-app', version: '1.0.0' })).toThrow(
      /conflicting product identity/
    );
    // Original identity should survive the failed overwrite attempt
    expect(getHostProductIdentity()?.product).toBe('devagent-cli');
  });

  it('rejects missing / empty product', () => {
    expect(() => setHostProductIdentity({ product: '', version: '1.0.0' })).toThrow(
      /product must be a non-empty string/
    );
    expect(() =>
      // @ts-expect-error — deliberately violating the type
      setHostProductIdentity({ version: '1.0.0' })
    ).toThrow(/product must be a non-empty string/);
  });

  it('rejects missing / empty version', () => {
    expect(() => setHostProductIdentity({ product: 'devagent-cli', version: '' })).toThrow(
      /version must be a non-empty string/
    );
    expect(() =>
      // @ts-expect-error — deliberately violating the type
      setHostProductIdentity({ product: 'devagent-cli' })
    ).toThrow(/version must be a non-empty string/);
  });

  it('rejects non-string product', () => {
    expect(() =>
      // @ts-expect-error — deliberately violating the type
      setHostProductIdentity({ product: 123, version: '1.0.0' })
    ).toThrow(/product must be a non-empty string/);
  });

  it('accepts an arbitrary product code not in KNOWN_PRODUCTS', () => {
    // Per RFC-002 §2.1.1 revision-1: ProductCode is `string`, so unknown codes
    // are accepted at the type level and at the setter level.
    setHostProductIdentity({ product: 'future-product-xyz', version: '0.1.0' });
    expect(getHostProductIdentity()?.product).toBe('future-product-xyz');
  });

  it('_resetHostProductIdentityForTest clears state', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    _resetHostProductIdentityForTest();
    expect(getHostProductIdentity()).toBeNull();
  });
});
