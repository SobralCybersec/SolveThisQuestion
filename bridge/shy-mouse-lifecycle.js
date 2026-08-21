export const ShyMouseLifecycle = {
  setupNavigationListener() {
    try {
      this.page.on('framenavigated', () => {
        this.invalidateViewportCache();
        this.log('Frame navigated');
      });
    } catch (error) {
      this.log('Navigation listener failed:', error.message);
    }
  },

  setupConsoleLogger() {
    if (this.config.debug) {
      try {
        this.page.on('console', msg => {
          console.log('[Page]', msg.type(), msg.text());
        });
      } catch (error) {
        // Silent
      }
    }
  },

  log(...args) {
    if (this.config.debug) {
      console.log('[ShyMouse]', new Date().toISOString().substr(11, 12), ...args);
    }
  },

  async getViewport(retries = 2) {
    const now = Date.now();

    if (this.cachedViewport && (now - this.viewportCacheTime) < this.viewportCacheDuration) {
      return this.cachedViewport;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const viewportInfo = await this.page.evaluate(() => {
          try {
            return {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: window.scrollX || window.pageXOffset || 0,
              scrollY: window.scrollY || window.pageYOffset || 0,
              devicePixelRatio: window.devicePixelRatio || 1,
              documentWidth: Math.max(
                document.documentElement.scrollWidth || 0,
                document.documentElement.offsetWidth || 0,
                document.documentElement.clientWidth || 0,
                document.body?.scrollWidth || 0,
                document.body?.offsetWidth || 0
              ),
              documentHeight: Math.max(
                document.documentElement.scrollHeight || 0,
                document.documentElement.offsetHeight || 0,
                document.documentElement.clientHeight || 0,
                document.body?.scrollHeight || 0,
                document.body?.offsetHeight || 0
              ),
            };
          } catch (e) {
            return null;
          }
        });

        if (viewportInfo) {
          this.cachedViewport = viewportInfo;
          this.viewportCacheTime = now;
          return viewportInfo;
        }

        if (attempt < retries) {
          await this.randomDelay(50, 100);
        }
      } catch (error) {
        this.log(`getViewport attempt ${attempt + 1} failed:`, error.message);
        if (attempt < retries) {
          await this.randomDelay(100, 200);
        }
      }
    }

    this.log('Using fallback viewport');
    const fallback = {
      width: 1920,
      height: 1080,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      documentWidth: 1920,
      documentHeight: 1080,
    };

    this.cachedViewport = fallback;
    this.viewportCacheTime = now - (this.viewportCacheDuration - 500);

    return fallback;
  },

  invalidateViewportCache() {
    this.cachedViewport = null;
    this.viewportCacheTime = 0;
  },

  async getElementFrame(element) {
    try {
      const frame = await element.ownerFrame();
      return frame || this.page.mainFrame();
    } catch (error) {
      this.log('getElementFrame failed:', error.message);
      return this.page.mainFrame();
    }
  },
}
