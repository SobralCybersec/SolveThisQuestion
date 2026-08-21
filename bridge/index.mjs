import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { uploadImageWithFallback } from "./image-upload.mjs";
import { passCaptchaIfChallenged } from "./captcha.js";
import {
  askProxy,
  chat,
  embeddedCloseLogin,
  embeddedLogin,
  embeddedStatus,
  envBool,
  resetEmbeddedProxy,
} from "./chat-runtime.mjs";

const { applyStealthScripts, baseLaunchOptions, bridgeDebug, chromium } = await import("./rustproxyhub/browser-runtime.mjs");
const runtime = process.env.SCREEN_AGENT_RUNTIME || path.resolve(".runtime");
const captureDir = path.join(runtime, "captures");
let activeCaptureBrowser = null;

const BROWSER_PATH_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "brave-browser",
];

function firstOnPath(names) {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => path.join(directory, name)))
    .find((candidate) => existsSync(candidate));
}

function resolveCaptureExecutable() {
  return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/brave-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find((candidate) => existsSync(candidate)) || firstOnPath(BROWSER_PATH_NAMES);
}

function captureLaunchOptions() {
  const executablePath = resolveCaptureExecutable();
  const headless = envBool("SCREEN_AGENT_BROWSER_HEADLESS", true);
  return baseLaunchOptions({ headless, executablePath, engine: chromium });
}

async function waitForTargetReady(page) {
  await page.waitForLoadState("networkidle", { timeout: envMs("SCREEN_AGENT_NETWORK_IDLE_MS", 100) }).catch(() => {});
  const deadline = Date.now() + envMs("SCREEN_AGENT_CHALLENGE_WAIT_MS", 30_000);
  while (Date.now() < deadline) {
    const challenged = await page.evaluate(() => {
      const title = (document.title || "").toLowerCase();
      return title.includes("just a moment")
        || title.includes("checking your browser")
        || title.includes("verify you are human")
        || !!document.querySelector("#challenge-form, #challenge-running, #cf-chl-widget, iframe[src*='challenges.cloudflare.com']");
    }).catch(() => false);
    if (!challenged) return;
    await page.waitForTimeout(1000);
  }
}

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function resetCaptureBrowser() {
  const browser = activeCaptureBrowser;
  activeCaptureBrowser = null;
  if (browser) await browser.close().catch(() => {});
}

async function ensureCaptureBrowser() {
  if (activeCaptureBrowser?.isConnected()) return activeCaptureBrowser;
  await resetCaptureBrowser();
  activeCaptureBrowser = await chromium.launch(captureLaunchOptions());
  return activeCaptureBrowser;
}

async function uploadScreenshot(screenshot, required = false) {
  if (!required && !envBool("SCREEN_AGENT_IMGLINK_UPLOAD", false)) return { status: "disabled" };
  return uploadImageWithFallback(screenshot);
}

async function openTargetPage(page, targetUrl) {
  const pathname = new URL(targetUrl).pathname;
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(pathname)) {
    try {
      const response = await fetch(targetUrl, { redirect: "follow" });
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && contentType.startsWith("image/")) {
        const image = Buffer.from(await response.arrayBuffer()).toString("base64");
        await page.setContent(`<html><body style="margin:0;background:#111;display:grid;place-items:center"><img src="data:${contentType};base64,${image}" style="max-width:100vw;max-height:100vh;object-fit:contain" /></body></html>`, { waitUntil: "load" });
        return { url: targetUrl, direct_image: true };
      }
    } catch {}
  }
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  return { url: page.url(), direct_image: false };
}

async function analyze(command) {
  const startedAt = Date.now();
  const mark = (phase) => bridgeDebug(`capture timing phase=${phase} elapsed_ms=${Date.now() - startedAt}`);
  mark("start");
  await fs.mkdir(captureDir, { recursive: true });
  const browser = await ensureCaptureBrowser();
  mark("browser-ready");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await applyStealthScripts(context);
    const page = await context.newPage();
    const target = await openTargetPage(page, command.url);
    mark("target-ready");
    const captcha = await passCaptchaIfChallenged(page, {
      settleMs: envMs("SCREEN_AGENT_CAPTCHA_SETTLE_MS", 2500),
    });
    mark("captcha-check");
    await waitForTargetReady(page);
    await page.waitForFunction(() => Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 20 && rect.height > 20;
    }).every((image) => image.complete && image.naturalWidth > 0), undefined, {
      timeout: envMs("SCREEN_AGENT_IMAGE_WAIT_MS", 4000),
    }).catch(() => {});
    const settleMs = envMs("SCREEN_AGENT_CAPTURE_SETTLE_MS", 200);
    if (settleMs) await page.waitForTimeout(settleMs);
    const id = String(command.run_id || Date.now());
    const screenshot = path.join(captureDir, `${id}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    const screenshotSize = (await fs.stat(screenshot)).size;
    if (!screenshotSize) throw new Error("Browser screenshot was empty");
    const pageState = await page.evaluate((targetUrl) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const elements = Array.from(document.querySelectorAll("h1,h2,h3,h4,a,button,input,textarea,select,[role='button']"))
        .filter(visible)
        .slice(0, 80)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role") || "",
            text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 240),
            href: element instanceof HTMLAnchorElement ? element.href : "",
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
      return {
        title: document.title || "Direct image",
        url: targetUrl,
        viewport: { width: window.innerWidth, height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio },
        text: document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 12000) || "",
        elements,
        images: Array.from(document.images).slice(0, 24).map((image) => ({
          alt: image.alt || "",
          src: (image.currentSrc || image.src || "").startsWith("data:") ? targetUrl : (image.currentSrc || image.src || ""),
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        })),
      };
    }, target.url);
    mark("page-state-ready");
    const imageUpload = await uploadScreenshot(screenshot);
    mark("screenshot-ready");
    const result = await askProxy(command.prompt, pageState, screenshot, Boolean(command.web_search), imageUpload);
    mark("answer-ready");
    return { ...pageState, captcha, screenshot: `/captures/${id}.png`, screenshot_size: screenshotSize, image_upload: imageUpload, answer: result.text, image_analyzed: result.image, web_search: Boolean(command.web_search) };
  } finally {
    await context.close().catch(() => {});
  }
}

async function analyzeScreenshot(command) {
  const screenshot = path.resolve(command.image_path);
  const screenshotSize = (await fs.stat(screenshot)).size;
  if (!screenshotSize) throw new Error("Desktop screenshot was empty");
  const pageState = {
    title: "Desktop screenshot",
    url: "desktop://screen",
    text: "",
    elements: [],
    images: [],
    viewport: command.viewport || null,
  };
  // The embedded flow uploads this PNG straight into the ChatGPT page and an
  // external proxy gets it base64-inline, so ImgLink is optional context (a URL
  // hint in the prompt), never required. Respect the flag instead of forcing it.
  const imageUpload = await uploadScreenshot(screenshot);
  const result = await askProxy(command.prompt, pageState, screenshot, Boolean(command.web_search), imageUpload);
  return {
    ...pageState,
    screenshot: command.screenshot || screenshot,
    screenshot_size: screenshotSize,
    image_upload: imageUpload,
    answer: result.text,
    image_analyzed: result.image,
    web_search: Boolean(command.web_search),
  };
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await resetEmbeddedProxy();
    await resetCaptureBrowser();
    process.exit(0);
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const command = JSON.parse(line);
    const result = command.cmd === "login"
      ? await embeddedLogin()
      : command.cmd === "close_login"
        ? await embeddedCloseLogin()
      : command.cmd === "status"
        ? await embeddedStatus()
      : command.cmd === "analyze_screenshot"
          ? await analyzeScreenshot(command)
        : command.cmd === "chat"
          ? await chat(command)
        : await analyze(command);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

// stdin closed (parent asked us to exit): tear down the warm browser and the
// embedded proxy grandchild so the ChatGPT profile lock is released.
await resetEmbeddedProxy();
await resetCaptureBrowser();
