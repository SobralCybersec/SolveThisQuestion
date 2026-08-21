// Coordinate-level humanized mouse for the patchright worker (Fitts timing, Bézier paths,
// fatigue, jerk-smoothed physics, 60–144Hz polling simulation).
//
// WHY this exists alongside human.js: human.js clicks *locators* (element-relative, with
// actionability + overlay-escape logic) and is the right tool for form fields. ShyMouse drives
// raw viewport COORDINATES — which is what captcha solving needs, because a Cloudflare Turnstile
// checkbox lives in a cross-origin iframe you cannot reach into: you click its screen position,
// not its element. All motion goes through page.mouse.move/down/up → CDP Input domain, so the real
// OS pointer never moves (LO watches; see memory focus-safe-automation).
//
// Added for HireMeOps: clickAtPoint(x, y) — humanized move + realistic press at a computed point.

import { ShyMouseLifecycle } from './shy-mouse-lifecycle.js'
import { ShyMouseElements } from './shy-mouse-elements.js'
import { ShyMouseStability } from './shy-mouse-stability.js'
import { ShyMouseScroll } from './shy-mouse-scroll.js'
import { ShyMousePointer } from './shy-mouse-pointer.js'
import { ShyMouseMovement } from './shy-mouse-movement.js'
import { ShyMouseBezier } from './shy-mouse-bezier.js'
import { ShyMouseMath } from './shy-mouse-math.js'

class ShyMouse {
  constructor(page, options = {}) {
    this.page = page;
    this.lastPos = null;
    this.lastMoveTime = Date.now();
    this.moveHistory = [];
    this.maxHistoryLength = 50;
    this.cachedViewport = null;
    this.viewportCacheTime = 0;
    this.viewportCacheDuration = 2000;

    // Advanced motion state tracking (2025+ research)
    this.motionState = {
      lastVelocity: { x: 0, y: 0 },
      lastAcceleration: { x: 0, y: 0 },
      lastJerk: { x: 0, y: 0 },
      temporalCorrelation: 0.5,
      entropyAccumulator: 0,
      perlinSeed: Math.random() * 10000,
      pollingPhase: Math.random(),
    };

    // Research-based configuration
    this.config = {
      // Fatigue system (coherent: everything slows down)
      fatigueEnabled: options.fatigueEnabled ?? true,
      fatigueThreshold: options.fatigueThreshold ?? 20,
      actionCount: 0,
      maxFatigue: options.maxFatigue ?? 100,
      fatigueMultiplier: 1.0, // Affects both speed and precision coherently

      attentionSpan: 0.88 + Math.random() * 0.10,
      minAttentionSpan: 0.80,

      // Human reaction time: 150-300ms (research-based)
      baseReactionTime: options.baseReactionTime ?? 200,
      reactionTimeVariance: options.reactionTimeVariance ?? 80,

      curveComplexity: options.curveComplexity ?? 'high',
      debug: options.debug ?? false,

      // Human behavior patterns (2025+ enhanced)
      hesitationProbability: 0.08,
      microCorrectionFrequency: 0.15,
      targetDriftEnabled: true,

      // Mouse polling rate simulation (60-144Hz typical)
      minPollingInterval: 6.9, // 144Hz
      maxPollingInterval: 16.6, // 60Hz
      typicalPollingInterval: 10, // ~100Hz (most common)

      // Fitts's Law parameters (empirical research 2020-2025)
      fittsA: 0.230, // Intercept (reaction/processing time in seconds)
      fittsB: 0.166, // Slope (movement time coefficient)

      // Advanced entropy and fractal parameters
      fractalDepth: 3,
      entropyTarget: 0.65, // Target entropy for natural unpredictability
      jerkSmoothness: 0.85, // How smooth jerk transitions are (0-1)
    };

    this.setupNavigationListener();
    this.setupConsoleLogger();
  }
}

Object.assign(ShyMouse.prototype,
  ShyMouseLifecycle,
  ShyMouseElements,
  ShyMouseStability,
  ShyMouseScroll,
  ShyMousePointer,
  ShyMouseMovement,
  ShyMouseBezier,
  ShyMouseMath,
)

export default ShyMouse
export { ShyMouse }

// One coherent ShyMouse per page — fatigue/motion state must persist across the session so the
// cursor "tires" like a real human over many actions (that coherence is the anti-bot signal, not
// any single movement). Cached on the page object; lives until the page closes. Shared by human.js
// (form-fill travel) and captcha.js (checkbox/slider) so both draw from the same fatigue state.
export function getShyMouse(page, options = {}) {
  if (!page.__shyMouse) page.__shyMouse = new ShyMouse(page, options)
  return page.__shyMouse
}
