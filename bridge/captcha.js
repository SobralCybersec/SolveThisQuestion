// Full keyless, no-cost captcha handling for the patchright worker — no third-party solver API.
// Ports SeleniumBase's CDP-mode keyless mechanisms (sb_cdp.py __click_captcha / solve_captcha):
// checkbox CLICK for Cloudflare Turnstile, Google reCAPTCHA v2, hCaptcha/Incapsula, and Friendly
// Captcha, plus a DataDome SLIDER drag. In 2026 keyless still beats paid tokens on Turnstile &
// DataDome (they fingerprint-reject solver tokens) — the win is behaving human from a browser that
// already passes fingerprinting, not buying a solve.
//
// The checkbox lives in a cross-origin iframe; we click its SCREEN POSITION (outer-widget box +
// offset) with ShyMouse (coordinate-level humanized mouse → CDP Input; the real OS pointer never
// moves). Selector chains + offsets + the left-align normalization are ported from SeleniumBase
// (browser_launcher.py:1434-1533, sb_cdp.py:2602-2778).
//
// HONEST LIMIT: there is NO keyless image-grid / rotate-puzzle solver here — none exists free, not
// even in SeleniumBase (it relies on stealth so the grid never opens). When a real image/rotate
// challenge opens, we detect it and hand off to a human. No paid solver, no local vision model.
//
// Key: captchaSolvingEnabled — gated by env HIREMEOPS_AUTO_CAPTCHA
// Key: passCaptchaOnPage — detects the challenge type and runs the matching keyless solve.

import { getShyMouse } from "./shy-mouse.js";

const enabled = () => /^(1|true|yes|on)$/i.test(process.env.HIREMEOPS_AUTO_CAPTCHA || "");

export function captchaSolvingEnabled() {
  return enabled();
}

// --- Widget selector chains on the MAIN page (we click the widget's position) ---
// Turnstile: iframe first (proven), then the div-wrapper chain ported from SeleniumBase.
const TURNSTILE_WIDGETS = [
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
const RECAPTCHA_WIDGETS = ["iframe[src*='recaptcha/api2/anchor']", "iframe[title*='recaptcha' i]"];
const HCAPTCHA_WIDGETS = [
  "iframe[src*='hcaptcha.com'][title*='checkbox' i]",
  "iframe[src*='newassets.hcaptcha.com'][title*='checkbox' i]",
  "iframe[data-hcaptcha-widget-id]",
  "iframe[src*='hcaptcha.com']",
  ".h-captcha",
];
const FRIENDLY_WIDGETS = ["iframe[data--frc-frame-id]", ".frc-captcha"];
const DATADOME_IFRAME =
  "body > iframe[src*='geo.captcha-delivery.com/captcha/'], body > iframe[src*='geo.captcha-delivery.com/interstitial/']";

// Checkbox offset from the widget top-left, in CSS px (SeleniumBase Linux constants). Small jitter
// added per click. iframe hits use a slightly larger x (the iframe includes its own padding).
const CHECKBOX_OFFSET = {
  turnstile_iframe: { x: 30, y: 30 },
  turnstile_div: { x: 25, y: 32 },
  recaptcha: { x: 26, y: 35 },
  hcaptcha: { x: 30, y: 36 },
  friendly: { x: 27, y: 34 },
};

export async function humanize(page) {
  try {
    const shy = getShyMouse(page);
    await shy.move();
    await shy.move();
  } catch {
    const rnd = (min, max) => Math.floor(Math.random() * (max - min) + min);
    try {
      for (let i = 0; i < 2; i++) {
        await page.mouse.move(rnd(120, 800), rnd(120, 560), { steps: rnd(6, 22) });
        await page.waitForTimeout(rnd(180, 460));
      }
    } catch {}
  }
}

// --- Detection (page-source / element based, mirrors sb_cdp.py) ---
async function cloudflareInterstitial(page) {
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

async function turnstilePending(page) {
  return page
    .evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      const widget = document.querySelector(
        ".cf-turnstile, iframe[src*='challenges.cloudflare.com'], [data-callback='onCaptchaSuccess'], " +
          // Indeed/managed-challenge shape: the response input mounts with a
          // `cf-chl-widget-*` id inside #cf-box-container before the iframe loads.
          "[id^='cf-chl-widget'], #cf-box-container [id^='cf-chl-widget']",
      );
      // A mounted response input with no token yet IS a pending Turnstile, even
      // before the challenges.cloudflare.com iframe has been injected.
      return (!!widget || !!el) && !(el && el.value);
    })
    .catch(() => false);
}

async function recaptchaCheckboxPresent(page) {
  return page
    .evaluate(
      () =>
        !!document.querySelector(
          "iframe[src*='recaptcha/api2/anchor'], iframe[title*='recaptcha' i]",
        ),
    )
    .catch(() => false);
}

async function hcaptchaCheckboxPresent(page) {
  return page
    .evaluate(
      () =>
        !!document.querySelector(
          "iframe[src*='hcaptcha.com'][title*='checkbox' i], iframe[src*='newassets.hcaptcha.com'][title*='checkbox' i], iframe[data-hcaptcha-widget-id], iframe[src*='_Incapsula_Resource?']",
        ),
    )
    .catch(() => false);
}

async function friendlyPresent(page) {
  return page
    .evaluate(() => !!document.querySelector("iframe[data--frc-frame-id], .frc-captcha"))
    .catch(() => false);
}

async function datadomeSliderPresent(page) {
  return page.evaluate((sel) => !!document.querySelector(sel), DATADOME_IFRAME).catch(() => false);
}

async function imageChallengeOpen(page) {
  return page
    .evaluate(() => {
      const rc = document.querySelector("iframe[src*='recaptcha/api2/bframe']");
      const hc = document.querySelector("iframe[src*='hcaptcha.com'][title*='challenge' i]");
      const visible = (el) => el && el.getBoundingClientRect().height > 40;
      return visible(rc) || visible(hc);
    })
    .catch(() => false);
}

// Left-align a center/right-aligned Turnstile so the checkbox sits at a predictable left position
// (ported from sb_cdp.py:2687-2768). No-op if the widget is already left-aligned.
async function normalizeTurnstileAlignment(page) {
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

// First visible widget box on the main page, scrolled into view so the click lands on-screen.
// Returns { box, selector } or null.
async function firstVisibleWidget(page, selectors) {
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

// Skip Google's invisible reCAPTCHA badge (bottom-right corner) — clicking it does nothing.
function isInvisibleBadge(box, vw, vh) {
  return box.x > 1040 && box.y > 640 && Math.abs(vw - box.x) < 140 && Math.abs(vh - box.y) < 140;
}

// Humanized coordinate click on a checkbox at widget-box + offset (with jitter).
async function clickCheckbox(page, shy, selectors, offsetFor) {
  const hit = await firstVisibleWidget(page, selectors);
  if (!hit) return false;
  const offset = typeof offsetFor === "function" ? offsetFor(hit.selector) : offsetFor;
  const jitter = (n) => n + (Math.random() * 6 - 3);
  const x = hit.box.x + jitter(offset.x);
  const y = hit.box.y + Math.min(hit.box.height - 6, jitter(offset.y));
  try {
    await shy.clickAtPoint(x, y);
    return true;
  } catch {
    return false;
  }
}

// DataDome slider: patchright can read INTO the cross-origin captcha iframe (CDP frame access), so
// we get the slider handle + target boxes directly and drag between them — no new tab, no GUI.
async function solveDataDomeSlider(page, shy) {
  try {
    const frame = page.frameLocator(DATADOME_IFRAME);
    const slider = frame.locator("div.slider, [class*='slider']:not([class*='Target'])").first();
    const target = frame.locator("div.sliderTarget, [class*='sliderTarget']").first();
    await slider.waitFor({ state: "visible", timeout: 4_000 });
    const sb = await slider.boundingBox();
    const tb = (await target.boundingBox().catch(() => null)) || null;
    if (!sb) return false;
    const sx = sb.x + sb.width / 2;
    const sy = sb.y + sb.height / 2;
    // If we can read the target, drag to it; else drag most of the iframe width (typical slider run).
    const ex = tb ? tb.x + tb.width / 2 : sx + 260;
    const ey = tb ? tb.y + tb.height / 2 : sy;
    await shy.dragTo(sx, sy, ex, ey);
    return true;
  } catch {
    return false;
  }
}

export async function passCaptchaOnPage(page) {
  if (!enabled())
    return { solved: false, reason: "auto-captcha off (set HIREMEOPS_AUTO_CAPTCHA=1)" };

  const shy = getShyMouse(page);

  // 1) Cloudflare full-page interstitial ("Just a moment" / Indeed "Additional
  // Verification Required"): a MANAGED challenge. Behave human and wait — a
  // trusted (headed) browser auto-solves most of these. If Cloudflare escalates
  // it to an interactive Turnstile checkbox mid-wait, click it (managed→interactive).
  if (await cloudflareInterstitial(page)) {
    await humanize(page);
    const offsetFor = (sel) =>
      sel.includes("iframe") ? CHECKBOX_OFFSET.turnstile_iframe : CHECKBOX_OFFSET.turnstile_div;
    let clickedTs = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1_000);
      if (!(await cloudflareInterstitial(page))) return { solved: true, kind: "cloudflare" };
      // Escalation: an interactive Turnstile appeared — click it once (then keep
      // waiting for the token to clear the interstitial).
      if (!clickedTs && i >= 2 && (await turnstilePending(page))) {
        await normalizeTurnstileAlignment(page);
        clickedTs = await clickCheckbox(page, shy, TURNSTILE_WIDGETS, offsetFor);
      }
    }
    return {
      solved: false,
      kind: "cloudflare",
      reason: "interstitial did not clear (human needed)",
    };
  }

  // 2) DataDome slider: drag the handle to its target.
  if (await datadomeSliderPresent(page)) {
    await humanize(page);
    let dragged = await solveDataDomeSlider(page, shy);
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1_000);
      if (!(await datadomeSliderPresent(page))) return { solved: true, kind: "datadome", dragged };
      if (i === 5) dragged = (await solveDataDomeSlider(page, shy)) || dragged;
    }
    return {
      solved: false,
      kind: "datadome",
      dragged,
      reason: "slider did not clear (human needed)",
    };
  }

  // 3) Cloudflare Turnstile widget: left-align, then humanized CLICK on the checkbox; wait for token.
  if (await turnstilePending(page)) {
    await humanize(page);
    await normalizeTurnstileAlignment(page);
    const offsetFor = (sel) =>
      sel.includes("iframe") ? CHECKBOX_OFFSET.turnstile_iframe : CHECKBOX_OFFSET.turnstile_div;
    let clicked = await clickCheckbox(page, shy, TURNSTILE_WIDGETS, offsetFor);
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1_000);
      if (!(await turnstilePending(page))) return { solved: true, kind: "turnstile", clicked };
      if (i === 7)
        clicked = (await clickCheckbox(page, shy, TURNSTILE_WIDGETS, offsetFor)) || clicked;
    }
    return {
      solved: false,
      kind: "turnstile",
      clicked,
      reason: clicked
        ? "token not issued after click (human needed)"
        : "checkbox not found (human needed)",
    };
  }

  // 4) Google reCAPTCHA v2 checkbox: humanized coordinate click (skip the invisible badge); fall
  //    back to the in-frame anchor click. Bail to human when the image grid opens.
  if (await recaptchaCheckboxPresent(page)) {
    await humanize(page);
    const hit = await firstVisibleWidget(page, RECAPTCHA_WIDGETS);
    const vp = await page.viewportSize().catch(() => null);
    if (hit && vp && isInvisibleBadge(hit.box, vp.width, vp.height)) {
      return {
        solved: false,
        kind: "recaptcha_v2",
        reason: "invisible reCAPTCHA badge (nothing to click)",
      };
    }
    let clicked = await clickCheckbox(page, shy, RECAPTCHA_WIDGETS, CHECKBOX_OFFSET.recaptcha);
    if (!clicked) {
      try {
        await page
          .frameLocator("iframe[src*='recaptcha/api2/anchor'], iframe[title*='recaptcha' i]")
          .locator("#recaptcha-anchor")
          .click({ timeout: 5_000 });
        clicked = true;
      } catch {}
    }
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1_000);
      const checked = await page
        .frameLocator("iframe[src*='recaptcha/api2/anchor'], iframe[title*='recaptcha' i]")
        .locator("#recaptcha-anchor")
        .getAttribute("aria-checked")
        .catch(() => null);
      if (checked === "true") return { solved: true, kind: "recaptcha_v2", clicked };
      if (await imageChallengeOpen(page))
        return { solved: false, kind: "recaptcha_v2", reason: "image grid opened (human needed)" };
    }
    return {
      solved: false,
      kind: "recaptcha_v2",
      clicked,
      reason: "checkbox did not confirm (human needed)",
    };
  }

  // 5) hCaptcha / Incapsula checkbox: humanized coordinate click, watch for token or challenge panel.
  if (await hcaptchaCheckboxPresent(page)) {
    await humanize(page);
    let clicked = await clickCheckbox(page, shy, HCAPTCHA_WIDGETS, CHECKBOX_OFFSET.hcaptcha);
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1_000);
      if (await imageChallengeOpen(page))
        return { solved: false, kind: "hcaptcha", reason: "challenge opened (human needed)" };
      const token = await page
        .evaluate(() => {
          const el = document.querySelector(
            'textarea[name="h-captcha-response"], [name="h-captcha-response"]',
          );
          return !!(el && el.value);
        })
        .catch(() => false);
      if (token) return { solved: true, kind: "hcaptcha", clicked };
      if (i === 5)
        clicked =
          (await clickCheckbox(page, shy, HCAPTCHA_WIDGETS, CHECKBOX_OFFSET.hcaptcha)) || clicked;
    }
    return {
      solved: false,
      kind: "hcaptcha",
      clicked,
      reason: clicked
        ? "token not issued after click (human needed)"
        : "checkbox not found (human needed)",
    };
  }

  // 6) Friendly Captcha: humanized checkbox click (it self-completes a proof-of-work after).
  if (await friendlyPresent(page)) {
    await humanize(page);
    const clicked = await clickCheckbox(page, shy, FRIENDLY_WIDGETS, CHECKBOX_OFFSET.friendly);
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1_000);
      const done = await page
        .evaluate(() => {
          const el = document.querySelector(".frc-captcha-solution, [name='frc-captcha-solution']");
          return !!(el && (el.value || el.getAttribute("value")));
        })
        .catch(() => false);
      if (done) return { solved: true, kind: "friendly", clicked };
    }
    return {
      solved: false,
      kind: "friendly",
      clicked,
      reason: "solution not issued (human needed)",
    };
  }

  return { solved: false, reason: "no keyless-passable challenge found (human fallback)" };
}

// Detect a Cloudflare / bot-wall interstitial or widget on the current page —
// the "verify you're human" / "Just a moment" gate (PT-BR + EN). Shared by every
// scraper/apply flow so the detection logic lives in ONE place. Best-effort:
// any evaluate failure (navigation mid-check) reads as "not challenged".
export async function isCloudflareChallenge(page) {
  return page
    .evaluate(() => {
      if (
        document.querySelector(
          "#challenge-form, #challenge-stage, #challenge-running, #cf-chl-widget, " +
            '[id^="cf-chl-widget"], input[name="cf-turnstile-response"], ' +
            'input[name="cf_challenge_response"], #px-captcha, ' +
            'script[src*="challenges.cloudflare.com/turnstile"], ' +
            'iframe[src*="challenges.cloudflare.com"], ' +
            'iframe[src*="recaptcha/api2/anchor"], iframe[title*="recaptcha" i], ' +
            'iframe[src*="hcaptcha.com"], iframe[data-hcaptcha-widget-id], .h-captcha, ' +
            'iframe[data--frc-frame-id], .frc-captcha, ' +
            'body > iframe[src*="geo.captcha-delivery.com/captcha/"], ' +
            'body > iframe[src*="geo.captcha-delivery.com/interstitial/"]',
        )
      )
        return true;
      const t = (document.title || "").toLowerCase();
      if (/just a moment|um momento|aguarde|checking your browser/.test(t)) return true;
      const body = (document.body?.innerText || "").toLowerCase();
      return /verif\w* (que )?voc[eê] [eé] humano|confirme que voc[eê] [eé] um humano|antes de continuar|verificando se a conex[aã]o|precisamos verificar se voc[eê]|verify you are human|checking your browser|additional verification/.test(
        body,
      );
    })
    .catch(() => false);
}

// If the page is sitting on a CAPTCHA/bot wall, run the keyless auto-pass and
// wait for it to clear. Returns { challenged, solved }. No-op (challenged:false)
// when there's no wall, so it's safe to call after every navigation. Honours the
// same HIREMEOPS_AUTO_CAPTCHA gate as passCaptchaOnPage (off → pauses for human).
export async function passCaptchaIfChallenged(page, { settleMs = 2_500 } = {}) {
  if (!(await isCloudflareChallenge(page))) return { challenged: false, solved: true };
  await passCaptchaOnPage(page).catch(() => {});
  await page.waitForTimeout(settleMs).catch(() => {});
  const still = await isCloudflareChallenge(page);
  return { challenged: true, solved: !still };
}
