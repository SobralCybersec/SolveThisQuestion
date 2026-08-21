export const ShyMouseStability = {
  async waitForElementStability(element, timeout = 1500) {
    const startTime = Date.now();

    // Check for animations
    try {
      const hasAnimations = await element.evaluate(el => {
        try {
          const style = window.getComputedStyle(el);
          const hasTransition = style.transition !== 'all 0s ease 0s' && style.transition !== 'none';
          const hasAnimation = style.animation !== 'none';
          return hasTransition || hasAnimation;
        } catch (e) {
          return false;
        }
      });

      if (hasAnimations) {
        await this.randomDelay(300, 500);
      }
    } catch (error) {
      // Continue
    }

    // RAF-based stability check with guaranteed timeout
    const stabilityPromise = element.evaluate((el, timeoutMs) => {
      return new Promise((resolve) => {
        try {
          let lastChangeTime = Date.now();
          const startTime = Date.now();
          const requiredStableTime = 150; // ms of no changes
          let frameCount = 0;

          const observer = new MutationObserver(() => {
            lastChangeTime = Date.now();
          });

          observer.observe(el, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true
          });

          const checkStability = () => {
            const now = Date.now();
            const elapsed = now - startTime;
            const timeSinceChange = now - lastChangeTime;

            // Timeout exceeded
            if (elapsed > timeoutMs) {
              observer.disconnect();
              resolve(false);
              return;
            }

            // Stable for required time
            if (timeSinceChange >= requiredStableTime) {
              observer.disconnect();
              resolve(true);
              return;
            }

            frameCount++;
            requestAnimationFrame(checkStability);
          };

          requestAnimationFrame(checkStability);
        } catch (e) {
          resolve(false);
        }
      });
    }, timeout);

    // Race with timeout
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(false), timeout));
    const isStable = await Promise.race([stabilityPromise, timeoutPromise]);

    if (!isStable) {
      this.log('Stability check timed out or element unstable');
    }

    // Position stability check
    let lastBox = null;
    let stableCount = 0;
    const requiredStableChecks = 3;

    while (Date.now() - startTime < timeout) {
      try {
        const box = await element.boundingBox();
        if (!box) {
          await this.randomDelay(50, 100);
          continue;
        }

        if (lastBox) {
          const xDiff = Math.abs(box.x - lastBox.x);
          const yDiff = Math.abs(box.y - lastBox.y);
          const widthDiff = Math.abs(box.width - lastBox.width);
          const heightDiff = Math.abs(box.height - lastBox.height);

          if (xDiff < 1 && yDiff < 1 && widthDiff < 1 && heightDiff < 1) {
            stableCount++;
            if (stableCount >= requiredStableChecks) {
              return box;
            }
          } else {
            stableCount = 0;
          }
        }

        lastBox = box;
        await this.randomDelay(50, 100);
      } catch (error) {
        await this.randomDelay(100, 200);
      }
    }

    return lastBox;
  },

  async getCurrentScrollY() {
    try {
      return await this.page.evaluate(() => {
        try {
          return window.scrollY || window.pageYOffset || 0;
        } catch (e) {
          return 0;
        }
      });
    } catch (error) {
      return 0;
    }
  },
}
