import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { uploadImageWithFallback } from "./image-upload.mjs";

const { chromium } = await import("playwright");
const runtime = process.env.SCREEN_AGENT_RUNTIME || path.resolve(".runtime");
const captureDir = path.join(runtime, "captures");
const embeddedBridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "rustproxyhub/index.mjs");
let activeEmbeddedProxy = null;

function envBool(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  return value == null || value === "" ? fallback : !["0", "false", "no", "off"].includes(value);
}

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
  const args = process.platform === "linux" ? ["--disable-dev-shm-usage"] : [];
  if (process.platform === "linux" && process.getuid?.() === 0) args.unshift("--no-sandbox");
  const executablePath = resolveCaptureExecutable();
  return {
    headless: envBool("SCREEN_AGENT_BROWSER_HEADLESS", true),
    ...(executablePath ? { executablePath } : {}),
    ...(args.length ? { args } : {}),
  };
}

async function uploadScreenshot(screenshot, required = false) {
  if (!required && !envBool("SCREEN_AGENT_IMGLINK_UPLOAD", false)) return { status: "disabled" };
  return uploadImageWithFallback(screenshot);
}

function buildPrompt(prompt, pageState, imageUpload, webSearch = false) {
  const normalizedPrompt = prompt.replace(/@WebSearch\b/gi, "@Web search");
  const preparedPrompt = webSearch && !/@Web search\s*$/i.test(normalizedPrompt.trim())
    ? `${normalizedPrompt.trim()}\n\n@Web search`
    : normalizedPrompt;
  const upload = imageUpload?.url || "local capture only";
  if (pageState.url === "desktop://screen") {
    // The screenshot is attached to the message directly; only add an upload
    // line when there's a real hosted URL worth referencing.
    const replaced = preparedPrompt.replace(/Screenshot upload:\s*\[uploaded image\]/i, `Screenshot upload: ${upload}`);
    if (imageUpload?.url && !replaced.includes(imageUpload.url)) return `${replaced}\n\nScreenshot upload: ${imageUpload.url}`;
    return replaced;
  }
  return `${preparedPrompt}\n\nPage URL: ${pageState.url}\nPage text:\n${pageState.text}\n\nPage elements:\n${JSON.stringify(pageState.elements || [])}\n\nVisible image inventory:\n${JSON.stringify(pageState.images || [])}\n\nScreenshot upload: ${upload}`;
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
  await fs.mkdir(captureDir, { recursive: true });
    const browser = await chromium.launch(captureLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const target = await openTargetPage(page, command.url);
    await page.waitForFunction(() => Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 20 && rect.height > 20;
    }).every((image) => image.complete && image.naturalWidth > 0), undefined, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(300);
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
    const imageUpload = await uploadScreenshot(screenshot);
    const result = await askProxy(command.prompt, pageState, screenshot, Boolean(command.web_search), imageUpload);
    return { ...pageState, screenshot: `/captures/${id}.png`, screenshot_size: screenshotSize, image_upload: imageUpload, answer: result.text, image_analyzed: result.image, web_search: Boolean(command.web_search) };
  } finally {
    await browser.close();
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

async function askProxy(prompt, pageState, screenshot, webSearch, imageUpload) {
  const proxy = (process.env.RUST_PROXY_HUB_URL || process.env.GPT_PROXY_URL)?.replace(/\/$/, "");
  if (!proxy) {
    return askEmbeddedProxy(prompt, pageState, screenshot, webSearch, imageUpload);
  }
  const image = (await fs.readFile(screenshot)).toString("base64");
  const apiKey = process.env.RUST_PROXY_HUB_API_KEY || process.env.GPT_PROXY_API_KEY;
  const model = process.env.GPT_PROXY_MODEL || "chatgpt:chatgpt-web-session";
  const chatgptMode = process.env.GPT_PROXY_CHATGPT_MODE || "web";
  const sessionId = process.env.GPT_PROXY_SESSION_ID;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240000);
  let response;
  try {
    response = await fetch(`${proxy}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        ...(sessionId ? { user: sessionId } : {}),
        chatgpt_mode: chatgptMode,
        web_search: webSearch,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: buildPrompt(prompt, pageState, imageUpload, webSearch) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
          ],
        }],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`GPT proxy returned ${response.status}: ${raw.slice(0, 400)}`);
  const payload = JSON.parse(raw);
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return { text: content, image: true };
  if (Array.isArray(content)) return { text: content.map((part) => part?.text || "").join("").trim(), image: true };
  return { text: "Proxy returned an empty answer.", image: true };
}

function startEmbeddedProxy() {
  const child = spawn(process.execPath, [embeddedBridge], {
    cwd: path.dirname(embeddedBridge),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          const request = pending.get(message.id);
          if (request && !message.event) {
            pending.delete(message.id);
            message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
          }
        } catch (error) {
          rejectAll(error instanceof Error ? error : new Error(String(error)));
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[embedded-proxy] ${chunk}`));
  child.on("error", rejectAll);
  child.on("exit", (code) => {
    if (pending.size) rejectAll(new Error(`embedded proxy exited with code ${code}`));
  });
  const waitForExit = () => child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
  const waitForExitOrTimeout = () => Promise.race([
    waitForExit(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  return {
    call(provider, method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, provider, method, params })}\n`);
      });
    },
    async close() {
      try { await this.call("chatgpt", "shutdown"); } catch {}
      child.stdin.end();
      await waitForExitOrTimeout();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForExitOrTimeout();
      }
    },
  };
}

// Keep one embedded proxy (and its logged-in ChatGPT browser) warm for the life
// of the bridge process so captures don't relaunch Chromium every time.
async function ensureEmbeddedProxy() {
  await fs.mkdir(runtime, { recursive: true });
  if (!activeEmbeddedProxy) activeEmbeddedProxy = startEmbeddedProxy();
  await activeEmbeddedProxy.call("chatgpt", "init", {
    runtime_dir: runtime,
    headless: envBool("SCREEN_AGENT_CHATGPT_HEADLESS", true),
    browser: "chromium",
  });
  return activeEmbeddedProxy;
}

async function resetEmbeddedProxy() {
  const proxy = activeEmbeddedProxy;
  activeEmbeddedProxy = null;
  if (proxy) await proxy.close().catch(() => {});
}

async function askEmbeddedProxy(prompt, pageState, screenshot, webSearch, imageUpload) {
  const proxy = await ensureEmbeddedProxy();
  const params = {
    model: process.env.GPT_PROXY_MODEL || "chatgpt:chatgpt-web-session",
    chatgpt_mode: process.env.GPT_PROXY_CHATGPT_MODE || "web",
    session_id: process.env.GPT_PROXY_SESSION_ID || "screen-agent",
    prompt: buildPrompt(prompt, pageState, imageUpload, webSearch),
    web_search: webSearch,
    stream: false,
    runtime_dir: runtime,
    browser: "chromium",
    image_path: screenshot,
    headless: envBool("SCREEN_AGENT_IMAGE_HEADLESS", true),
  };
  try {
    let result;
    try {
      result = await proxy.call("chatgpt", "chat_image", params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[embedded-proxy] image chat failed: ${message}\n`);
      if (/ChatGPT image response was empty/i.test(message)) throw error;
      result = await proxy.call("chatgpt", "chat", params);
    }
    return { text: result?.text || "Embedded proxy returned an empty answer.", image: Boolean(result?.image) };
  } catch (error) {
    // Proxy may be wedged or its browser dead — drop it so the next call respawns clean.
    await resetEmbeddedProxy();
    throw error;
  }
}

async function embeddedStatus() {
  await fs.mkdir(runtime, { recursive: true });
  // Reuse an already-warm proxy without re-init (never relaunch a visible login
  // browser); otherwise warm and keep one so the following capture reuses it.
  if (!activeEmbeddedProxy) {
    activeEmbeddedProxy = startEmbeddedProxy();
    await activeEmbeddedProxy
      .call("chatgpt", "init", {
        runtime_dir: runtime,
        headless: envBool("SCREEN_AGENT_CHATGPT_HEADLESS", true),
        browser: "chromium",
      })
      .catch(() => {});
  }
  return activeEmbeddedProxy.call("chatgpt", "status", {
    runtime_dir: runtime,
    browser: "chromium",
  });
}

async function embeddedLogin() {
  await fs.mkdir(runtime, { recursive: true });
  // Login must own the dedicated profile from a clean browser process. This
  // also closes any headless embedded proxy left warm by a previous capture.
  await resetEmbeddedProxy();
  if (!activeEmbeddedProxy) {
    activeEmbeddedProxy = startEmbeddedProxy();
  }
  try {
    return await activeEmbeddedProxy.call("chatgpt", "manual_login", { runtime_dir: runtime, browser: "chromium", headless: false });
  } catch (error) {
    await activeEmbeddedProxy.close().catch(() => {});
    activeEmbeddedProxy = null;
    throw error;
  }
}

async function embeddedCloseLogin() {
  if (!activeEmbeddedProxy) return { ok: true, closed: false };
  const proxy = activeEmbeddedProxy;
  activeEmbeddedProxy = null;
  await proxy.close();
  return { ok: true, closed: true };
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await resetEmbeddedProxy();
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
        : await analyze(command);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

// stdin closed (parent asked us to exit): tear down the warm browser and the
// embedded proxy grandchild so the ChatGPT profile lock is released.
await resetEmbeddedProxy();
