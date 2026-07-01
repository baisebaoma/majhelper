import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceAfterWin,
  advanceAfterRyukyoku,
  shouldDealerContinue,
  sanmaAbsentSeat,
  sanmaPhysicalToMenfeng,
  sanmaNextDealer,
  sanmaGhostCompass,
  sanmaDisplayPosForSeat,
  ronDirectionForSeats,
} from './session.js';

describe('shouldDealerContinue (OMC renchanMode)', () => {
  it('mode 1: only dealer win', () => {
    assert.equal(shouldDealerContinue({ renchanMode: 1, dealerWon: true, exhaustiveDraw: false, dealerTenpai: false }), true);
    assert.equal(shouldDealerContinue({ renchanMode: 1, dealerWon: false, exhaustiveDraw: true, dealerTenpai: true }), false);
  });

  it('mode 2: dealer win or tenpai ryukyoku', () => {
    assert.equal(shouldDealerContinue({ renchanMode: 2, dealerWon: false, exhaustiveDraw: true, dealerTenpai: true }), true);
    assert.equal(shouldDealerContinue({ renchanMode: 2, dealerWon: false, exhaustiveDraw: true, dealerTenpai: false }), false);
  });
});

describe('advanceAfterWin', () => {
  it('dealer win: same hand, honba+1', () => {
    const r = advanceAfterWin({
      gameMode: 'riichi-4',
      winnerSeat: 0,
      dealerIndex: 0,
      honba: 0,
      roundWind: 0,
      handNumber: 1,
    });
    assert.equal(r.dealerIndex, 0);
    assert.equal(r.honba, 1);
    assert.equal(r.handNumber, 1);
    assert.equal(r.dealerStreakDelta, 1);
  });

  it('child win: rotate dealer, honba=0, next hand', () => {
    const r = advanceAfterWin({
      gameMode: 'riichi-4',
      winnerSeat: 1,
      dealerIndex: 0,
      honba: 2,
      roundWind: 0,
      handNumber: 1,
    });
    assert.equal(r.dealerIndex, 1);
    assert.equal(r.honba, 0);
    assert.equal(r.handNumber, 2);
    assert.equal(r.dealerStreakDelta, 0);
  });

  it('east 4 child win advances to south 1', () => {
    const r = advanceAfterWin({
      gameMode: 'riichi-4',
      winnerSeat: 2,
      dealerIndex: 3,
      honba: 1,
      roundWind: 0,
      handNumber: 4,
    });
    assert.equal(r.dealerIndex, 0);
    assert.equal(r.roundWind, 1);
    assert.equal(r.handNumber, 1);
    assert.equal(r.honba, 0);
  });

  it('sanma dealer win keeps dealer and honba+1', () => {
    const r = advanceAfterWin({
      gameMode: 'sanma-3',
      winnerSeat: 1,
      dealerIndex: 1,
      honba: 0,
      roundWind: 0,
      handNumber: 2,
      absentSeat: 3,
    });
    assert.equal(r.dealerIndex, 1);
    assert.equal(r.honba, 1);
    assert.equal(r.handNumber, 2);
  });

  it('sanma child win rotates dealer skipping absent', () => {
    const r = advanceAfterWin({
      gameMode: 'sanma-3',
      winnerSeat: 0,
      dealerIndex: 2,
      honba: 2,
      roundWind: 0,
      handNumber: 3,
      absentSeat: 3,
    });
    assert.equal(r.dealerIndex, 0);
    assert.equal(r.honba, 0);
    assert.equal(r.handNumber, 4);
  });
});

describe('advanceAfterRyukyoku', () => {
  it('dealer tenpai: stay, honba+1', () => {
    const r = advanceAfterRyukyoku({
      gameMode: 'riichi-4',
      dealerIndex: 0,
      honba: 0,
      roundWind: 0,
      handNumber: 1,
      dealerTenpai: true,
    });
    assert.equal(r.dealerIndex, 0);
    assert.equal(r.honba, 1);
  });

  it('dealer noten: rotate, honba=0', () => {
    const r = advanceAfterRyukyoku({
      gameMode: 'riichi-4',
      dealerIndex: 0,
      honba: 1,
      roundWind: 0,
      handNumber: 1,
      dealerTenpai: false,
    });
    assert.equal(r.dealerIndex, 1);
    assert.equal(r.honba, 0);
    assert.equal(r.handNumber, 2);
  });
});

describe('sanmaAbsentSeat', () => {
  it('returns empty slot when exactly 3 seated', () => {
    assert.equal(sanmaAbsentSeat(['A', 'B', 'C', null]), 3);
    assert.equal(sanmaAbsentSeat(['A', null, 'B', 'C']), 1);
    assert.equal(sanmaAbsentSeat([null, 'A', 'B', 'C']), 0);
  });

  it('returns null when not exactly 3 seated', () => {
    assert.equal(sanmaAbsentSeat(['A', 'B', null, null]), null);
    assert.equal(sanmaAbsentSeat(['A', 'B', 'C', 'D']), null);
  });
});

describe('sanma layout (deprecated helpers)', () => {
  it('initial dealer bottom -> ghost left', () => {
    assert.equal(sanmaGhostCompass(0), 3);
    assert.deepEqual([
      sanmaDisplayPosForSeat(0, 0),
      sanmaDisplayPosForSeat(1, 0),
      sanmaDisplayPosForSeat(2, 0),
    ], [0, 1, 2]);
  });
});

describe('sanma menfeng / dealer rotation', () => {
  it('maps physical seats skipping absent north', () => {
    assert.equal(sanmaPhysicalToMenfeng(1, 1, 3), 0);
    assert.equal(sanmaNextDealer(2, 3), 0);
  });
});

describe('ronDirectionForSeats', () => {
  it('maps 3-player across to toimen with absent left', () => {
    assert.equal(ronDirectionForSeats(0, 2, 3, 3), 'toimen');
    assert.equal(ronDirectionForSeats(0, 1, 3, 3), 'shimocha');
  });

  it('maps 4-player directions', () => {
    assert.equal(ronDirectionForSeats(0, 1, 4), 'shimocha');
    assert.equal(ronDirectionForSeats(0, 2, 4), 'toimen');
    assert.equal(ronDirectionForSeats(0, 3, 4), 'kamicha');
  });
});
