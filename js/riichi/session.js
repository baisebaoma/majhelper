/** @typedef {'generic' | 'riichi-4' | 'sanma-3'} GameMode */

const ROUND_WIND_LABELS = ['东', '南', '西', '北'];
const SEAT_WINDS_4 = ['东', '南', '西', '北'];
const SEAT_WINDS_3 = ['东', '南', '西'];

export const RIICHI_DEPOSIT = 1000;

/** @param {GameMode} gameMode */
export function isRiichiMode(gameMode) {
  return gameMode === 'riichi-4' || gameMode === 'sanma-3';
}

/** @param {GameMode} gameMode */
export function playerCountForMode(gameMode) {
  return gameMode === 'sanma-3' ? 3 : 4;
}

export function formatHandLabel(roundWind, handNumber) {
  const wind = ROUND_WIND_LABELS[roundWind] ?? '东';
  return `${wind}${handNumber}`;
}

export function menfengForSeat(seatIndex, dealerIndex, playerCount) {
  return (seatIndex - dealerIndex + playerCount) % playerCount;
}

/**
 * When exactly 3 of 4 compass seats are filled, returns the empty (北家缺席) slot 0..3.
 * @param {(string|null)[]} seats length 4
 * @returns {number|null}
 */
export function sanmaAbsentSeat(seats) {
  if (!seats || seats.length < 4) return null;
  const empty = [];
  for (let i = 0; i < 4; i++) {
    if (!seats[i]) empty.push(i);
  }
  if (empty.length === 1 && seats.filter(Boolean).length === 3) return empty[0];
  return null;
}

/** @param {number} physicalSeat @param {number} dealerIndex @param {number} absentSeat */
export function sanmaPhysicalToMenfeng(physicalSeat, dealerIndex, absentSeat) {
  let rel = 0;
  for (let step = 0; step < 4; step++) {
    const pos = (dealerIndex + step) % 4;
    if (pos === absentSeat) continue;
    if (pos === physicalSeat) return /** @type {0|1|2} */ (rel);
    rel++;
  }
  throw new Error(`座位 ${physicalSeat} 不在三麻局中`);
}

/** @param {0|1|2} rel @param {number} dealerIndex @param {number} absentSeat */
export function sanmaMenfengToPhysical(rel, dealerIndex, absentSeat) {
  let relCount = 0;
  for (let step = 0; step < 4; step++) {
    const pos = (dealerIndex + step) % 4;
    if (pos === absentSeat) continue;
    if (relCount === rel) return pos;
    relCount++;
  }
  throw new Error(`无效门风 ${rel}`);
}

/** Clockwise steps between winner and payer, skipping absent seat. */
export function sanmaRonDirection(winnerSeat, payerSeat, absentSeat) {
  let steps = 0;
  let pos = winnerSeat;
  while (pos !== payerSeat) {
    pos = (pos + 1) % 4;
    if (pos === absentSeat) continue;
    steps++;
    if (steps > 2) throw new Error(`无效三麻荣和: ${winnerSeat} <- ${payerSeat}`);
  }
  if (steps === 1) return 'shimocha';
  if (steps === 2) return 'toimen';
  throw new Error(`无效三麻荣和步数: ${steps}`);
}

/** Next dealer seat clockwise among occupied positions. */
export function sanmaNextDealer(dealerIndex, absentSeat) {
  let pos = dealerIndex;
  for (let i = 0; i < 3; i++) {
    pos = (pos + 1) % 4;
    if (pos === absentSeat) continue;
    return pos;
  }
  return (dealerIndex + 1) % 4;
}

/** @deprecated use sanmaAbsentSeat */
export function sanmaGhostCompass(initialDealerIndex) {
  if (initialDealerIndex === 0) return 3;
  if (initialDealerIndex === 2) return 2;
  return 1;
}

/** @deprecated seats use physical compass indices directly */
export function sanmaDisplayPosForSeat(seatIndex, initialDealerIndex) {
  const ghost = sanmaGhostCompass(initialDealerIndex);
  const slots = [0, 1, 2, 3].filter((p) => p !== ghost);
  return slots[seatIndex] ?? seatIndex;
}

export function seatWindForSeat(seatIndex, dealerIndex, playerCount, absentSeat = null) {
  const menfeng = playerCount === 3 && absentSeat != null
    ? sanmaPhysicalToMenfeng(seatIndex, dealerIndex, absentSeat)
    : menfengForSeat(seatIndex, dealerIndex, playerCount);
  const winds = playerCount === 3 ? SEAT_WINDS_3 : SEAT_WINDS_4;
  return winds[menfeng] ?? '?';
}

export function menfengForWinner(winnerSeat, dealerIndex, playerCount, absentSeat = null) {
  if (playerCount === 3 && absentSeat != null) {
    return sanmaPhysicalToMenfeng(winnerSeat, dealerIndex, absentSeat);
  }
  return menfengForSeat(winnerSeat, dealerIndex, playerCount);
}

export function ronDirectionForSeats(winnerSeat, payerSeat, playerCount, absentSeat = null) {
  if (playerCount === 3 && absentSeat != null) {
    return sanmaRonDirection(winnerSeat, payerSeat, absentSeat);
  }
  const offset = (payerSeat - winnerSeat + playerCount) % playerCount;
  if (offset === 1) return 'shimocha';
  if (offset === 2) return 'toimen';
  if (playerCount === 4 && offset === 3) return 'kamicha';
  throw new Error(`无效的放铳座位偏移: ${offset}`);
}

/** @deprecated use seatWindForSeat */
export function seatWindLabel(menfeng, playerCount) {
  const winds = playerCount === 3 ? SEAT_WINDS_3 : SEAT_WINDS_4;
  return winds[menfeng] ?? '?';
}

/**
 * OMC Match.shouldRiichiDealerContinue (renchanMode default 2).
 * @param {{ renchanMode?: number, dealerWon: boolean, exhaustiveDraw: boolean, dealerTenpai: boolean }} input
 */
export function shouldDealerContinue(input) {
  const mode = input.renchanMode ?? 2;
  if (mode === 0) return false;
  if (mode === 1) return input.dealerWon;
  if (mode === 2) {
    return input.dealerWon || (input.exhaustiveDraw && input.dealerTenpai);
  }
  return input.dealerWon || input.exhaustiveDraw;
}

/**
 * After a win — mirrors OMC Match.settleCurrentRound riichi branch.
 * @param {object} input
 */
export function advanceAfterWin(input) {
  const pc = playerCountForMode(input.gameMode);
  const absentSeat = input.absentSeat ?? null;
  const renchanMode = input.renchanMode ?? 2;
  const dealerWon = input.gameMode === 'sanma-3' && absentSeat != null
    ? sanmaPhysicalToMenfeng(input.winnerSeat, input.dealerIndex, absentSeat) === 0
    : menfengForSeat(input.winnerSeat, input.dealerIndex, pc) === 0;
  const dealerContinues = shouldDealerContinue({
    renchanMode,
    dealerWon,
    exhaustiveDraw: false,
    dealerTenpai: false,
  });

  if (dealerContinues) {
    return {
      dealerIndex: input.dealerIndex,
      dealerStreakDelta: 1,
      honba: input.honba + 1,
      roundWind: input.roundWind,
      handNumber: input.handNumber,
      reason: dealerWon ? '庄家和了，连庄' : '连庄',
    };
  }

  const nextDealer = input.gameMode === 'sanma-3' && absentSeat != null
    ? sanmaNextDealer(input.dealerIndex, absentSeat)
    : (input.dealerIndex + 1) % pc;
  let handNumber = input.handNumber + 1;
  let roundWind = input.roundWind;
  if (handNumber > 4) {
    handNumber = 1;
    roundWind = (roundWind + 1) % 4;
  }

  return {
    dealerIndex: nextDealer,
    dealerStreakDelta: 0,
    honba: 0,
    roundWind,
    handNumber,
    reason: '子家和了，换庄',
  };
}

/**
 * After exhaustive draw (流局).
 * @param {object} input
 */
export function advanceAfterRyukyoku(input) {
  const pc = playerCountForMode(input.gameMode);
  const absentSeat = input.absentSeat ?? null;
  const renchanMode = input.renchanMode ?? 2;
  const dealerTenpai = input.dealerTenpai ?? false;
  const dealerContinues = shouldDealerContinue({
    renchanMode,
    dealerWon: false,
    exhaustiveDraw: true,
    dealerTenpai,
  });

  if (dealerContinues) {
    return {
      dealerIndex: input.dealerIndex,
      dealerStreakDelta: 0,
      honba: input.honba + 1,
      roundWind: input.roundWind,
      handNumber: input.handNumber,
      reason: dealerTenpai ? '流局，庄家听牌连庄' : '流局，连庄',
    };
  }

  const nextDealer = input.gameMode === 'sanma-3' && absentSeat != null
    ? sanmaNextDealer(input.dealerIndex, absentSeat)
    : (input.dealerIndex + 1) % pc;
  let handNumber = input.handNumber + 1;
  let roundWind = input.roundWind;
  if (handNumber > 4) {
    handNumber = 1;
    roundWind = (roundWind + 1) % 4;
  }

  return {
    dealerIndex: nextDealer,
    dealerStreakDelta: 0,
    honba: 0,
    roundWind,
    handNumber,
    reason: '流局，换庄',
  };
}

/** @deprecated use advanceAfterWin */
export function advanceAfterRiichiWin(session, winnerSeat, dealerIndex) {
  return advanceAfterWin({
    gameMode: session.gameMode,
    winnerSeat,
    dealerIndex,
    honba: session.honba,
    roundWind: session.roundWind,
    handNumber: session.handNumber,
    renchanMode: session.renchanMode,
    absentSeat: session.absentSeat ?? null,
  });
}

/**
 * @param {number} playerCount 3 or 4
 * @param {number} dealerIndex physical compass seat of dealer
 * @param {boolean[]} notenBySeat indexed by compass 0..3 (sanma) or 0..3 (4p)
 * @param {number|null} [absentSeat] sanma north absent slot
 */
export function notenPenaltyDeltas(playerCount, dealerIndex, notenBySeat, absentSeat = null) {
  const size = playerCount === 3 ? 4 : playerCount;
  const deltas = Array(size).fill(0);
  const notenSeats = [];
  const tenpaiSeats = [];
  for (let i = 0; i < size; i++) {
    if (playerCount === 3 && i === absentSeat) continue;
    if (notenBySeat[i]) notenSeats.push(i);
    else tenpaiSeats.push(i);
  }
  if (notenSeats.length === 0 || tenpaiSeats.length === 0) return deltas;

  if (playerCount === 4) {
    const eachPay = notenSeats.length === 1 ? 3000 : 1500;
    const eachGain = Math.floor((notenSeats.length * eachPay) / tenpaiSeats.length);
    for (const s of notenSeats) deltas[s] -= eachPay;
    for (const s of tenpaiSeats) deltas[s] += eachGain;
    return deltas;
  }

  for (const s of notenSeats) {
    const menfeng = sanmaPhysicalToMenfeng(s, dealerIndex, /** @type {number} */ (absentSeat));
    const pay = menfeng === 0 ? 3000 : 1500;
    deltas[s] -= pay;
    const gainEach = Math.ceil(pay / tenpaiSeats.length / 100) * 100;
    for (const o of tenpaiSeats) deltas[o] += gainEach;
  }
  return deltas;
}
