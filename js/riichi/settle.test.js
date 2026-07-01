import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeRiichiSettlement } from './settle.js';
import {
  advanceAfterWin,
  advanceAfterRyukyoku,
  notenPenaltyDeltas,
  playerCountForMode,
} from './session.js';

const RULE = { kazoeYakuman: true, kiriageMangan: false };
const SANMA_ABSENT = 3;

/** @param {number[]} deltas */
function assertZeroSum(deltas, label) {
  assert.equal(
    deltas.reduce((a, b) => a + b, 0),
    0,
    `${label}: fenpei must sum to zero, got ${JSON.stringify(deltas)}`,
  );
}

/** @param {number} absentSeat */
function sanmaOccupiedSeats(absentSeat = SANMA_ABSENT) {
  return [0, 1, 2, 3].filter((i) => i !== absentSeat);
}

/**
 * Mirrors confirmRiichiSettle score apply + applyRoundAdvance field updates.
 * @param {object} session
 * @param {object} win
 */
function simulateWin(session, win) {
  const pc = playerCountForMode(session.gameMode);
  const loopCount = session.gameMode === 'sanma-3' ? 4 : pc;
  const absentSeat = session.gameMode === 'sanma-3'
    ? (session.absentSeat ?? SANMA_ABSENT)
    : null;
  const result = computeRiichiSettlement({
    gameMode: session.gameMode,
    winnerSeat: win.winnerSeat,
    payerSeat: win.payerSeat ?? null,
    dealerIndex: session.dealerIndex,
    fan: win.fan ?? 1,
    fu: win.fu ?? 30,
    yakuman: win.yakuman ?? false,
    honba: session.honba,
    riichiSticks: session.riichiSticks,
    rule: RULE,
    absentSeat,
  });

  const scores = session.scores.slice(0, loopCount);
  while (scores.length < loopCount) scores.push(0);
  for (let i = 0; i < loopCount; i++) {
    scores[i] += result.physicalDeltas[i] ?? 0;
  }

  const advance = advanceAfterWin({
    gameMode: session.gameMode,
    winnerSeat: win.winnerSeat,
    dealerIndex: session.dealerIndex,
    honba: session.honba,
    roundWind: session.roundWind,
    handNumber: session.handNumber,
    renchanMode: session.renchanMode ?? 2,
    absentSeat,
  });

  return {
    result,
    scores,
    advance,
    session: {
      ...session,
      scores,
      dealerIndex: advance.dealerIndex,
      honba: advance.honba,
      roundWind: advance.roundWind,
      handNumber: advance.handNumber,
      riichiSticks: 0,
    },
  };
}

/** @param {object} session @param {boolean[]} notenBySeat */
function simulateRyukyoku(session, notenBySeat) {
  const pc = playerCountForMode(session.gameMode);
  const loopCount = session.gameMode === 'sanma-3' ? 4 : pc;
  const absentSeat = session.gameMode === 'sanma-3'
    ? (session.absentSeat ?? SANMA_ABSENT)
    : null;
  const noten = notenBySeat.slice(0, loopCount);
  while (noten.length < loopCount) noten.push(false);
  const deltas = notenPenaltyDeltas(pc, session.dealerIndex, noten, absentSeat);
  const scores = session.scores.slice(0, loopCount);
  while (scores.length < loopCount) scores.push(0);
  for (let i = 0; i < loopCount; i++) scores[i] += deltas[i] ?? 0;

  const dealerTenpai = !noten[session.dealerIndex];
  const advance = advanceAfterRyukyoku({
    gameMode: session.gameMode,
    dealerIndex: session.dealerIndex,
    honba: session.honba,
    roundWind: session.roundWind,
    handNumber: session.handNumber,
    dealerTenpai,
    renchanMode: session.renchanMode ?? 2,
    absentSeat,
  });

  return { deltas, scores, advance, dealerTenpai };
}

describe('computeRiichiSettlement — 4p ron matrix', () => {
  for (let dealerIndex = 0; dealerIndex < 4; dealerIndex++) {
    for (let winnerSeat = 0; winnerSeat < 4; winnerSeat++) {
      for (let payerSeat = 0; payerSeat < 4; payerSeat++) {
        if (payerSeat === winnerSeat) continue;

        it(`dealer=${dealerIndex} winner=${winnerSeat} payer=${payerSeat}`, () => {
          const r = computeRiichiSettlement({
            gameMode: 'riichi-4',
            winnerSeat,
            payerSeat,
            dealerIndex,
            fan: 1,
            fu: 30,
            honba: 0,
            riichiSticks: 0,
            rule: RULE,
          });

          assert.ok(r.defen > 0);
          assertZeroSum(r.physicalDeltas, 'physicalDeltas');
          assert.ok(r.physicalDeltas[winnerSeat] > 0, 'winner gains');
          assert.ok(r.physicalDeltas[payerSeat] < 0, 'payer loses');
        });
      }
    }
  }
});

describe('computeRiichiSettlement — 4p tsumo matrix', () => {
  for (let dealerIndex = 0; dealerIndex < 4; dealerIndex++) {
    for (let winnerSeat = 0; winnerSeat < 4; winnerSeat++) {
      it(`dealer=${dealerIndex} tsumo winner=${winnerSeat}`, () => {
        const r = computeRiichiSettlement({
          gameMode: 'riichi-4',
          winnerSeat,
          payerSeat: null,
          dealerIndex,
          fan: 1,
          fu: 30,
          honba: 0,
          riichiSticks: 0,
          rule: RULE,
        });

        assert.ok(r.defen > 0);
        assertZeroSum(r.physicalDeltas, 'physicalDeltas');
        assert.ok(r.physicalDeltas[winnerSeat] > 0, 'winner gains');
        assert.ok(r.physicalDeltas.some((d, i) => i !== winnerSeat && d < 0), 'others pay');
      });
    }
  }
});

describe('computeRiichiSettlement — 3p matrix', () => {
  const occupied = sanmaOccupiedSeats(SANMA_ABSENT);
  for (const dealerIndex of occupied) {
    for (const winnerSeat of occupied) {
      it(`sanma tsumo absent=${SANMA_ABSENT} dealer=${dealerIndex} winner=${winnerSeat}`, () => {
        const r = computeRiichiSettlement({
          gameMode: 'sanma-3',
          winnerSeat,
          payerSeat: null,
          dealerIndex,
          fan: 1,
          fu: 30,
          honba: 0,
          riichiSticks: 0,
          rule: RULE,
          absentSeat: SANMA_ABSENT,
        });

        assert.ok(r.defen > 0);
        assertZeroSum(r.physicalDeltas, 'physicalDeltas');
        assert.ok(r.physicalDeltas[winnerSeat] > 0);
        assert.equal(r.physicalDeltas[SANMA_ABSENT], 0);
      });

      for (const payerSeat of occupied) {
        if (payerSeat === winnerSeat) continue;

        it(`sanma ron absent=${SANMA_ABSENT} dealer=${dealerIndex} winner=${winnerSeat} payer=${payerSeat}`, () => {
          const r = computeRiichiSettlement({
            gameMode: 'sanma-3',
            winnerSeat,
            payerSeat,
            dealerIndex,
            fan: 1,
            fu: 30,
            honba: 0,
            riichiSticks: 0,
            rule: RULE,
            absentSeat: SANMA_ABSENT,
          });

          assert.ok(r.defen > 0);
          assertZeroSum(r.physicalDeltas, 'physicalDeltas');
          assert.ok(r.physicalDeltas[winnerSeat] > 0, 'winner gains');
          assert.ok(r.physicalDeltas[payerSeat] < 0, 'payer loses');
          assert.equal(r.physicalDeltas[SANMA_ABSENT], 0);
        });
      }
    }
  }
});

describe('computeRiichiSettlement — regressions', () => {
  it('4p dealer ron toimen with honba + riichi sticks', () => {
    const r = computeRiichiSettlement({
      gameMode: 'riichi-4',
      winnerSeat: 0,
      payerSeat: 2,
      dealerIndex: 0,
      fan: 1,
      fu: 30,
      honba: 2,
      riichiSticks: 1,
      rule: RULE,
    });
    assert.equal(r.physicalDeltas[0], 3100);
    assert.equal(r.physicalDeltas[2], -2100);
    // 供托归赢家，不与其他家对冲（立直时已扣过）
    assert.equal(r.physicalDeltas.reduce((a, b) => a + b, 0), 1000);
  });

  it('4p non-zero dealer index: dealer seat 2 ron from toimen seat 0', () => {
    const r = computeRiichiSettlement({
      gameMode: 'riichi-4',
      winnerSeat: 2,
      payerSeat: 0,
      dealerIndex: 2,
      fan: 1,
      fu: 30,
      honba: 0,
      riichiSticks: 0,
      rule: RULE,
    });
    assert.equal(r.physicalDeltas[2], 1500);
    assert.equal(r.physicalDeltas[0], -1500);
    assertZeroSum(r.physicalDeltas, 'physicalDeltas');
  });

  it('3p dealer ron toimen (对家) — must not zero out', () => {
    const r = computeRiichiSettlement({
      gameMode: 'sanma-3',
      winnerSeat: 0,
      payerSeat: 2,
      dealerIndex: 0,
      fan: 1,
      fu: 30,
      honba: 1,
      riichiSticks: 0,
      rule: RULE,
      absentSeat: SANMA_ABSENT,
    });
    assert.equal(r.physicalDeltas[0], 1800);
    assert.equal(r.physicalDeltas[2], -1800);
    assertZeroSum(r.physicalDeltas, 'physicalDeltas');
  });

  it('3p absent top: dealer ron toimen still scores', () => {
    const absentSeat = 2;
    const r = computeRiichiSettlement({
      gameMode: 'sanma-3',
      winnerSeat: 0,
      payerSeat: 3,
      dealerIndex: 0,
      fan: 1,
      fu: 30,
      honba: 0,
      riichiSticks: 0,
      rule: RULE,
      absentSeat,
    });
    assert.equal(r.physicalDeltas[0], 1500);
    assert.equal(r.physicalDeltas[3], -1500);
    assert.equal(r.physicalDeltas[absentSeat], 0);
    assertZeroSum(r.physicalDeltas, 'physicalDeltas');
  });
});

describe('simulateWin — score + honba + dealer rotation', () => {
  const base = {
    gameMode: 'riichi-4',
    dealerIndex: 0,
    honba: 0,
    roundWind: 0,
    handNumber: 1,
    riichiSticks: 0,
    renchanMode: 2,
    scores: [25000, 25000, 25000, 25000],
  };

  it('dealer ron toimen: scores change and honba+1', () => {
    const { scores, advance, result } = simulateWin(base, {
      winnerSeat: 0,
      payerSeat: 2,
    });
    assert.equal(result.physicalDeltas[0], 1500);
    assert.equal(scores[0], 26500);
    assert.equal(scores[2], 23500);
    assert.equal(advance.dealerIndex, 0);
    assert.equal(advance.honba, 1);
    assert.equal(advance.handNumber, 1);
  });

  it('child ron: dealer rotates and honba resets', () => {
    const { scores, advance } = simulateWin(
      { ...base, honba: 3 },
      { winnerSeat: 1, payerSeat: 0 },
    );
    // 1000 和了 + 本场 900
    assert.equal(scores[1], 26900);
    assert.equal(scores[0], 23100);
    assert.equal(advance.dealerIndex, 1);
    assert.equal(advance.honba, 0);
    assert.equal(advance.handNumber, 2);
  });

  it('dealer tsumo: all opponents pay, honba+1', () => {
    const { scores, advance } = simulateWin(base, { winnerSeat: 0, payerSeat: null });
    assert.equal(scores[0], 26500);
    assert.equal(scores[1], 24500);
    assert.equal(scores[2], 24500);
    assert.equal(scores[3], 24500);
    assert.equal(advance.dealerIndex, 0);
    assert.equal(advance.honba, 1);
  });

  it('east 4 -> south 1 on child win', () => {
    const { advance } = simulateWin(
      { ...base, handNumber: 4, roundWind: 0 },
      { winnerSeat: 3, payerSeat: 2 },
    );
    assert.equal(advance.dealerIndex, 1);
    assert.equal(advance.handNumber, 1);
    assert.equal(advance.roundWind, 1);
    assert.equal(advance.honba, 0);
  });

  it('sanma dealer toimen ron updates scores', () => {
    const sanma = {
      gameMode: 'sanma-3',
      absentSeat: SANMA_ABSENT,
      dealerIndex: 0,
      honba: 0,
      roundWind: 0,
      handNumber: 1,
      riichiSticks: 0,
      renchanMode: 2,
      scores: [35000, 35000, 35000, 0],
    };
    const { scores, advance } = simulateWin(sanma, { winnerSeat: 0, payerSeat: 2 });
    assert.equal(scores[0], 36500);
    assert.equal(scores[2], 33500);
    assert.equal(advance.honba, 1);
  });
});

describe('simulateRyukyoku — noten penalty + honba', () => {
  const base = {
    gameMode: 'riichi-4',
    dealerIndex: 0,
    honba: 0,
    roundWind: 0,
    handNumber: 1,
    renchanMode: 2,
    scores: [25000, 25000, 25000, 25000],
  };

  it('all tenpai: no score change, dealer tenpai honba+1', () => {
    const { deltas, scores, advance } = simulateRyukyoku(base, [false, false, false, false]);
    assert.deepEqual(deltas, [0, 0, 0, 0]);
    assert.deepEqual(scores, base.scores);
    assert.equal(advance.dealerIndex, 0);
    assert.equal(advance.honba, 1);
    assert.equal(advance.handNumber, 1);
  });

  it('one noten: penalty applied, zero sum', () => {
    const noten = [false, true, false, false];
    const { deltas, scores } = simulateRyukyoku(base, noten);
    assertZeroSum(deltas, 'noten');
    assert.equal(deltas[1], -3000);
    assert.equal(scores[0], 26000);
    assert.equal(scores[1], 22000);
  });

  it('dealer tenpai on ryukyoku: honba+1, same dealer', () => {
    const { advance } = simulateRyukyoku(base, [false, false, false, false]);
    assert.equal(advance.dealerIndex, 0);
    assert.equal(advance.honba, 1);
    assert.equal(advance.handNumber, 1);
  });

  it('dealer noten on ryukyoku: rotate, honba=0', () => {
    const { advance } = simulateRyukyoku(base, [true, false, false, false]);
    assert.equal(advance.dealerIndex, 1);
    assert.equal(advance.honba, 0);
    assert.equal(advance.handNumber, 2);
  });

  it('sanma child noten penalty (ceil rounding)', () => {
    const sanma = {
      ...base,
      gameMode: 'sanma-3',
      absentSeat: SANMA_ABSENT,
      scores: [35000, 35000, 35000, 0],
    };
    const noten = [false, true, false, false];
    const { deltas, scores } = simulateRyukyoku(sanma, noten);
    assert.deepEqual(deltas, [800, -1500, 800, 0]);
    assert.equal(scores[0], 35800);
    assert.equal(scores[1], 33500);
    assert.equal(scores[2], 35800);
  });
});

describe('notenPenaltyDeltas', () => {
  it('4p two noten: 1500 each', () => {
    const d = notenPenaltyDeltas(4, 0, [true, false, true, false]);
    assertZeroSum(d, '4p two noten');
    assert.equal(d[0], -1500);
    assert.equal(d[2], -1500);
    assert.equal(d[1], 1500);
    assert.equal(d[3], 1500);
  });

  it('3p dealer noten pays 3000', () => {
    const d = notenPenaltyDeltas(3, 0, [true, false, false, false], SANMA_ABSENT);
    assertZeroSum(d, '3p dealer noten');
    assert.equal(d[0], -3000);
    assert.equal(d[1], 1500);
    assert.equal(d[2], 1500);
    assert.equal(d[3], 0);
  });
});
