export const ShyMouseElements = {
  async getScrollContainer(element) {
    try {
      // Use evaluateHandle to get container reference without DOM modification
      const containerHandle = await element.evaluateHandle(el => {
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
              return parent;
            }

            parent = getComposedParentNode(parent);
            depth++;
          }

          return null; // Window scroll
        } catch (e) {
          return null;
        }
      });

      // Check if we got a valid container
      const isContainer = await containerHandle.evaluate(node => node !== null);

      if (isContainer) {
        // Get container info
        const containerInfo = await containerHandle.evaluate(container => {
          try {
            const rect = container.getBoundingClientRect();
            return {
              isWindow: false,
              scrollTop: container.scrollTop,
              scrollLeft: container.scrollLeft,
              scrollHeight: container.scrollHeight,
              scrollWidth: container.scrollWidth,
              clientHeight: container.clientHeight,
              clientWidth: container.clientWidth,
              rectTop: rect.top,
              rectLeft: rect.left,
              rectWidth: rect.width,
              rectHeight: rect.height,
            };
          } catch (e) {
            return null;
          }
        });

        if (containerInfo) {
          return {
            info: containerInfo,
            containerHandle: containerHandle
          };
        }
      }

      // Dispose handle if not used
      await containerHandle.dispose();

      // Window scroll fallback
      const viewport = await this.getViewport();
      return {
        info: {
          isWindow: true,
          scrollTop: viewport.scrollY,
          scrollLeft: viewport.scrollX,
          scrollHeight: viewport.documentHeight,
          scrollWidth: viewport.documentWidth,
          clientHeight: viewport.height,
          clientWidth: viewport.width,
        },
        containerHandle: null
      };
    } catch (error) {
      this.log('getScrollContainer failed:', error.message);
      const viewport = await this.getViewport();
      return {
        info: {
          isWindow: true,
          scrollTop: viewport.scrollY,
          scrollLeft: viewport.scrollX,
          scrollHeight: viewport.documentHeight,
          scrollWidth: viewport.documentWidth,
          clientHeight: viewport.height,
          clientWidth: viewport.width,
        },
        containerHandle: null
      };
    }
  },

  async isElementClickable(element) {
    try {
      return await element.evaluate(el => {
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

          // Helper: check if ancestor contains descendant across shadow boundaries
          function composedContains(ancestor, descendant) {
            let current = descendant;
            let depth = 0;
            while (current && depth < 100) {
              if (current === ancestor) return true;
              current = getComposedParentNode(current);
              depth++;
            }
            return false;
          }

          // Helper: elementFromPoint that penetrates open shadow roots
          function getComposedElementFromPoint(x, y) {
            let element = document.elementFromPoint(x, y);
            if (!element) return null;

            let depth = 0;
            while (element && element.shadowRoot && depth < 10) {
              const innerElement = element.shadowRoot.elementFromPoint(x, y);
              if (innerElement && innerElement !== element) {
                element = innerElement;
              } else {
                break;
              }
              depth++;
            }

            return element;
          }

          if (!el.isConnected) return false;

          const style = window.getComputedStyle(el);

          if (style.display === 'none') return false;
          if (style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity) < 0.1) return false;

          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;

          if (rect.bottom < 0 || rect.right < 0) return false;
          if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;

          if (style.pointerEvents === 'none') return false;
          if (el.disabled) return false;

          // Check pointer-events on ancestors (crosses shadow boundaries and slots)
          let ancestor = getComposedParentNode(el);
          let ancestorDepth = 0;
          while (ancestor && ancestorDepth < 100) {
            const ancestorStyle = window.getComputedStyle(ancestor);
            if (ancestorStyle.pointerEvents === 'none') return false;
            ancestor = getComposedParentNode(ancestor);
            ancestorDepth++;
          }

          // Multi-point sampling (center + 4 cardinal points + 4 corners)
          const samplingPoints = [
            { x: 0.5, y: 0.5 }, // Center
            { x: 0.3, y: 0.5 }, // Left
            { x: 0.7, y: 0.5 }, // Right
            { x: 0.5, y: 0.3 }, // Top
            { x: 0.5, y: 0.7 }, // Bottom
            { x: 0.3, y: 0.3 }, // Top-left
            { x: 0.7, y: 0.3 }, // Top-right
            { x: 0.3, y: 0.7 }, // Bottom-left
            { x: 0.7, y: 0.7 }, // Bottom-right
          ];

          let clickablePoints = 0;

          for (const point of samplingPoints) {
            const x = rect.left + rect.width * point.x;
            const y = rect.top + rect.height * point.y;

            // Use composed elementFromPoint that penetrates open shadow roots
            const topElement = getComposedElementFromPoint(x, y);

            if (topElement) {
              if (topElement === el || composedContains(el, topElement)) {
                clickablePoints++;
              } else {
                // Check if element is ancestor of topElement (crosses shadow boundaries)
                let current = topElement;
                let depth = 0;
                while (current && depth < 100) {
                  if (current === el) {
                    clickablePoints++;
                    break;
                  }
                  current = getComposedParentNode(current);
                  depth++;
                }
              }
            }
          }

          // At least 50% of sample points must be clickable
          return clickablePoints >= samplingPoints.length * 0.5;
        } catch (e) {
          return false;
        }
      });
    } catch (error) {
      this.log('isElementClickable failed:', error.message);
      return false;
    }
  },

  async isElementInViewport(element, buffer = 10) {
    try {
      const box = await this.getElementBoundingBox(element);
      if (!box) return false;

      const scrollContainer = await this.getScrollContainer(element);
      const viewport = await this.getViewport();

      if (scrollContainer.info.isWindow) {
        const viewTop = viewport.scrollY - buffer;
        const viewBottom = viewport.scrollY + viewport.height + buffer;
        const viewLeft = viewport.scrollX - buffer;
        const viewRight = viewport.scrollX + viewport.width + buffer;

        const hasVerticalOverlap = !(box.y + box.height < viewTop || box.y > viewBottom);
        const hasHorizontalOverlap = !(box.x + box.width < viewLeft || box.x > viewRight);

        return hasVerticalOverlap && hasHorizontalOverlap;
      } else {
        const inContainer = await element.evaluate((el, buff) => {
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

                const hasVerticalOverlap = !(elRect.bottom < parentRect.top - buff || elRect.top > parentRect.bottom + buff);
                const hasHorizontalOverlap = !(elRect.right < parentRect.left - buff || elRect.left > parentRect.right + buff);

                return hasVerticalOverlap && hasHorizontalOverlap;
              }

              parent = getComposedParentNode(parent);
              depth++;
            }

            return true;
          } catch (e) {
            return false;
          }
        }, buffer);

        // Dispose container handle if exists
        if (scrollContainer.containerHandle) {
          await scrollContainer.containerHandle.dispose().catch(() => {});
        }

        return inContainer;
      }
    } catch (error) {
      this.log('isElementInViewport failed:', error.message);
      return false;
    }
  },

  async getElementBoundingBox(element, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const box = await element.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          return box;
        }

        if (attempt < maxRetries - 1) {
          await this.randomDelay(50, 150);
        }
      } catch (error) {
        if (attempt === maxRetries - 1) {
          this.log(`Failed to get bounding box after ${maxRetries} attempts:`, error.message);
          return null;
        }
        await this.randomDelay(100, 200);
      }
    }
    return null;
  },
}
