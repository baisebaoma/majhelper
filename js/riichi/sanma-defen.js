/**
 * Three-player riichi defen — ported from OMC packages/core/src/mahjong/sanma-defen.ts
 */

const RON_DIR_TO_OFFSET = {
  shimocha: 1,
  toimen: 2,
  kamicha: 3,
};

function pickMangaBase(fu, fanshu, rule) {
  if (fanshu >= 13 && rule.kazoeYakuman !== false) return 8000;
  if (fanshu >= 11) return 6000;
  if (fanshu >= 8) return 4000;
  if (fanshu >= 6) return 3000;
  const raw = fu * (1 << (2 + fanshu));
  if (rule.kiriageMangan && raw === 1920) return 2000;
  return Math.min(raw, 2000);
}

function round100(n) {
  return Math.ceil(n / 100) * 100;
}

/**
 * @param {object} input
 */
export function computeSanmaDefen(input) {
  const { breakdown, isTsumo, menfeng, changbang, lizhibang } = input;
  const rule = input.rule ?? {};
  const fenpei = [0, 0, 0];
  const hb = Math.max(0, input.honbaPoints ?? 300);
  const rk = Math.max(0, input.riichiStickPoints ?? 1000);
  const tsumoWinnerHonba = Math.ceil(((2 * hb) / 3) / 100) * 100;
  const tsumoLoserHonba = Math.ceil((hb / 3) / 100) * 100;

  if (breakdown.fan === 0 && !breakdown.yakuman) {
    return { defen: 0, fenpei };
  }

  let fu = input.fu;
  let fanshu;
  let damanguan;
  let base;
  let base2;
  let baojia2;

  if (breakdown.yakuman) {
    fu = undefined;
    damanguan = breakdown.fan;
    base = 8000 * damanguan;
    const bao = (breakdown.elements ?? []).find((e) => e.baojia);
    if (bao?.baojia) {
      const offset = RON_DIR_TO_OFFSET[bao.baojia];
      baojia2 = (menfeng + offset) % 3;
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
    defen2 = round100(base2 * (menfeng === 0 ? 6 : 4));
    fenpei[menfeng] += defen2;
    fenpei[baojia2] -= defen2;
  }

  let defen;
  if (!isTsumo) {
    const dir = input.ronDirection;
    if (!dir) throw new Error('ronDirection is required for sanma ron payout');
    const payer = base === 0 && baojia2 !== undefined
      ? baojia2
      : (menfeng + RON_DIR_TO_OFFSET[dir]) % 3;
    defen = round100(base * (menfeng === 0 ? 6 : 4));
    fenpei[menfeng] += defen + changbang * hb + lizhibang * rk;
    fenpei[payer] -= defen + changbang * hb;
  } else if (menfeng === 0) {
    const each = round100(base * 2);
    defen = each * 2;
    for (let seat = 0; seat < 3; seat++) {
      if (seat === menfeng) {
        fenpei[seat] += defen + changbang * tsumoWinnerHonba + lizhibang * rk;
      } else {
        fenpei[seat] -= each + changbang * tsumoLoserHonba;
      }
    }
  } else {
    const dealerPays = round100(base * 2);
    const childPays = round100(base);
    const otherChild = [1, 2].find((seat) => seat !== menfeng);
    defen = dealerPays + childPays;
    fenpei[menfeng] += defen + changbang * tsumoWinnerHonba + lizhibang * rk;
    fenpei[0] -= dealerPays + changbang * tsumoLoserHonba;
    fenpei[otherChild] -= childPays + changbang * tsumoLoserHonba;
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
