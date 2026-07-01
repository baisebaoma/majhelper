import { computeRiichiDefen } from './defen.js';
import { computeSanmaDefen } from './sanma-defen.js';
import {
  menfengForWinner,
  playerCountForMode,
  ronDirectionForSeats,
  sanmaMenfengToPhysical,
  seatWindLabel,
  formatHandLabel,
} from './session.js';

/** @typedef {{ fan: number, fu: number, label: string, yakuman?: boolean }} ScorePreset */

export const SCORE_PRESETS = [
  { label: '1番30符', fan: 1, fu: 30 },
  { label: '2番30符', fan: 2, fu: 30 },
  { label: '3番30符', fan: 3, fu: 30 },
  { label: '满贯', fan: 5, fu: 30 },
  { label: '跳满', fan: 6, fu: 30 },
  { label: '倍满', fan: 8, fu: 30 },
  { label: '三倍满', fan: 11, fu: 30 },
  { label: '役满', fan: 1, fu: 30, yakuman: true },
];

/** @type {readonly number[]} */
export const FU_STEPS = [20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110];

/** @type {readonly number[]} */
export const FU_HINTS = [20, 25, 30, 40, 50, 60];

export const MAX_FAN = 13;
export const MAX_YAKUMAN = 6;

/** @param {number} mult */
export function formatYakumanLabel(mult) {
  if (mult <= 1) return '役满';
  const labels = ['', '两', '三', '四', '五', '六'];
  if (mult >= 2 && mult <= 6) return `${labels[mult]}倍役满`;
  return `${mult}倍役满`;
}

/**
 * @param {object} params
 * @param {'riichi-4' | 'sanma-3'} params.gameMode
 * @param {number} params.winnerSeat physical seat 0..N-1
 * @param {number|null} params.payerSeat null = tsumo
 * @param {number} params.dealerIndex
 * @param {number} params.fan
 * @param {number} params.fu
 * @param {boolean} [params.yakuman]
 * @param {number} params.honba
 * @param {number} params.riichiSticks
 * @param {number} [params.absentSeat] sanma 北家缺席方位 0..3
 * @param {{ kiriageMangan?: boolean, kazoeYakuman?: boolean }} [params.rule]
 */
export function computeRiichiSettlement(params) {
  const playerCount = playerCountForMode(params.gameMode);
  const absentSeat = params.absentSeat ?? null;
  const menfeng = menfengForWinner(
    params.winnerSeat,
    params.dealerIndex,
    playerCount,
    params.gameMode === 'sanma-3' ? absentSeat : null,
  );
  const isTsumo = params.payerSeat == null;

  const breakdown = params.yakuman
    ? { fan: params.fan, yakuman: true, elements: [] }
    : { fan: params.fan, elements: [] };

  const baseInput = {
    breakdown,
    fu: params.fu,
    isTsumo,
    menfeng,
    changbang: params.honba ?? 0,
    lizhibang: params.riichiSticks ?? 0,
    rule: params.rule ?? {},
  };

  let result;
  if (!isTsumo) {
    const ronDirection = ronDirectionForSeats(
      params.winnerSeat,
      params.payerSeat,
      playerCount,
      params.gameMode === 'sanma-3' ? absentSeat : null,
    );
    baseInput.ronDirection = ronDirection;
  }

  if (params.gameMode === 'sanma-3') {
    result = computeSanmaDefen({ ...baseInput, menfeng: /** @type {0|1|2} */ (menfeng) });
  } else {
    result = computeRiichiDefen({ ...baseInput, menfeng: /** @type {0|1|2|3} */ (menfeng) });
  }

  /** @type {number[]} physical seat deltas (length 4 for sanma compass layout) */
  const physicalDeltas = params.gameMode === 'sanma-3'
    ? [0, 0, 0, 0]
    : Array(playerCount).fill(0);

  if (params.gameMode === 'sanma-3') {
    if (absentSeat == null) throw new Error('三麻算点需要 absentSeat');
    for (let rel = 0; rel < 3; rel++) {
      const physical = sanmaMenfengToPhysical(
        /** @type {0|1|2} */ (rel),
        params.dealerIndex,
        absentSeat,
      );
      physicalDeltas[physical] = result.fenpei[rel];
    }
  } else {
    for (let rel = 0; rel < playerCount; rel++) {
      const physical = (params.dealerIndex + rel) % playerCount;
      physicalDeltas[physical] = result.fenpei[rel];
    }
  }

  return {
    ...result,
    physicalDeltas,
    menfeng,
    seatWind: seatWindLabel(menfeng, playerCount),
    isTsumo,
  };
}

/**
 * @param {object} session
 * @param {number} winnerSeat
 * @param {number} dealerIndex
 * @param {string[]} seatNames
 */
export function buildWinSummary(session, winnerSeat, dealerIndex, seatNames, isTsumo, payerSeat) {
  const playerCount = playerCountForMode(session.gameMode);
  const menfeng = menfengForWinner(winnerSeat, dealerIndex, playerCount);
  const wind = seatWindLabel(menfeng, playerCount);
  const hand = formatHandLabel(session.roundWind, session.handNumber);
  const winnerName = seatNames[winnerSeat] ?? `座位${winnerSeat + 1}`;
  const winType = isTsumo ? `${wind}家自摸` : `${wind}家荣和`;
  let detail = `${hand}局 · ${winType} · 本场${session.honba} · 供托${session.riichiSticks}`;
  if (!isTsumo && payerSeat != null) {
    detail += ` · ${seatNames[payerSeat] ?? ''}放铳`;
  }
  return { detail, winnerName };
}

/**
 * @param {number} fan
 * @param {number} fu
 * @param {boolean} yakuman
 * @param {{ kiriageMangan?: boolean }} [rule]
 */
export function formatScoreTierLabel(fan, fu, yakuman, rule = {}) {
  if (yakuman) return formatYakumanLabel(fan);
  if (fan >= 13) return '累计役满';
  if (fan >= 11) return '三倍满';
  if (fan >= 8) return '倍满';
  if (fan >= 6) return '跳满';
  if (fan >= 5) return '满贯';
  if (fan <= 0) return '—';
  const raw = fu * (1 << (2 + fan));
  if (rule.kiriageMangan && raw === 1920) return '切上满贯';
  return `${fan}番${fu}符`;
}

/** @param {ScorePreset} preset @param {{ fan: number, fu: number, yakuman: boolean }} current */
export function isScorePresetActive(preset, current) {
  return (
    !!preset.yakuman === !!current.yakuman
    && preset.fan === current.fan
    && (preset.yakuman || preset.fu === current.fu)
  );
}

export { formatHandLabel, seatWindLabel, menfengForWinner };
