export const ShyMouseMovement = {
  calculateClickTarget(box, options) {
    const clickPaddingFactor = options.clickPadding ?? 0.68;

    // Fatigue affects precision
    const fatigueOffset = (this.config.fatigueMultiplier - 1) * 0.15;

    const biasX = -0.1 + fatigueOffset;
    const biasY = -0.05 + fatigueOffset;

    const offsetX = (this.randomGaussian(biasX, 0.25 * this.config.fatigueMultiplier) * box.width) * clickPaddingFactor;
    const offsetY = (this.randomGaussian(biasY, 0.25 * this.config.fatigueMultiplier) * box.height) * clickPaddingFactor;

    let targetX = box.x + box.width / 2 + offsetX;
    let targetY = box.y + box.height / 2 + offsetY;

    const marginX = Math.min(8, box.width * 0.1);
    const marginY = Math.min(8, box.height * 0.1);

    targetX = this.clamp(targetX, box.x + marginX, box.x + box.width - marginX);
    targetY = this.clamp(targetY, box.y + marginY, box.y + box.height - marginY);

    return { x: targetX, y: targetY };
  },

  calculateNaturalApproachTarget(clickTarget, box, viewport) {
    if (!this.lastPos) {
      // Fallback to random approach
      const distance = 25 + Math.random() * 35;
      const angle = Math.random() * Math.PI * 2;

      let x = clickTarget.x + Math.cos(angle) * distance;
      let y = clickTarget.y + Math.sin(angle) * distance;

      x = this.clamp(x, 0, viewport.width - 1);
      y = this.clamp(y, 0, viewport.height - 1);

      return { x, y };
    }

    // Calculate approach based on current trajectory
    const dx = clickTarget.x - this.lastPos.x;
    const dy = clickTarget.y - this.lastPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;

    // Direction from lastPos to target
    const dirX = dx / distance;
    const dirY = dy / distance;

    // Approach distance: 25-60px from target along trajectory
    const approachDistance = 25 + Math.random() * 35;

    // Natural jitter perpendicular to trajectory (±15 degrees typical)
    const perpendicularAngle = Math.atan2(dirY, dirX) + (Math.random() - 0.5) * (Math.PI / 6);
    const jitterMagnitude = (Math.random() - 0.5) * 20 * this.config.fatigueMultiplier;

    let x = clickTarget.x - dirX * approachDistance + Math.cos(perpendicularAngle) * jitterMagnitude;
    let y = clickTarget.y - dirY * approachDistance + Math.sin(perpendicularAngle) * jitterMagnitude;

    x = this.clamp(x, 0, viewport.width - 1);
    y = this.clamp(y, 0, viewport.height - 1);

    return { x, y };
  },

  async postClickBehavior(clickTarget, viewport, options) {
    const behavior = Math.random();

    if (behavior < 0.35) {
      await this.randomDelay(120, 550);
    } else if (behavior < 0.65) {
      const jitterX = clickTarget.x + this.randomGaussian(0, 6 * this.config.fatigueMultiplier);
      const jitterY = clickTarget.y + this.randomGaussian(0, 6 * this.config.fatigueMultiplier);

      await this.moveToPosition(
        this.clamp(jitterX, 0, viewport.width - 1),
        this.clamp(jitterY, 0, viewport.height - 1),
        { ...options, numPoints: 2 }
      );

      await this.randomDelay(60, 220);
    } else {
      const awayDistance = 35 + Math.random() * 80;
      const awayAngle = Math.random() * Math.PI * 2;
      const awayX = clickTarget.x + Math.cos(awayAngle) * awayDistance;
      const awayY = clickTarget.y + Math.sin(awayAngle) * awayDistance;

      await this.moveToPosition(
        this.clamp(awayX, 0, viewport.width - 1),
        this.clamp(awayY, 0, viewport.height - 1),
        options
      );
    }
  },

  async move(options = {}) {
    const viewport = await this.getViewport();

    if (!this.lastPos) {
      this.initializePosition(viewport);
    }

    const padding = 60;
    const targetX = padding + Math.random() * (viewport.width - 2 * padding);
    const targetY = padding + Math.random() * (viewport.height - 2 * padding);

    await this.moveToPosition(targetX, targetY, options);
    this.updateActionCount();
  },

  async moveToPosition(targetX, targetY, options = {}) {
    const viewport = await this.getViewport();

    if (!this.lastPos) {
      this.initializePosition(viewport);
    }

    targetX = this.clamp(targetX, 0, viewport.width - 1);
    targetY = this.clamp(targetY, 0, viewport.height - 1);

    const { points, targetDrift, velocityProfile } = this.calculateHumanBezierPoints(
      this.lastPos.x,
      this.lastPos.y,
      targetX,
      targetY,
      null,
      viewport,
      options
    );

    // Track motion derivatives for realistic physics
    let lastPoint = this.lastPos;
    let lastVelocity = this.motionState.lastVelocity;
    let lastAcceleration = this.motionState.lastAcceleration;

    // Execute with realistic polling rate and motion physics
    for (let i = 0; i < points.length; i++) {
      let point = points[i];

      // Target drift with fractal noise
      if (targetDrift && i > points.length * 0.5) {
        const driftFactor = (i - points.length * 0.5) / (points.length * 0.5);
        const fractalNoise = this.perlinNoise(i * 0.1, Date.now() * 0.001, this.motionState.perlinSeed);
        point.x += targetDrift.x * driftFactor + fractalNoise * 0.5;
        point.y += targetDrift.y * driftFactor + fractalNoise * 0.5;
      }

      // Calculate realistic motion derivatives
      const velocity = {
        x: point.x - lastPoint.x,
        y: point.y - lastPoint.y,
      };

      const acceleration = {
        x: velocity.x - lastVelocity.x,
        y: velocity.y - lastVelocity.y,
      };

      const rawJerk = {
        x: acceleration.x - lastAcceleration.x,
        y: acceleration.y - lastAcceleration.y,
      };

      // Smooth jerk (humans can't make instant acceleration changes)
      const jerk = this.calculateSmoothJerk(this.motionState.lastJerk, rawJerk);

      // Apply jerk-influenced micro-adjustments
      const jerkMagnitude = Math.sqrt(jerk.x * jerk.x + jerk.y * jerk.y);
      if (jerkMagnitude > 0.5) {
        const jerkNoise = this.randomGaussian(0, jerkMagnitude * 0.15);
        point.x += jerkNoise;
        point.y += jerkNoise;
      }

      point.x = this.clamp(point.x, 0, viewport.width - 1);
      point.y = this.clamp(point.y, 0, viewport.height - 1);

      try {
        await this.page.mouse.move(point.x, point.y);
      } catch (error) {
        this.log('Mouse move failed:', error.message);
        continue;
      }

      // REALISTIC POLLING RATE with temporal correlation
      const phase = i / points.length;
      let pollingDelay = this.calculateRealisticPollingDelay(phase, velocityProfile ? velocityProfile[i] : 1);

      // Apply fatigue to timing
      pollingDelay *= this.config.fatigueMultiplier;

      await this.randomDelay(pollingDelay, pollingDelay + 2);

      // Hesitation with entropy consideration
      const currentEntropy = this.calculateEntropy(points.slice(Math.max(0, i - 5), i + 1));
      const hesitationProb = this.config.hesitationProbability * (1 + (this.config.entropyTarget - currentEntropy));

      if (Math.random() < hesitationProb && phase > 0.2 && phase < 0.8) {
        const hesitationDuration = this.randomGaussian(80, 40) * this.config.fatigueMultiplier;
        await this.randomDelay(Math.max(30, hesitationDuration), hesitationDuration + 50);
        this.log('Hesitation at', phase.toFixed(2), 'entropy:', currentEntropy.toFixed(3));
      }

      // Update motion state
      lastPoint = point;
      lastVelocity = velocity;
      lastAcceleration = acceleration;
      this.motionState.lastJerk = jerk;
    }

    // Update motion state for temporal correlation
    this.motionState.lastVelocity = lastVelocity;
    this.motionState.lastAcceleration = lastAcceleration;
    this.motionState.temporalCorrelation = Math.min(0.9, this.motionState.temporalCorrelation + 0.05);

    this.lastPos = { x: targetX, y: targetY };
    this.lastMoveTime = Date.now();
    this.addToHistory({ x: targetX, y: targetY, time: Date.now() });
  },
}
