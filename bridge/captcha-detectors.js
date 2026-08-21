// Captcha selectors and page-only detection helpers. Keeping browser queries
// separate leaves the action flow small and makes detection independently testable.

export const TURNSTILE_WIDGETS = [
  "iframe[src*='challenges.cloudflare.com']",
  ".cf-turnstile",
  ".cf-turnstile-wrapper",
  "#challenge-form div > div",
  "[data-testid*='challenge-'] div",
  "div#turnstile-widget div:not([class])",
  "ngx-turnstile div:not([class])",
  "[class*=spacer] + div div",
  ".spacer div:not([class])",
  "[id*='turnstile'] div:not([class])",
  "[class*='turnstile'] div:not([class])",
  "body > div#check > div:not([class])",
];
export const RECAPTCHA_WIDGETS = ["iframe[src*='recaptcha/api2/anchor']", "iframe[title*='recaptcha' i]"];
export const HCAPTCHA_WIDGETS = [
  "iframe[src*='hcaptcha.com'][title*='checkbox' i]",
  "iframe[src*='newassets.hcaptcha.com'][title*='checkbox' i]",
  "iframe[data-hcaptcha-widget-id]",
  "iframe[src*='hcaptcha.com']",
  ".h-captcha",
];
export const FRIENDLY_WIDGETS = ["iframe[data--frc-frame-id]", ".frc-captcha"];
export const DATADOME_IFRAME =
  "body > iframe[src*='geo.captcha-delivery.com/captcha/'], body > iframe[src*='geo.captcha-delivery.com/interstitial/']";

export const CHECKBOX_OFFSET = {
  turnstile_iframe: { x: 30, y: 30 },
  turnstile_div: { x: 25, y: 32 },
  recaptcha: { x: 26, y: 35 },
  hcaptcha: { x: 30, y: 36 },
  friendly: { x: 27, y: 34 },
};

export async function cloudflareInterstitial(page) {
  return page
    .evaluate(() => {
      const t = (document.title || "").toLowerCase();
      return (
        t.includes("just a moment") ||
        t.includes("um momento") ||
        t.includes("verificando") ||
        !!document.querySelector(
          "#challenge-form, #challenge-running, #cf-chl-widget, script[src*='challenge-platform']",
        )
      );
    })
    .catch(() => false);
}

export async function turnstilePending(page) {
  return page
    .evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      const widget = document.querySelector(
        ".cf-turnstile, iframe[src*='challenges.cloudflare.com'], [data-callback='onCaptchaSuccess'], " +
          "[id^='cf-chl-widget'], #cf-box-container [id^='cf-chl-widget']",
      );
      return (!!widget || !!el) && !(el && el.value);
    })
    .catch(() => false);
}

export async function recaptchaCheckboxPresent(page) {
  return page
    .evaluate(
      () =>
        !!document.querySelector(
          "iframe[src*='recaptcha/api2/anchor'], iframe[title*='recaptcha' i]",
        ),
    )
    .catch(() => false);
}

export async function hcaptchaCheckboxPresent(page) {
  return page
    .evaluate(
      () =>
        !!document.querySelector(
          "iframe[src*='hcaptcha.com'][title*='checkbox' i], iframe[src*='newassets.hcaptcha.com'][title*='checkbox' i], iframe[data-hcaptcha-widget-id], iframe[src*='_Incapsula_Resource?']",
        ),
    )
    .catch(() => false);
}

export async function friendlyPresent(page) {
  return page
    .evaluate(() => !!document.querySelector("iframe[data--frc-frame-id], .frc-captcha"))
    .catch(() => false);
}

export async function datadomeSliderPresent(page) {
  return page.evaluate((sel) => !!document.querySelector(sel), DATADOME_IFRAME).catch(() => false);
}

export async function imageChallengeOpen(page) {
  return page
    .evaluate(() => {
      const rc = document.querySelector("iframe[src*='recaptcha/api2/bframe']");
      const hc = document.querySelector("iframe[src*='hcaptcha.com'][title*='challenge' i]");
      const visible = (el) => el && el.getBoundingClientRect().height > 40;
      return visible(rc) || visible(hc);
    })
    .catch(() => false);
}

export async function normalizeTurnstileAlignment(page) {
  await page
    .evaluate(() => {
      const rw = (attr, from, to) => (attr || "").split(from).join(to);
      try {
        for (const el of document.querySelectorAll("form[class], form div[class]")) {
          const c = el.getAttribute("class") || "";
          if (c.includes("center") || c.includes("right")) {
            el.setAttribute("class", rw(rw(c, "center", "left"), "right", "left"));
          }
        }
        for (const el of document.querySelectorAll(
          "form[style], form div[style], [style*='text-align: center']",
        )) {
          const s = el.getAttribute("style") || "";
          if (s.includes("center") || s.includes("right")) {
            el.setAttribute("style", rw(rw(s, "center", "left"), "right", "left"));
          }
        }
        for (const el of document.querySelectorAll(
          "form [id*='turnstile'], form [class*='turnstile']",
        )) {
          el.setAttribute("align", "left");
        }
      } catch {}
    })
    .catch(() => {});
}

export async function firstVisibleWidget(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if (!(await loc.count())) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      const box = await loc.boundingBox();
      if (box && box.width >= 10 && box.height >= 10) return { box, selector: sel };
    } catch {}
  }
  return null;
}

export function isInvisibleBadge(box, vw, vh) {
  return box.x > 1040 && box.y > 640 && Math.abs(vw - box.x) < 140 && Math.abs(vh - box.y) < 140;
}
