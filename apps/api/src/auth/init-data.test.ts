import { describe, expect, it } from 'vitest';
import { NOW, signedInitData, TEST_TOKEN } from '../../../../tests/fixtures.js';
import { verifyAuthorization, verifyInitData } from './init-data.js';

const verify = (raw: string) => verifyInitData(raw, TEST_TOKEN, NOW);

describe('Telegram initData HMAC', () => {
  it('authenticates Unicode names and a signed room slug', () => {
    expect(verify(signedInitData())).toMatchObject({
      user: { id: 42, firstName: 'Алиса' },
      roomSlug: 'r_abcdefgh',
    });
  });
  it('covers the optional Telegram signature field too', () => {
    expect(verify(signedInitData({ signature: 'signed-by-telegram' })).user.id).toBe(42);
  });
  it('does not depend on query-string order', () => {
    expect(verify(signedInitData().split('&').reverse().join('&')).user.id).toBe(42);
  });
  it('rejects tampering and a different bot token', () => {
    expect(() => verify(signedInitData().replace('r_abcdefgh', 'r_abcdefgi'))).toThrow();
    expect(() => verify(signedInitData({}, '999999:another-token'))).toThrow();
  });
  it.each(['', 'x', '0'.repeat(62), 'z'.repeat(64), '0'.repeat(66)])(
    'rejects malformed hash %s without timingSafeEqual length exceptions',
    (hash) => {
      const params = new URLSearchParams(signedInitData());
      params.set('hash', hash);
      expect(() => verify(params.toString())).toThrow('Откройте игру');
    },
  );
  it.each(['hash', 'user', 'auth_date', 'start_param'])('rejects duplicate %s fields', (field) => {
    expect(() => verify(`${signedInitData()}&${field}=extra`)).toThrow();
  });
  it('rejects expiry at 24 hours and timestamps over 30 seconds in the future', () => {
    const timestamp = NOW.getTime() / 1000;
    expect(() => verify(signedInitData({ auth_date: String(timestamp - 86400) }))).toThrow(
      'Срок входа',
    );
    expect(() => verify(signedInitData({ auth_date: String(timestamp + 31) }))).toThrow();
    expect(verify(signedInitData({ auth_date: String(timestamp + 30) })).user.id).toBe(42);
  });
  it.each(['abc', '-1', '1793793600x', '1.5', 'NaN'])(
    'rejects malformed timestamp %s',
    (auth_date) => {
      expect(() => verify(signedInitData({ auth_date }))).toThrow();
    },
  );
  it.each([
    null,
    'bad-json',
    'null',
    '{}',
    '{"id":-1,"first_name":"A"}',
    '{"id":1.5,"first_name":"A"}',
    '{"id":9007199254740992,"first_name":"A"}',
  ])('rejects malformed users', (user) => {
    expect(() => verify(signedInitData({ user }))).toThrow();
  });
  it.each([null, 'c_-100123', '../another-room', 'r_a'])(
    'requires the signed v2 room slug',
    (start_param) => {
      expect(() => verify(signedInitData({ start_param }))).toThrow('ссылка Обители');
    },
  );
  it('bounds raw data and requires the tma scheme', () => {
    expect(() => verify('x'.repeat(16_385))).toThrow();
    expect(() =>
      verifyAuthorization(`Bearer ${signedInitData()}`, TEST_TOKEN, NOW, 86_400),
    ).toThrow();
    expect(verifyAuthorization(`tma ${signedInitData()}`, TEST_TOKEN, NOW, 86_400).user.id).toBe(
      42,
    );
  });
});
