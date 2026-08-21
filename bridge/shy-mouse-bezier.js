export const ShyMouseBezier = {
  calculateRealisticPollingDelay(phase, velocityFactor = 1) {
    // Temporal correlation: events are correlated with previous polling intervals
    const correlation = this.motionState.temporalCorrelation;
    const pollingPhase = this.motionState.pollingPhase;

    let baseDelay;

    // Correlated randomness (not pure random)
    const correlatedRandom = Math.random() * (1 - correlation) + pollingPhase * correlation;
    this.motionState.pollingPhase = correlatedRandom; // Update for next call

    if (correlatedRandom < 0.65) {
      // 65% typical rate: ~100Hz (9-11ms)
      baseDelay = this.config.typicalPollingInterval + this.randomGaussian(0, 1.5);
    } else if (correlatedRandom < 0.82) {
      // 17% faster: ~120-144Hz (6.9-8.5ms)
      baseDelay = this.config.minPollingInterval + Math.random() * 1.6;
    } else {
      // 18% slower: ~60-85Hz (11.8-16.6ms)
      baseDelay = 11.8 + Math.random() * 4.8;
    }

    // Phase modulation: velocity-dependent timing (Fitts's Law influence)
    if (phase > 0.3 && phase < 0.7) {
      // Cruise phase: faster polling during fast movement
      baseDelay *= 0.88 * velocityFactor;
    } else if (phase > 0.85) {
      // Precision phase: slower, more deliberate
      baseDelay *= 1.25;
    } else if (phase < 0.15) {
      // Acceleration phase: variable timing
      baseDelay *= 0.95 + Math.random() * 0.15;
    }

    // Entropy-based micro-variation (fractal-like)
    const entropyNoise = this.perlinNoise(
      Date.now() * 0.01,
      this.motionState.entropyAccumulator,
      this.motionState.perlinSeed
    );
    baseDelay += entropyNoise * 1.2;
    this.motionState.entropyAccumulator += 0.1;

    // Physiological limits: can't be perfectly regular
    baseDelay += Math.sin(Date.now() * 0.01) * 0.5;

    return this.clamp(baseDelay, this.config.minPollingInterval, this.config.maxPollingInterval);
  },

  calculateHumanBezierPoints(startX, startY, targetX, targetY, box, viewport, options) {
    const D = this.calculateDistance({ x: startX, y: startY }, { x: targetX, y: targetY });

    const W = box ? Math.min(box.width, box.height) : (options.defaultTargetWidth ?? 100);

    // Correct Fitts's Law: ID = log2(D/W + 1)
    const ID = Math.log2(D / W + 1);

    // Fitts's Law: MT = a + b·ID (in seconds)
    // Convert to milliseconds and use for timing
    const predictedMT = (this.config.fittsA + this.config.fittsB * ID) * 1000;
    const adjustedMT = predictedMT * this.config.fatigueMultiplier * (0.95 + Math.random() * 0.1);

    let complexityMultiplier = 1.0;
    switch (this.config.curveComplexity) {
      case 'low':
        complexityMultiplier = 0.7;
        break;
      case 'high':
        complexityMultiplier = 1.3;
        break;
      default:
        complexityMultiplier = 1.0;
    }

    // Calculate number of points based on movement time and polling rate
    // MT / avgPollingInterval = approximate number of points
    let baseNumPoints = Math.round(adjustedMT / this.config.typicalPollingInterval);
    baseNumPoints = Math.max(15, Math.round(baseNumPoints * complexityMultiplier));
    baseNumPoints = this.applyFatigue(baseNumPoints);
    const numPoints = options.numPoints ?? baseNumPoints;

    const primaryControls = this.calculateRealisticControlPoints(
      startX, startY, targetX, targetY, D, options
    );

    let targetDrift = null;
    if (this.config.targetDriftEnabled && !options.isApproach && D > 100) {
      const driftMagnitude = this.randomGaussian(0, 3 * this.config.fatigueMultiplier);
      targetDrift = {
        x: driftMagnitude,
        y: driftMagnitude
      };
    }

    const baseJitter = options.jitterStdDev ?? 1.5;
    const jitterStdDev = baseJitter * this.config.fatigueMultiplier;
    const points = [];

    // Generate realistic velocity profile (bell curve for ballistic movement)
    const velocityProfile = this.generateVelocityProfile(numPoints, D);

    for (let i = 1; i <= numPoints; i++) {
      const linearT = i / numPoints;
      const easedT = this.multiLayerEasing(linearT, D);

      let point = this.getBezierPoint(easedT,
        primaryControls.p0,
        primaryControls.p1,
        primaryControls.p2,
        primaryControls.p3
      );

      // Micro-corrections with fractal depth
      if (Math.random() < this.config.microCorrectionFrequency && linearT > 0.2 && linearT < 0.9) {
        const correctionAngle = Math.random() * Math.PI * 2;
        const correctionMagnitude = this.randomGaussian(0, 4 * this.config.fatigueMultiplier);

        // Add fractal sub-movements (multiple scales)
        for (let depth = 0; depth < this.config.fractalDepth; depth++) {
          const scale = Math.pow(0.5, depth);
          const fractalNoise = this.perlinNoise(
            i * 0.1 * (depth + 1),
            linearT * 10 * (depth + 1),
            this.motionState.perlinSeed + depth
          );
          point.x += Math.cos(correctionAngle) * correctionMagnitude * scale + fractalNoise * scale;
          point.y += Math.sin(correctionAngle) * correctionMagnitude * scale + fractalNoise * scale;
        }
      }

      // Progressive jitter with velocity-dependent noise
      const progressFactor = 1 - easedT;
      const distanceToEnd = progressFactor * D;
      const velocityInfluence = velocityProfile[i - 1];
      const adaptiveJitter = jitterStdDev * Math.min(1.5, distanceToEnd / 70) * (0.8 + velocityInfluence * 0.4);

      // Multi-scale noise (combining Gaussian and Perlin)
      const gaussianNoise = this.randomGaussian(0, adaptiveJitter);
      const perlinNoiseX = this.perlinNoise(i * 0.15, 0, this.motionState.perlinSeed) * adaptiveJitter * 0.3;
      const perlinNoiseY = this.perlinNoise(0, i * 0.15, this.motionState.perlinSeed + 1) * adaptiveJitter * 0.3;

      point.x += gaussianNoise + perlinNoiseX;
      point.y += gaussianNoise + perlinNoiseY;

      // Attention errors
      if (this.config.attentionSpan < 0.95) {
        if (Math.random() > this.config.attentionSpan) {
          const errorMagnitude = (1 - this.config.attentionSpan) * 18 * this.config.fatigueMultiplier;
          point.x += this.randomGaussian(0, errorMagnitude * 0.25);
          point.y += this.randomGaussian(0, errorMagnitude * 0.25);
        }
      }

      // Sub-movements
      if (linearT > 0.3 && linearT < 0.85 && Math.random() < 0.12) {
        const subMovement = this.randomGaussian(0, 2.5 * this.config.fatigueMultiplier);
        point.x += subMovement;
        point.y += subMovement;
      }

      // Angular velocity variation
      if (i > 1 && Math.random() < 0.2) {
        const prevPoint = points[points.length - 1];
        const angle = Math.atan2(point.y - prevPoint.y, point.x - prevPoint.x);
        const angleVariation = this.randomGaussian(0, 0.08);
        const dist = this.calculateDistance(prevPoint, point);

        point.x = prevPoint.x + Math.cos(angle + angleVariation) * dist;
        point.y = prevPoint.y + Math.sin(angle + angleVariation) * dist;
      }

      point.x = this.clamp(point.x, 0, viewport.width - 1);
      point.y = this.clamp(point.y, 0, viewport.height - 1);

      points.push(point);
    }

    const result = this.handleRealisticOvershoot(
      startX, startY, targetX, targetY, box, viewport, points, options, D, W
    );

    return {
      points: result.points,
      finalPos: result.finalPos,
      targetDrift: targetDrift,
      velocityProfile: velocityProfile
    };
  },

  generateVelocityProfile(numPoints, distance) {
    const profile = [];
    const peakPosition = 0.40 + Math.random() * 0.15; // Peak velocity at 40-55% of movement

    for (let i = 0; i < numPoints; i++) {
      const t = i / numPoints;

      // Asymmetric Gaussian (skewed bell curve)
      let velocity;
      if (t < peakPosition) {
        // Acceleration phase (slightly faster rise)
        const normT = t / peakPosition;
        velocity = Math.exp(-Math.pow((normT - 1) * 2.2, 2));
      } else {
        // Deceleration phase (slower, more controlled)
        const normT = (t - peakPosition) / (1 - peakPosition);
        velocity = Math.exp(-Math.pow(normT * 2.8, 2));
      }

      // Add natural variation with Perlin noise
      const noiseVariation = this.perlinNoise(i * 0.1, 0, this.motionState.perlinSeed + 100);
      velocity *= (1 + noiseVariation * 0.15);

      // Minimum velocity (never completely stop in the middle)
      velocity = Math.max(0.1, velocity);

      profile.push(velocity);
    }

    return profile;
  },

  calculateRealisticControlPoints(startX, startY, targetX, targetY, D, options) {
    const dx = targetX - startX;
    const dy = targetY - startY;

    const baseDeviation = D * (0.10 + Math.random() * 0.32);
    const deviation = options.isApproach ? baseDeviation * 0.35 : baseDeviation;

    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const perpX = -dy / length;
    const perpY = dx / length;

    const directionBias = Math.random() < 0.65 ? 1 : -1;

    const c1FactorBase = 0.18 + Math.random() * 0.24;
    const c2FactorBase = 0.54 + Math.random() * 0.28;

    const asymmetry = (Math.random() - 0.5) * 0.22;
    const c1Factor = this.clamp(c1FactorBase + asymmetry, 0.15, 0.48);
    const c2Factor = this.clamp(c2FactorBase - asymmetry, 0.50, 0.88);

    const c1Deviation = deviation * (0.5 + Math.random() * 0.6);
    const c2Deviation = deviation * (0.4 + Math.random() * 0.7);

    const fatigueImpact = this.config.fatigueMultiplier;
    const c1x = startX + dx * c1Factor + directionBias * c1Deviation * perpX * fatigueImpact;
    const c1y = startY + dy * c1Factor + directionBias * c1Deviation * perpY * fatigueImpact;

    const c2x = startX + dx * c2Factor + directionBias * c2Deviation * perpX * fatigueImpact;
    const c2y = startY + dy * c2Factor + directionBias * c2Deviation * perpY * fatigueImpact;

    return {
      p0: { x: startX, y: startY },
      p1: { x: c1x, y: c1y },
      p2: { x: c2x, y: c2y },
      p3: { x: targetX, y: targetY }
    };
  },

  multiLayerEasing(t, distance) {
    let eased = t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // Micro-variations with fractal noise
    const microVariation = (Math.random() - 0.5) * 0.02;
    const fractalVariation = this.perlinNoise(t * 5, distance * 0.01, this.motionState.perlinSeed) * 0.015;
    eased += microVariation + fractalVariation;

    // Tremor (high-frequency noise) with temporal correlation
    const tremorPhase = Date.now() * 0.01 + t * Math.PI * 8;
    const tremor = Math.sin(tremorPhase) * 0.008 * this.motionState.temporalCorrelation;
    eased += tremor;

    // Attention lapses with entropy-based probability
    const currentEntropy = this.motionState.entropyAccumulator % 1;
    const lapseProb = (1 - this.config.attentionSpan) * (1 + currentEntropy) * 0.1;
    if (Math.random() < lapseProb) {
      const lapse = this.randomGaussian(0, 0.025);
      eased += lapse;
      this.log('Attention lapse at t=', t.toFixed(3));
    }

    // Distance-based hesitation with Fitts's Law influence
    const ID = Math.log2(distance / 100 + 1);
    const hesitationProb = 0.04 * (ID / 5); // Higher ID = more difficult = more hesitation
    if (distance > 500 && t > 0.35 && t < 0.65 && Math.random() < hesitationProb) {
      eased *= 0.92;
    }

    // Sub-pixel precision errors (humans can't be perfectly precise)
    if (t > 0.8) {
      const precisionError = this.randomGaussian(0, 0.008 * this.config.fatigueMultiplier);
      eased += precisionError;
    }

    return this.clamp(eased, 0, 1);
  },
}
