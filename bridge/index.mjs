import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const { chromium } = await import("playwright");
const runtime = process.env.SCREEN_AGENT_RUNTIME || path.resolve(".runtime");
const captureDir = path.join(runtime, "captures");

async function analyze(command) {
  await fs.mkdir(captureDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(400);
    const id = String(command.run_id || Date.now());
    const screenshot = path.join(captureDir, `${id}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    const pageState = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 12000) || "",
    }));
    const answer = await askProxy(command.prompt, pageState, screenshot);
    return { ...pageState, screenshot: `/captures/${id}.png`, answer };
  } finally {
    await browser.close();
  }
}

async function askProxy(prompt, pageState, screenshot) {
  const proxy = (process.env.RUST_PROXY_HUB_URL || process.env.GPT_PROXY_URL)?.replace(/\/$/, "");
  if (!proxy) {
    return `Captured “${pageState.title || pageState.url}”. Proxy not configured. Page text: ${pageState.text.slice(0, 800)}`;
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
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `${prompt}\n\nPage URL: ${pageState.url}\nPage text:\n${pageState.text}` },
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
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("").trim();
  return "Proxy returned an empty answer.";
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    console.log(JSON.stringify(await analyze(JSON.parse(line))));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
