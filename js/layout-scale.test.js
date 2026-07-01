import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maxScaleFromLayout, optimalScaleFromMax } from './layout-scale.js';

describe('maxScaleFromLayout', () => {
  it('uses card height as radial reach with single edge margin', () => {
    const m = {
      halfW: 195,
      halfH: 300,
      baseH: 140,
      baseW: 220,
      dialBaseR: 60,
      riichiExtra: 0,
      margin: 20,
      gap: 2,
      sideInset: 12,
    };
    const radial = 140 + 60;
    const limitY = (300 - 20 - 2) / radial;
    const limitX = (195 - 20 - 2 + 12) / radial;
    assert.equal(maxScaleFromLayout(m, 4.5), Math.min(4.5, Math.max(0.5, Math.min(limitX, limitY))));
  });

  it('returns absolute max when measure missing', () => {
    assert.equal(maxScaleFromLayout(null, 4.5), 4.5);
  });
});

describe('optimalScaleFromMax', () => {
  it('uses full max by default for auto-fit', () => {
    assert.equal(optimalScaleFromMax(2), 2);
    assert.equal(optimalScaleFromMax(0.4), 0.5);
  });
});
