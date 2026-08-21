export const ShyMousePointer = {
  async click(element, options = {}) {
    // 1. Verify element exists and has a bounding box
    let box = await this.getElementBoundingBox(element);
    if (!box) {
      throw new Error('Element bounding box unavailable');
    }

    // 2. Get viewport and scroll to element FIRST if not in viewport
    //    This fixes the deadlock where isElementClickable rejects off-screen elements
    //    before scrollToElement ever gets called
    let viewport = await this.getViewport();

    if (!(await this.isElementInViewport(element, options.visibilityBuffer ?? 50))) {
      try {
        await this.scrollToElement(element, options);
      } catch (error) {
        this.log('Scroll failed:', error.message);
      }
      await this.randomDelay(120, 250);

      // Re-get bounding box after scroll (position may have changed)
      box = await this.getElementBoundingBox(element);
      if (!box) {
        throw new Error('Element bounding box unavailable after scroll');
      }
    }

    // 3. NOW poll for clickability (element should be in viewport after scroll)
    const maxWaitTime = options.waitTimeout ?? 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      if (await this.isElementClickable(element)) {
        break;
      }
      await this.randomDelay(80, 180);
    }

    if (!await this.isElementClickable(element)) {
      throw new Error('Element is not clickable');
    }

    // 4. Wait for element stability
    const stableBox = await this.waitForElementStability(element, options.stabilityTimeout ?? 1500);
    if (!stableBox) {
      throw new Error('Element position is unstable');
    }

    // 5. Re-get viewport and bounding box after stability check
    viewport = await this.getViewport();
    box = await this.getElementBoundingBox(element);
    if (!box) {
      throw new Error('Element bounding box unavailable after stability check');
    }

    await this.humanReactionDelay();

    const clickTarget = this.calculateClickTarget(box, options);
    clickTarget.x = this.clamp(clickTarget.x, 0, viewport.width - 1);
    clickTarget.y = this.clamp(clickTarget.y, 0, viewport.height - 1);

    // NATURAL APPROACH: based on current trajectory
    const approachTarget = this.calculateNaturalApproachTarget(clickTarget, box, viewport);

    await this.moveToPosition(approachTarget.x, approachTarget.y, {
      ...options,
      isApproach: true
    });

    await this.randomDelay(120, 450);

    await this.moveToPosition(clickTarget.x, clickTarget.y, {
      ...options,
      numPoints: Math.max(3, Math.round(2 + Math.random() * 4))
    });

    if (!await this.isElementClickable(element)) {
      throw new Error('Element became unclickable');
    }

    // Pre-click state
    const preClickState = await element.evaluate(el => {
      try {
        return {
          className: el.className,
          disabled: el.disabled,
          ariaPressed: el.getAttribute('aria-pressed'),
          ariaExpanded: el.getAttribute('aria-expanded'),
        };
      } catch (e) {
        return null;
      }
    });

    // REALISTIC CLICK DURATION: 40-120ms (research-based)
    const clickDuration = Math.max(40, Math.round(this.randomGaussian(75, 20)));

    try {
      await this.page.mouse.down();
      await this.randomDelay(clickDuration, clickDuration + 15);
      await this.page.mouse.up();
    } catch (error) {
      throw new Error(`Click failed: ${error.message}`);
    }

    // Validate click
    if (options.validateClick !== false && preClickState) {

      // Quick check if element is still accessible (timeout 10ms)
      const navigationPromise = this.page.waitForNavigation({ timeout: 10 }).catch(() => null); // Detect quick nav
      const isElementAccessible = await Promise.race([
        navigationPromise,
        element.evaluate(el => el.isConnected).catch(() => false) // Simple check, fast fail if stale
      ]);

      if (isElementAccessible === null || !isElementAccessible) {
        this.log('Skipping validation: element removed or navigation occurred (click likely succeeded)');
      } else {

        await this.randomDelay(50, 150);

        let postClickState = null;
        try {
          postClickState = await element.evaluate(el => {
            try {
              return {
                className: el.className,
                disabled: el.disabled,
                ariaPressed: el.getAttribute('aria-pressed'),
                ariaExpanded: el.getAttribute('aria-expanded'),
              };
            } catch (e) {
              return null;
            }
          });
        } catch (error) {
          this.log('Post-click validation failed: element possibly removed or unavailable', error.message);
        }

        if (postClickState) {
          const stateChanged =
            preClickState.className !== postClickState.className ||
            preClickState.disabled !== postClickState.disabled ||
            preClickState.ariaPressed !== postClickState.ariaPressed ||
            preClickState.ariaExpanded !== postClickState.ariaExpanded;

          if (stateChanged) {
            this.log('Click validated: state changed');
          } else {
            this.log('Warning: No visible state change after click');
          }
        } else {
          this.log('Validation skipped: post-click state unavailable (click may have succeeded if element was removed)');
        }

      }

    }

    await this.postClickBehavior(clickTarget, viewport, options);

    this.lastPos = clickTarget;
    this.updateActionCount();
  },

  async clickAtPoint(x, y, options = {}) {
    const viewport = await this.getViewport();
    if (!this.lastPos) {
      this.initializePosition(viewport);
    }

    const targetX = this.clamp(x, 0, viewport.width - 1);
    const targetY = this.clamp(y, 0, viewport.height - 1);

    // Approach from the current trajectory, then settle on the target.
    const approach = this.calculateNaturalApproachTarget({ x: targetX, y: targetY }, null, viewport);
    await this.moveToPosition(approach.x, approach.y, { ...options, isApproach: true });
    await this.randomDelay(120, 420);

    await this.moveToPosition(targetX, targetY, {
      ...options,
      numPoints: Math.max(3, Math.round(2 + Math.random() * 4)),
    });

    await this.humanReactionDelay();

    const clickDuration = Math.max(40, Math.round(this.randomGaussian(75, 20)));
    try {
      await this.page.mouse.down();
      await this.randomDelay(clickDuration, clickDuration + 15);
      await this.page.mouse.up();
    } catch (error) {
      throw new Error(`clickAtPoint failed: ${error.message}`);
    }

    await this.postClickBehavior({ x: targetX, y: targetY }, viewport, options);

    this.lastPos = { x: targetX, y: targetY };
    this.updateActionCount();
    return { x: targetX, y: targetY };
  },

  async dragTo(x1, y1, x2, y2, options = {}) {
    const viewport = await this.getViewport();
    const sx = this.clamp(x1, 0, viewport.width - 1);
    const sy = this.clamp(y1, 0, viewport.height - 1);
    const ex = this.clamp(x2, 0, viewport.width - 1);
    const ey = this.clamp(y2, 0, viewport.height - 1);

    await this.moveToPosition(sx, sy, options);
    await this.humanReactionDelay();
    await this.page.mouse.down();
    await this.randomDelay(70, 150);

    // Overshoot the drop point a touch, then correct back — maximizes slider-match compatibility.
    const overshoot = this.clamp(ex + 12, 0, viewport.width - 1);
    await this.moveToPosition(overshoot, ey, { ...options, overshootProb: 0 });
    await this.randomDelay(40, 110);
    await this.moveToPosition(ex, ey, {
      ...options,
      overshootProb: 0,
      numPoints: Math.max(4, Math.round(3 + Math.random() * 4)),
    });
    await this.randomDelay(60, 160);

    await this.page.mouse.up();
    this.lastPos = { x: ex, y: ey };
    this.updateActionCount();
    return { x: ex, y: ey };
  },
}
