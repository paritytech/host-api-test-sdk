import { describe, expect, it } from 'vitest';
import { PermissionAuthorizationRequest } from '@parity/truapi-host';
import { toAuthorizationRequest } from './control-api.js';

/**
 * These assert against the core's own codec rather than against the shape,
 * because the failure being guarded is precisely a request that looks right and
 * does not encode: `grantPermission` writes the decision the core gates on, and
 * a request the codec rejects is a grant that never happened.
 */
const encodes = (tag: string, value?: unknown) =>
  PermissionAuthorizationRequest.enc(toAuthorizationRequest(tag, value));

describe('permission authorization requests', () => {
  it('routes a device capability to the Device variant', () => {
    expect(toAuthorizationRequest('Camera', undefined)).toEqual({
      tag: 'Device',
      value: 'Camera',
    });
    expect(encodes('Camera')).toBeInstanceOf(Uint8Array);
  });

  it('routes a payload-free remote permission to the Remote variant', () => {
    expect(toAuthorizationRequest('ChainSubmit', undefined)).toEqual({
      tag: 'Remote',
      value: { permission: { tag: 'ChainSubmit', value: undefined } },
    });
    expect(encodes('ChainSubmit')).toBeInstanceOf(Uint8Array);
  });

  it('encodes every permission it accepts', () => {
    const tags = [
      'Notifications',
      'Camera',
      'Microphone',
      'Bluetooth',
      'NFC',
      'Location',
      'Clipboard',
      'OpenUrl',
      'Biometrics',
      'WebRtc',
      'ChainSubmit',
      'PreimageSubmit',
      'StatementSubmit',
    ];
    for (const tag of tags) expect(() => encodes(tag), tag).not.toThrow();
    expect(() => encodes('Remote', { domains: ['example.dot'] })).not.toThrow();
  });

  // `Remote` is the one permission whose identity includes a payload: the core
  // stores the decision under the domain list, so a grant without it would be
  // filed against a request no product ever makes.
  it('refuses a payload-carrying permission given by tag alone', () => {
    expect(() => toAuthorizationRequest('Remote', undefined)).toThrow(/carries a payload/);
    expect(encodes('Remote', { domains: ['example.dot'] })).toBeInstanceOf(Uint8Array);
  });

  // Before this, an unknown tag became a `Remote` permission the codec then
  // rejected — a grant that failed inside a `catch` and looked like it worked.
  it('refuses a tag neither union knows', () => {
    expect(() => toAuthorizationRequest('TransactionSubmit', undefined)).toThrow(
      /unknown permission "TransactionSubmit"/,
    );
    expect(() => toAuthorizationRequest('', undefined)).toThrow(/unknown permission/);
  });

  it('names what it would have accepted', () => {
    expect(() => toAuthorizationRequest('Typo', undefined)).toThrow(/Camera.*ChainSubmit/s);
  });
});
