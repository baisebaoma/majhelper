/**
 * Riichi defen calculator — ported from OMC packages/core/src/mahjong/defen.ts
 * Source: @kobalab/majiang-core MIT © Satoshi Kobayashi
 */

/** @typedef {'shimocha' | 'toimen' | 'kamicha'} RonDirection */

const RON_DIR_TO_OFFSET = {
  shimocha: 1,
  toimen: 2,
  kamicha: 3,
};

/**
 * @param {number} fu
 * @param {number} fanshu
 * @param {{ kazoeYakuman?: boolean, kiriageMangan?: boolean }} rule
 */
function pickMangaBase(fu, fanshu, rule) {
  if (fanshu >= 13 && rule.kazoeYakuman !== false) return 8000;
  if (fanshu >= 11) return 6000;
  if (fanshu >= 8) return 4000;
  if (fanshu >= 6) return 3000;
  const raw = fu * (1 << (2 + fanshu));
  if (rule.kiriageMangan && raw === 1920) return 2000;
  return Math.min(raw, 2000);
}

/**
 * @param {object} input
 * @param {{ fan: number, yakuman?: boolean, elements?: object[] }} input.breakdown
 * @param {number} input.fu
 * @param {boolean} input.isTsumo
 * @param {0|1|2|3} input.menfeng
 * @param {RonDirection} [input.ronDirection]
 * @param {number} input.changbang
 * @param {number} input.lizhibang
 * @param {number} [input.honbaPoints]
 * @param {number} [input.riichiStickPoints]
 * @param {{ kazoeYakuman?: boolean, kiriageMangan?: boolean }} [input.rule]
 */
export function computeRiichiDefen(input) {
  const { breakdown, isTsumo, menfeng, changbang, lizhibang } = input;
  const rule = input.rule ?? {};
  const fenpei = [0, 0, 0, 0];
  const hb = Math.max(0, input.honbaPoints ?? 300);
  const rk = Math.max(0, input.riichiStickPoints ?? 1000);
  const honbaChild = Math.ceil((hb / 3) / 100) * 100;

  if (breakdown.fan === 0 && !breakdown.yakuman) {
    return { defen: 0, fenpei };
  }

  let fu = input.fu;
  let fanshu;
  let damanguan;
  let base;
  let base2;
  let baojia;
  let baojia2;

  if (breakdown.yakuman) {
    fu = undefined;
    damanguan = breakdown.fan;
    base = 8000 * damanguan;
    const bao = (breakdown.elements ?? []).find((e) => e.baojia);
    if (bao?.baojia) {
      const offset = RON_DIR_TO_OFFSET[bao.baojia];
      baojia2 = (menfeng + offset) % 4;
      const baoLevel = bao.yakumanLevel ?? 1;
      base2 = 8000 * Math.min(baoLevel, damanguan);
    }
  } else {
    fanshu = breakdown.fan;
    base = pickMangaBase(fu ?? 30, fanshu, rule);
  }

  let defen2 = 0;
  if (baojia2 !== undefined && base2 !== undefined) {
    if (!isTsumo) base2 = base2 / 2;
    base = base - base2;
    defen2 = base2 * (menfeng === 0 ? 6 : 4);
    fenpei[menfeng] += defen2;
    fenpei[baojia2] -= defen2;
  }

  let defen;
  if (!isTsumo || base === 0) {
    if (base === 0) {
      baojia = baojia2;
    } else {
      const dir = input.ronDirection;
      if (!dir) throw new Error('ronDirection is required for ron payout');
      baojia = (menfeng + RON_DIR_TO_OFFSET[dir]) % 4;
    }
    defen = Math.ceil((base * (menfeng === 0 ? 6 : 4)) / 100) * 100;
    fenpei[menfeng] += defen + changbang * hb + lizhibang * rk;
    fenpei[baojia] -= defen + changbang * hb;
  } else {
    const zhuangjia = Math.ceil((base * 2) / 100) * 100;
    const sanjia = Math.ceil(base / 100) * 100;
    if (menfeng === 0) {
      defen = zhuangjia * 3;
      for (let l = 0; l < 4; l++) {
        if (l === menfeng) {
          fenpei[l] += defen + changbang * hb + lizhibang * rk;
        } else {
          fenpei[l] -= zhuangjia + changbang * honbaChild;
        }
      }
    } else {
      defen = zhuangjia + sanjia * 2;
      for (let l = 0; l < 4; l++) {
        if (l === menfeng) {
          fenpei[l] += defen + changbang * hb + lizhibang * rk;
        } else if (l === 0) {
          fenpei[l] -= zhuangjia + changbang * honbaChild;
        } else {
          fenpei[l] -= sanjia + changbang * honbaChild;
        }
      }
    }
  }

  return {
    defen: defen + defen2,
    fenpei,
    base: breakdown.yakuman ? undefined : base,
    fanshu,
    damanguan,
    fu,
  };
}
