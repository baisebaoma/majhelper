import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeRiichiDefen } from './defen.js';
import { computeSanmaDefen } from './sanma-defen.js';

describe('riichi defen golden cases', () => {
  it('30fu 1han ron child = 1000', () => {
    const r = computeRiichiDefen({
      breakdown: { fan: 1, elements: [] },
      fu: 30,
      isTsumo: false,
      menfeng: 1,
      ronDirection: 'shimocha',
      changbang: 0,
      lizhibang: 0,
      rule: { kazoeYakuman: true, kiriageMangan: false },
    });
    assert.equal(r.defen, 1000);
    assert.deepEqual(r.fenpei, [0, 1000, -1000, 0]);
  });

  it('30fu 1han tsumo child = 500/300/300', () => {
    const r = computeRiichiDefen({
      breakdown: { fan: 1, elements: [] },
      fu: 30,
      isTsumo: true,
      menfeng: 1,
      changbang: 0,
      lizhibang: 0,
      rule: { kazoeYakuman: true, kiriageMangan: false },
    });
    assert.equal(r.defen, 1100);
    assert.deepEqual(r.fenpei, [-500, 1100, -300, -300]);
  });

  it('honba and riichi sticks on dealer ron', () => {
    const r = computeRiichiDefen({
      breakdown: { fan: 1, elements: [] },
      fu: 30,
      isTsumo: false,
      menfeng: 0,
      ronDirection: 'toimen',
      changbang: 2,
      lizhibang: 1,
      rule: { kazoeYakuman: true, kiriageMangan: false },
    });
    assert.equal(r.defen, 1500);
    assert.equal(r.fenpei[0], 3100);
  });
});

describe('sanma defen', () => {
  it('child tsumo 1han distributes among 3', () => {
    const r = computeSanmaDefen({
      breakdown: { fan: 1, elements: [] },
      fu: 30,
      isTsumo: true,
      menfeng: 1,
      changbang: 0,
      lizhibang: 0,
    });
    assert.equal(r.fenpei.length, 3);
    assert.equal(r.fenpei.reduce((a, b) => a + b, 0), 0);
    assert.ok(r.defen > 0);
  });

  it('dealer ron toimen pays out (not zero fenpei)', () => {
    const r = computeSanmaDefen({
      breakdown: { fan: 1, elements: [] },
      fu: 30,
      isTsumo: false,
      menfeng: 0,
      ronDirection: 'toimen',
      changbang: 0,
      lizhibang: 0,
    });
    assert.equal(r.defen, 1500);
    assert.deepEqual(r.fenpei, [1500, 0, -1500]);
  });
});
