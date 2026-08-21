export const ShyMouseMath = {
  handleRealisticOvershoot(startX, startY, targetX, targetY, box, viewport, points, options, D, W) {
    const adjustedOvershootProb = (options.overshootProb ?? 0.16) * this.config.fatigueMultiplier;
    const isRandomTarget = !box;

    const shouldOvershoot = !isRandomTarget &&
                            !options.isApproach &&
                            D > 120 &&
                            Math.random() < adjustedOvershootProb &&
                            this.config.attentionSpan < 0.92;

    if (!shouldOvershoot) {
      return { points, finalPos: { x: targetX, y: targetY } };
    }

    const dx = targetX - startX;
    const dy = targetY - startY;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const dirX = dx / length;
    const dirY = dy / length;

    let overshootFactor = (0.08 + Math.random() * 0.20) * this.config.fatigueMultiplier;
    let overshootDist = overshootFactor * W;

    let overshootX = targetX + dirX * overshootDist;
    let overshootY = targetY + dirY * overshootDist;

    const margin = 20;
    if (overshootX < margin || overshootX >= viewport.width - margin ||
        overshootY < margin || overshootY >= viewport.height - margin) {
      overshootDist *= 0.5;
      overshootX = targetX + dirX * overshootDist;
      overshootY = targetY + dirY * overshootDist;
    }

    overshootX = this.clamp(overshootX, margin, viewport.width - margin);
    overshootY = this.clamp(overshootY, margin, viewport.height - margin);

    const overshootResult = this.calculateHumanBezierPoints(
      startX, startY, overshootX, overshootY, box, viewport,
      { ...options, overshootProb: 0 }
    );

    const correctionPoints = this.generateRealisticCorrectionPath(
      overshootX, overshootY, targetX, targetY, viewport, options
    );

    return {
      points: overshootResult.points.concat(correctionPoints),
      finalPos: { x: targetX, y: targetY }
    };
  },

  generateRealisticCorrectionPath(overshootX, overshootY, targetX, targetY, viewport, options) {
    const correctionD = this.calculateDistance(
      { x: overshootX, y: overshootY },
      { x: targetX, y: targetY }
    );

    const correctionNumPoints = Math.max(8, Math.round(correctionD / 10));
    const baseJitter = options.jitterStdDev ?? 1.5;
    const jitterStdDev = baseJitter * 0.6 * this.config.fatigueMultiplier;

    const dx = targetX - overshootX;
    const dy = targetY - overshootY;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;

    const correctionDeviation = correctionD * (0.03 + Math.random() * 0.09);
    const perpX = -dy / length;
    const perpY = dx / length;
    const correctionSign = Math.random() < 0.5 ? -1 : 1;

    const c1x = overshootX + dx * 0.32 + correctionSign * correctionDeviation * perpX * Math.random();
    const c1y = overshootY + dy * 0.32 + correctionSign * correctionDeviation * perpY * Math.random();
    const c2x = overshootX + dx * 0.75 + correctionSign * correctionDeviation * perpX * Math.random();
    const c2y = overshootY + dy * 0.75 + correctionSign * correctionDeviation * perpY * Math.random();

    const p0 = { x: overshootX, y: overshootY };
    const p1 = { x: c1x, y: c1y };
    const p2 = { x: c2x, y: c2y };
    const p3 = { x: targetX, y: targetY };

    const correctionPoints = [];

    for (let i = 1; i <= correctionNumPoints; i++) {
      const linearT = i / correctionNumPoints;
      const easedT = this.multiLayerEasing(linearT, correctionD);

      let point = this.getBezierPoint(easedT, p0, p1, p2, p3);

      point.x += this.randomGaussian(0, jitterStdDev);
      point.y += this.randomGaussian(0, jitterStdDev);

      point.x = this.clamp(point.x, 0, viewport.width - 1);
      point.y = this.clamp(point.y, 0, viewport.height - 1);

      correctionPoints.push(point);
    }

    return correctionPoints;
  },

  async microMouseAdjustment() {
    if (!this.lastPos) return;

    const microX = this.lastPos.x + this.randomGaussian(0, 2.5 * this.config.fatigueMultiplier);
    const microY = this.lastPos.y + this.randomGaussian(0, 2.5 * this.config.fatigueMultiplier);

    const viewport = await this.getViewport();

    try {
      await this.page.mouse.move(
        this.clamp(microX, 0, viewport.width - 1),
        this.clamp(microY, 0, viewport.height - 1)
      );
    } catch (error) {
      // Silent
    }
  },

  getBezierPoint(t, p0, p1, p2, p3) {
    const omt = 1 - t;
    const omt2 = omt * omt;
    const omt3 = omt2 * omt;
    const t2 = t * t;
    const t3 = t2 * t;

    return {
      x: p0.x * omt3 + 3 * p1.x * omt2 * t + 3 * p2.x * omt * t2 + p3.x * t3,
      y: p0.y * omt3 + 3 * p1.y * omt2 * t + 3 * p2.y * omt * t2 + p3.y * t3
    };
  },

  easeInOutCubic(t) {
    const variance = (Math.random() - 0.5) * 0.018;
    t = this.clamp(t + variance, 0, 1);

    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },

  randomGaussian(mean = 0, stdDev = 1) {
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * stdDev + mean;
  },

  perlinNoise(x, y, seed) {
    const hash = (n) => {
      n = Math.sin(n + seed) * 43758.5453123;
      return n - Math.floor(n);
    };

    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

    const lerp = (a, b, t) => a + t * (b - a);

    const grad = (h, x, y) => {
      const v = (h & 1) === 0 ? x : y;
      return ((h & 2) === 0 ? -v : v);
    };

    const a = hash(xi + hash(yi));
    const b = hash(xi + 1 + hash(yi));
    const c = hash(xi + hash(yi + 1));
    const d = hash(xi + 1 + hash(yi + 1));

    const u = fade(xf);
    const v = fade(yf);

    const x1 = lerp(grad(a * 255, xf, yf), grad(b * 255, xf - 1, yf), u);
    const x2 = lerp(grad(c * 255, xf, yf - 1), grad(d * 255, xf - 1, yf - 1), u);

    return lerp(x1, x2, v);
  },

  calculateEntropy(points) {
    if (points.length < 3) return 0.5;

    const velocities = [];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const v = Math.sqrt(dx * dx + dy * dy);
      velocities.push(v);
    }

    // Calculate entropy using velocity distribution
    const mean = velocities.reduce((a, b) => a + b, 0) / velocities.length;
    const variance = velocities.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / velocities.length;
    const entropy = Math.log2(1 + variance / (mean + 1));

    return Math.min(1, entropy / 3); // Normalize to 0-1
  },

  calculateSmoothJerk(prevJerk, targetJerk) {
    const smoothness = this.config.jerkSmoothness;
    return {
      x: prevJerk.x * smoothness + targetJerk.x * (1 - smoothness),
      y: prevJerk.y * smoothness + targetJerk.y * (1 - smoothness),
    };
  },

  async humanReactionDelay() {
    const baseTime = this.config.baseReactionTime;
    const variance = this.config.reactionTimeVariance;

    const attentionFactor = 1 + (1 - this.config.attentionSpan) * 0.6;
    const fatigueFactor = this.config.fatigueMultiplier;

    const reactionTime = Math.max(85, this.randomGaussian(baseTime * attentionFactor * fatigueFactor, variance));

    await this.randomDelay(reactionTime * 0.75, reactionTime * 1.25);
  },

  async randomDelay(min, max) {
    const microVar = (Math.random() - 0.5) * 10;
    const delay = min + Math.random() * (max - min) + microVar;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)));
  },

  calculateDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  },

  clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  },

  initializePosition(viewport) {
    const margin = 120;
    const x = margin + Math.pow(Math.random(), 1.3) * (viewport.width - 2 * margin);
    const y = margin + Math.random() * (viewport.height - 2 * margin);

    this.lastPos = { x, y };
    this.lastMoveTime = Date.now();
    this.log('Position initialized:', this.lastPos);
  },

  applyFatigue(baseValue) {
    if (!this.config.fatigueEnabled) return baseValue;

    if (this.config.actionCount > this.config.maxFatigue) {
      this.config.actionCount = Math.floor(this.config.fatigueThreshold * 0.8);
      this.config.attentionSpan = Math.min(0.96, this.config.attentionSpan + 0.08);
      this.config.fatigueMultiplier = 1.0;
      this.log('Fatigue reset');
    }

    if (this.config.actionCount > this.config.fatigueThreshold) {
      const excess = this.config.actionCount - this.config.fatigueThreshold;
      const fatigueLevel = excess / this.config.fatigueThreshold;

      // Unified fatigue multiplier (affects all aspects coherently)
      this.config.fatigueMultiplier = 1.0 + fatigueLevel * 0.4; // Up to 40% slower/less precise

      return Math.round(baseValue * Math.min(1 + fatigueLevel * 0.018, 1.45));
    }

    return baseValue;
  },

  updateActionCount() {
    this.config.actionCount++;

    if (this.config.actionCount % 45 === 0) {
      const recovery = Math.floor(15 + Math.random() * 10);
      this.config.actionCount = Math.max(0, this.config.actionCount - recovery);
      this.config.attentionSpan = Math.min(0.96, this.config.attentionSpan + 0.04);
      this.config.fatigueMultiplier = Math.max(1.0, this.config.fatigueMultiplier * 0.85);
      this.log('Recovery applied');
    }

    this.config.attentionSpan = Math.max(
      this.config.minAttentionSpan,
      this.config.attentionSpan - 0.0008
    );
  },

  addToHistory(position) {
    this.moveHistory.push(position);
    if (this.moveHistory.length > this.maxHistoryLength) {
      this.moveHistory.shift();
    }
  },

  getMovementStats() {
    if (this.moveHistory.length < 2) return null;

    const distances = [];
    const timeDiffs = [];

    for (let i = 1; i < this.moveHistory.length; i++) {
      const dist = this.calculateDistance(this.moveHistory[i - 1], this.moveHistory[i]);
      const timeDiff = this.moveHistory[i].time - this.moveHistory[i - 1].time;
      distances.push(dist);
      timeDiffs.push(timeDiff);
    }

    const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
    const avgTime = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;

    return {
      averageDistance: avgDistance,
      averageTime: avgTime,
      averageSpeed: avgDistance / avgTime,
      totalMoves: this.moveHistory.length,
      actionCount: this.config.actionCount,
      attentionSpan: this.config.attentionSpan,
      fatigueLevel: Math.max(0, this.config.actionCount - this.config.fatigueThreshold),
      fatigueMultiplier: this.config.fatigueMultiplier
    };
  },

  reset() {
    this.config.actionCount = 0;
    this.config.attentionSpan = 0.88 + Math.random() * 0.10;
    this.config.fatigueMultiplier = 1.0;
    this.moveHistory = [];
    this.lastPos = null;
    this.invalidateViewportCache();

    // Reset advanced motion state (2025+ enhancement)
    this.motionState = {
      lastVelocity: { x: 0, y: 0 },
      lastAcceleration: { x: 0, y: 0 },
      lastJerk: { x: 0, y: 0 },
      temporalCorrelation: 0.5,
      entropyAccumulator: 0,
      perlinSeed: Math.random() * 10000,
      pollingPhase: Math.random(),
    };

    this.log('State reset complete (with advanced motion state)');
  },
}
