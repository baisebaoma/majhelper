/** @typedef {{
 *   halfW: number,
 *   halfH: number,
 *   baseH: number,
 *   baseW: number,
 *   dialBaseR: number,
 *   riichiExtra: number,
 *   margin: number,
 *   gap: number,
 *   sideInset: number,
 * }} LayoutMeasure */

const CARD_EDGE_MARGIN = 20;
const COLLISION_GAP = 2;
const SIDE_OVERHANG = 12;
const RIICHI_STICK_TOP_SLACK = 48;

/**
 * Measure game table geometry (analytic fallback / probe bounds).
 * @param {{ riichiMode?: boolean }} [options]
 * @returns {LayoutMeasure | null}
 */
export function measureLayout(options = {}) {
  const gameArea = document.querySelector('.game-area');
  const card = document.querySelector('.player-card.pos-0') || document.querySelector('.pos-0');
  const dial = document.querySelector('.center-dial');
  if (!gameArea || !card || !dial) return null;

  const area = gameArea.getBoundingClientRect();
  return {
    halfW: area.width / 2,
    halfH: area.height / 2,
    baseH: card.offsetHeight,
    baseW: card.offsetWidth,
    dialBaseR: dial.offsetWidth / 2,
    riichiExtra: options.riichiMode ? RIICHI_STICK_TOP_SLACK : 0,
    margin: CARD_EDGE_MARGIN,
    gap: COLLISION_GAP,
    sideInset: SIDE_OVERHANG,
  };
}

/**
 * Fast analytic upper bound — uses card height as radial reach (side seats rotate).
 * Kept as fallback when DOM is unavailable.
 * @param {LayoutMeasure | null} m
 * @param {number} [absoluteMax]
 */
export function maxScaleFromLayout(m, absoluteMax = 4.5) {
  if (!m) return absoluteMax;

  const radial = m.baseH + m.dialBaseR;
  const limitY = (m.halfH - m.margin - m.gap) / radial;
  const limitX = (m.halfW - m.margin - m.gap + m.sideInset) / radial;

  return Math.min(absoluteMax, Math.max(0.5, Math.min(limitX, limitY)));
}

/** @param {number} maxScale @param {number} [buffer] */
export function optimalScaleFromMax(maxScale, buffer = 1) {
  return Math.max(0.5, Math.min(maxScale, maxScale * buffer));
}

/** @param {DOMRect} r @param {number} px */
function insetRect(r, px) {
  return {
    left: r.left + px,
    top: r.top + px,
    right: r.right - px,
    bottom: r.bottom - px,
  };
}

/** @param {{ left: number, top: number, right: number, bottom: number }} a @param {typeof a} b */
function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Whether current DOM layout collides (dial vs cards, or cards clip game area).
 */
export function layoutCollides() {
  const dial = document.querySelector('.center-dial');
  const area = document.querySelector('.game-area');
  if (!dial || !area) return true;

  const dialBox = insetRect(dial.getBoundingClientRect(), COLLISION_GAP);
  const areaRect = area.getBoundingClientRect();

  for (const card of document.querySelectorAll('.player-card')) {
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width < 4 || cardRect.height < 4) continue;

    if (rectsOverlap(dialBox, cardRect)) return true;

    if (cardRect.left < areaRect.left - SIDE_OVERHANG) return true;
    if (cardRect.right > areaRect.right + SIDE_OVERHANG) return true;
    if (cardRect.top < areaRect.top - RIICHI_STICK_TOP_SLACK) return true;
    if (cardRect.bottom > areaRect.bottom + 8) return true;
  }
  return false;
}

/** @param {number} scale @param {string} dialRotation */
function applyProbeScale(scale, dialRotation) {
  document.querySelectorAll('.player-card').forEach((el) => {
    el.style.setProperty('--scale-factor', String(scale));
  });
  const card = document.querySelector('.player-card.pos-0') || document.querySelector('.pos-0');
  const offset = card && scale > 1 ? card.offsetHeight * (scale - 1) / 2 : 0;
  applyCardOffsets(offset);

  const dial = document.querySelector('.center-dial');
  if (dial) {
    dial.style.transform = dialRotation
      ? `${dialRotation} scale(${scale})`
      : `scale(${scale})`;
    void dial.offsetHeight;
  }
}

/**
 * Binary-search the largest scale with no overlap — matches real CSS transforms.
 * @param {number} [absoluteMax]
 */
export function findMaxScaleByProbe(absoluteMax = 4.5) {
  const dial = document.querySelector('.center-dial');
  const cards = document.querySelectorAll('.player-card');
  if (!dial || cards.length === 0) return absoluteMax;

  const saved = {
    cardScales: [...cards].map((c) => c.style.getPropertyValue('--scale-factor')),
    offsets: [...cards].map((c) => ({
      x: c.style.getPropertyValue('--offset-x'),
      y: c.style.getPropertyValue('--offset-y'),
    })),
    dialTransform: dial.style.transform || '',
  };
  const dialRotation = (saved.dialTransform.match(/rotate\([^)]+\)/) || [])[0] || '';

  const restore = () => {
    cards.forEach((c, i) => {
      if (saved.cardScales[i]) c.style.setProperty('--scale-factor', saved.cardScales[i]);
      else c.style.removeProperty('--scale-factor');
      const off = saved.offsets[i];
      if (off.x) c.style.setProperty('--offset-x', off.x);
      else c.style.removeProperty('--offset-x');
      if (off.y) c.style.setProperty('--offset-y', off.y);
      else c.style.removeProperty('--offset-y');
    });
    dial.style.transform = saved.dialTransform;
  };

  applyProbeScale(0.5, dialRotation);
  if (layoutCollides()) {
    restore();
    return 0.5;
  }

  applyProbeScale(absoluteMax, dialRotation);
  if (!layoutCollides()) {
    restore();
    return absoluteMax;
  }

  let lo = 0.5;
  let hi = absoluteMax;
  let best = lo;

  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    applyProbeScale(mid, dialRotation);
    if (layoutCollides()) {
      hi = mid;
    } else {
      best = mid;
      lo = mid;
    }
  }

  restore();
  return Math.max(0.5, best);
}

/** @param {number} ms */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * @param {number} scale
 */
export function cardOffsetForScale(scale) {
  const card = document.querySelector('.player-card.pos-0') || document.querySelector('.pos-0');
  if (!card || scale <= 1) return 0;
  const applied = parseFloat(getComputedStyle(card).getPropertyValue('--scale-factor')) || scale;
  return card.offsetHeight * (applied - 1) / 2;
}

/** @param {number} offset */
export function applyCardOffsets(offset) {
  document.querySelectorAll('.player-card').forEach((el) => {
    el.style.setProperty('--offset-x', `${offset}px`);
    el.style.setProperty('--offset-y', `${offset}px`);
  });
}
