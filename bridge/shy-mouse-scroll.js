export const ShyMouseScroll = {
  async scrollToElement(element, options = {}) {
    const viewport = await this.getViewport();

    if (await this.isElementInViewport(element, options.visibilityBuffer ?? 50)) {
      if (Math.random() < 0.25) {
        const microScroll = this.randomGaussian(0, 12);
        await this.page.mouse.wheel(0, microScroll);
        await this.randomDelay(50, 150);
      }
      return;
    }

    const box = await this.getElementBoundingBox(element);
    if (!box) throw new Error('Element has no bounding box');

    const scrollContainer = await this.getScrollContainer(element);
    const targetPosition = options.targetPosition ?? 'center';

    let currentScroll, targetScroll;

    if (scrollContainer.info.isWindow) {
      currentScroll = viewport.scrollY;

      switch (targetPosition) {
        case 'top':
          targetScroll = box.y - (options.offset ?? 100);
          break;
        case 'bottom':
          targetScroll = box.y + box.height - viewport.height + (options.offset ?? 100);
          break;
        default:
          targetScroll = box.y + box.height / 2 - viewport.height / 2;
      }

      const maxScroll = scrollContainer.info.scrollHeight - viewport.height;
      targetScroll = this.clamp(targetScroll, 0, maxScroll);
    } else {
      const scrollInfo = await element.evaluate((el, opts) => {
        try {
          // Helper: traverse shadow boundaries and slot assignments
          function getComposedParentNode(node) {
            if (!node) return null;
            if (node.assignedSlot) return node.assignedSlot;
            const parent = node.parentNode;
            if (!parent) return null;
            if (parent instanceof ShadowRoot) return parent.host;
            if (parent instanceof Element) return parent;
            return null;
          }

          let parent = getComposedParentNode(el);
          let depth = 0;

          while (parent && parent !== document.documentElement && depth < 50) {
            const style = window.getComputedStyle(parent);
            const overflow = style.overflow + style.overflowY + style.overflowX;

            if (/(auto|scroll)/.test(overflow)) {
              const parentRect = parent.getBoundingClientRect();
              const elRect = el.getBoundingClientRect();

              const currentScrollTop = parent.scrollTop;
              const targetPos = opts.targetPosition || 'center';

              const elTopRelativeToContainer = elRect.top - parentRect.top + currentScrollTop;

              let scrollTo;
              if (targetPos === 'top') {
                scrollTo = elTopRelativeToContainer - (opts.offset || 50);
              } else if (targetPos === 'bottom') {
                scrollTo = elTopRelativeToContainer + elRect.height - parent.clientHeight + (opts.offset || 50);
              } else {
                scrollTo = elTopRelativeToContainer - parent.clientHeight / 2 + elRect.height / 2;
              }

              const maxScroll = parent.scrollHeight - parent.clientHeight;
              scrollTo = Math.max(0, Math.min(scrollTo, maxScroll));

              return {
                found: true,
                currentScroll: currentScrollTop,
                targetScroll: scrollTo,
                maxScroll: maxScroll
              };
            }

            parent = getComposedParentNode(parent);
            depth++;
          }

          return { found: false };
        } catch (e) {
          return { found: false };
        }
      }, { targetPosition, offset: options.offset });

      if (scrollInfo.found) {
        currentScroll = scrollInfo.currentScroll;
        targetScroll = scrollInfo.targetScroll;
      } else {
        currentScroll = viewport.scrollY;
        targetScroll = box.y + box.height / 2 - viewport.height / 2;
        targetScroll = this.clamp(targetScroll, 0, scrollContainer.info.scrollHeight - viewport.height);
      }
    }

    await this.preScrollMouseMovement(viewport, options);

    const delta = Math.abs(targetScroll - currentScroll);
    if (delta < 10) {
      // Dispose container handle
      if (scrollContainer.containerHandle) {
        await scrollContainer.containerHandle.dispose().catch(() => {});
      }
      return;
    }

    const direction = targetScroll > currentScroll ? 1 : -1;

    const scrollID = Math.log2(delta / 100 + 1);
    const baseSteps = Math.max(5, Math.round(8 * scrollID));
    const numSteps = this.applyFatigue(baseSteps);

    const overshootProb = options.overshootProb ?? 0.18;
    const shouldOvershoot = delta > 250 &&
                            Math.random() < overshootProb &&
                            this.config.attentionSpan < 0.94;

    let overshootAmount = 0;
    if (shouldOvershoot) {
      overshootAmount = this.randomGaussian(0.15, 0.07) * viewport.height;
      overshootAmount = this.clamp(overshootAmount, 40, viewport.height * 0.35);
    }

    await this.executeScrollSequence(
      targetScroll,
      direction,
      numSteps,
      overshootAmount,
      scrollContainer,
      options
    );

    if (overshootAmount > 0) {
      await this.randomDelay(120, 350);
      await this.executeCorrectionScrollLogarithmic(
        targetScroll,
        direction,
        Math.max(3, Math.round(numSteps / 3)),
        scrollContainer,
        options
      );
    }

    // Dispose container handle
    if (scrollContainer.containerHandle) {
      await scrollContainer.containerHandle.dispose().catch(() => {});
    }

    await this.randomDelay(80, 180);
    this.updateActionCount();
  },

  async preScrollMouseMovement(viewport, options) {
    if (!this.lastPos) {
      this.initializePosition(viewport);
    }

    const hoverTarget = {
      x: viewport.width * (0.25 + Math.random() * 0.5),
      y: viewport.height * (0.15 + Math.random() * 0.7)
    };

    const distance = this.calculateDistance(this.lastPos, hoverTarget);

    if (distance > 60) {
      await this.moveToPosition(hoverTarget.x, hoverTarget.y, {
        ...options,
        numPoints: Math.max(6, Math.round(distance / 60))
      });
    }
  },

  async executeScrollSequence(targetScroll, direction, numSteps, overshootAmount, scrollContainer, options) {
    const baseJitterStdDev = options.scrollJitterStdDev ?? 18;
    const jitterStdDev = baseJitterStdDev * this.config.fatigueMultiplier; // Fatigue increases jitter

    for (let i = 1; i <= numSteps; i++) {
      let currentScroll;

      if (scrollContainer.info.isWindow) {
        currentScroll = await this.getCurrentScrollY();
      } else if (scrollContainer.containerHandle) {
        currentScroll = await scrollContainer.containerHandle.evaluate(el => {
          try {
            return el.scrollTop;
          } catch (e) {
            return 0;
          }
        });
      } else {
        break;
      }

      const remainingDelta = Math.abs(targetScroll - currentScroll);
      if (remainingDelta < 8) break;

      const progress = i / numSteps;

      // Logarithmic deceleration
      const logDeceleration = 1 - Math.log10(1 + 9 * progress);
      const easedProgress = this.easeInOutCubic(progress);
      const blendedProgress = easedProgress * 0.6 + logDeceleration * 0.4;

      // COHERENT FATIGUE: smaller steps (divide by fatigue)
      let stepDelta = (remainingDelta * (1 - blendedProgress) * 0.3) / this.config.fatigueMultiplier;

      const distanceBasedJitter = Math.min(jitterStdDev, remainingDelta * 0.12);
      stepDelta += this.randomGaussian(0, distanceBasedJitter);

      stepDelta = this.clamp(stepDelta, 8, 180);

      if (overshootAmount > 0 && i > numSteps * 0.75) {
        const overshootFraction = (i - numSteps * 0.75) / (numSteps * 0.25);
        stepDelta += overshootAmount * overshootFraction * 0.4;
      }

      if (scrollContainer.info.isWindow) {
        await this.page.mouse.wheel(0, direction * stepDelta);
      } else if (scrollContainer.containerHandle) {
        await scrollContainer.containerHandle.evaluate((el, delta) => {
          try {
            el.scrollTop += delta;
          } catch (e) {
            // Silent
          }
        }, direction * stepDelta);
      }

      // COHERENT FATIGUE: slower delays (multiply by fatigue)
      const baseDelay = (18 + Math.random() * 75) * this.config.fatigueMultiplier;
      const microPause = Math.random() < 0.12 ? Math.random() * 90 : 0;
      await this.randomDelay(baseDelay, baseDelay + microPause);

      if (Math.random() < 0.18) {
        await this.microMouseAdjustment();
      }
    }
  },

  async executeCorrectionScrollLogarithmic(targetScroll, direction, correctionSteps, scrollContainer, options) {
    const baseJitterStdDev = (options.scrollJitterStdDev ?? 18) / 2;
    const jitterStdDev = baseJitterStdDev * this.config.fatigueMultiplier;

    for (let i = 1; i <= correctionSteps; i++) {
      let currentScroll;

      if (scrollContainer.info.isWindow) {
        currentScroll = await this.getCurrentScrollY();
      } else if (scrollContainer.containerHandle) {
        currentScroll = await scrollContainer.containerHandle.evaluate(el => {
          try {
            return el.scrollTop;
          } catch (e) {
            return 0;
          }
        });
      } else {
        break;
      }

      const correctionDelta = Math.abs(targetScroll - currentScroll);
      if (correctionDelta < 8) break;

      const progress = i / correctionSteps;
      const logFactor = 1 - Math.log10(1 + 9 * progress);

      // COHERENT FATIGUE
      let stepDelta = (correctionDelta * logFactor * 0.4) / this.config.fatigueMultiplier;

      stepDelta += this.randomGaussian(0, jitterStdDev);
      stepDelta = this.clamp(stepDelta, 8, 130);

      if (scrollContainer.info.isWindow) {
        await this.page.mouse.wheel(0, -direction * stepDelta);
      } else if (scrollContainer.containerHandle) {
        await scrollContainer.containerHandle.evaluate((el, delta) => {
          try {
            el.scrollTop += delta;
          } catch (e) {
            // Silent
          }
        }, -direction * stepDelta);
      }

      await this.randomDelay(12 * this.config.fatigueMultiplier, 65 * this.config.fatigueMultiplier);
    }
  },
}
