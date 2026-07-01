/** @typedef {'generic' | 'riichi-4' | 'sanma-3'} GameMode */

const STORAGE_KEY_V4 = 'mj_data_v4';
const STORAGE_KEY_V3 = 'mj_data_v3';

export function startingScoreForMode(gameMode) {
  if (gameMode === 'sanma-3') return 35000;
  if (gameMode === 'riichi-4') return 25000;
  return 0;
}

/** @returns {import('./riichi/session.js').RiichiSessionDefaults} */
export function defaultRiichiSession(gameMode = 'riichi-4') {
  return {
    gameMode,
    roundWind: 0,
    handNumber: 1,
    honba: 0,
    riichiSticks: 0,
    startingScore: startingScoreForMode(gameMode),
    rule: { kiriageMangan: false, kazoeYakuman: true, renchanMode: 2 },
    initialDealerIndex: 0,
    playerRiichi: [false, false, false, false],
  };
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function migrateV3ToV4(raw) {
  return {
    ...raw,
    gameMode: raw.gameMode ?? 'generic',
    roundWind: raw.roundWind ?? 0,
    handNumber: raw.handNumber ?? 1,
    honba: raw.honba ?? 0,
    riichiSticks: raw.riichiSticks ?? 0,
    startingScore: raw.startingScore ?? 25000,
    rule: raw.rule ?? { kiriageMangan: false, kazoeYakuman: true, renchanMode: 2 },
    initialDealerIndex: raw.initialDealerIndex ?? raw.dealerIndex ?? 0,
    playerRiichi: raw.playerRiichi ?? [false, false, false, false],
  };
}

/**
 * @param {object} state
 */
export function saveGameState(state) {
  localStorage.setItem(STORAGE_KEY_V4, JSON.stringify(state));
}

/**
 * @returns {object | null}
 */
export function loadGameState() {
  const v4 = localStorage.getItem(STORAGE_KEY_V4);
  if (v4) {
    return migrateV3ToV4(JSON.parse(v4));
  }
  const v3 = localStorage.getItem(STORAGE_KEY_V3);
  if (v3) {
    const migrated = migrateV3ToV4(JSON.parse(v3));
    saveGameState(migrated);
    return migrated;
  }
  return null;
}

export function clearGameStorage() {
  localStorage.removeItem(STORAGE_KEY_V4);
  localStorage.removeItem(STORAGE_KEY_V3);
}

export { STORAGE_KEY_V4, STORAGE_KEY_V3 };
