import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export const DEFAULT_UPLOAD_PROVIDERS = ["catbox", "imgpile", "postimages", "imgbb", "imglink"];

class UploadError extends Error {
  constructor(provider, status, message) {
    super(`${provider} upload returned ${status}: ${message}`);
    this.name = "UploadError";
    this.provider = provider;
    this.status = status;
  }
}

function envValue(env, names) {
  return names.map(name => env[name]?.trim()).find(Boolean) || "";
}

export function uploadProviders(env = process.env) {
  const configured = envValue(env, ["SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS"]);
  const names = (configured || DEFAULT_UPLOAD_PROVIDERS.join(","))
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

function configuredSecret(provider, env) {
  if (provider === "imglink") return envValue(env, ["SCREEN_AGENT_IMGLINK_API_KEY", "IMGLINK_API_KEY"]);
  if (provider === "imgpile") return envValue(env, ["SCREEN_AGENT_IMGPILE_API_TOKEN", "IMGPILE_API_TOKEN"]);
  if (provider === "postimages") return envValue(env, [
    "SCREEN_AGENT_POSTIMAGES_API_TOKEN",
    "SCREEN_AGENT_POSTIMAGES_API_KEY",
    "POSTIMAGES_API_TOKEN",
    "POSTIMAGES_API_KEY",
  ]);
  if (provider === "imgbb") return envValue(env, ["SCREEN_AGENT_IMGBB_API_KEY", "IMGBB_API_KEY"]);
  return "";
}

function providerUrl(provider, env) {
  const names = {
    imglink: ["SCREEN_AGENT_IMGLINK_URL"],
    catbox: ["SCREEN_AGENT_CATBOX_URL"],
    imgpile: ["SCREEN_AGENT_IMGPILE_URL"],
    postimages: ["SCREEN_AGENT_POSTIMAGES_URL"],
    imgbb: ["SCREEN_AGENT_IMGBB_URL"],
  };
  const defaults = {
    imglink: "https://imglink.cc/api/upload",
    catbox: "https://catbox.moe/user/api.php",
    imgpile: "https://imgpile.com/uploads",
    postimages: "https://api.postimage.org/1/upload",
    imgbb: "https://api.imgbb.com/1/upload",
  };
  return envValue(env, names[provider] || []) || defaults[provider];
}

async function request(fetchFn, url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseBody(response) {
  const text = await response.text();
  try {
    return { text, json: text ? JSON.parse(text) : {} };
  } catch {
    return { text, json: {} };
  }
}

function assertOk(provider, response, body) {
  if (!response.ok) throw new UploadError(provider, response.status, body.text.slice(0, 200));
}

function imageBlob(bytes) {
  return new Blob([bytes], { type: "image/png" });
}

function cleanUrl(value) {
  return String(value || "").replace(/&amp;/gi, "&").trim();
}

function isPostimagesDirectUrl(value) {
  return /^https?:\/\/i\.postimg\.cc\//i.test(value);
}

async function uploadCatbox(bytes, filename, env, fetchFn) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  const userhash = envValue(env, ["SCREEN_AGENT_CATBOX_USERHASH", "CATBOX_USERHASH"]);
  if (userhash) form.append("userhash", userhash);
  form.append("fileToUpload", imageBlob(bytes), filename);
  const response = await request(fetchFn, providerUrl("catbox", env), { method: "POST", body: form });
  const body = await responseBody(response);
  assertOk("catbox", response, body);
  const url = body.text.trim();
  if (!/^https?:\/\//i.test(url)) throw new UploadError("catbox", response.status, "missing direct URL");
  return { url, viewer: null, size: bytes.byteLength };
}

async function uploadImgPile(bytes, filename, token, env, fetchFn) {
  const response = await request(fetchFn, `${providerUrl("imgpile", env)}?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
    body: bytes,
  });
  const body = await responseBody(response);
  assertOk("imgpile", response, body);
  const data = body.json.data;
  if (!data?.urls?.original) throw new UploadError("imgpile", response.status, "missing direct URL");
  return { url: data.urls.original, viewer: data.pageUrl || null, size: bytes.byteLength };
}

async function uploadPostimages(bytes, filename, token, env, fetchFn) {
  const extension = path.extname(filename).replace(/^\./, "") || "png";
  const form = new URLSearchParams({
    key: token,
    gallery: envValue(env, ["SCREEN_AGENT_POSTIMAGES_GALLERY"]),
    o: envValue(env, ["SCREEN_AGENT_POSTIMAGES_O"]) || "2b819584285c102318568238c7d4a4c7",
    m: envValue(env, ["SCREEN_AGENT_POSTIMAGES_M"]) || "59c2ad4b46b0c1e12d5703302bff0120",
    version: "1.0.1",
    portable: "1",
    name: path.basename(filename, path.extname(filename)),
    type: extension,
    image: Buffer.from(bytes).toString("base64"),
    optsize: "0",
    expire: "0",
    numfiles: "1",
    upload_session: crypto.randomUUID(),
    adult: "0",
  });
  const response = await request(fetchFn, providerUrl("postimages", env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json, application/xml" },
    body: form,
  });
  const body = await responseBody(response);
  assertOk("postimages", response, body);
  const apiError = body.text.match(/<error>([^<]+)<\/error>/i);
  if (apiError?.[1]) {
    const status = Number(body.text.match(/status=["'](\d+)["']/i)?.[1] || response.status);
    throw new UploadError("postimages", status, apiError[1].trim());
  }
  const jsonUrls = [
    body.json.direct_url,
    body.json.directUrl,
    body.json.url,
    body.json.page,
    body.json.page_url,
    body.json.pageUrl,
    body.json.image?.direct_url,
    body.json.image?.url,
    body.json.data?.direct_url,
    body.json.data?.url,
    body.json.data?.page,
  ].map(cleanUrl).filter(Boolean);
  const xmlUrls = ["direct_url", "url", "page"].map(tag => body.text.match(
    new RegExp(`<${tag}>(https?:\\/\\/[^<]+)<\\/${tag}>`, "i"),
  )?.[1]).map(cleanUrl).filter(Boolean);
  const directUrl = [...jsonUrls, ...xmlUrls].find(isPostimagesDirectUrl);
  if (directUrl) {
    return { url: directUrl, viewer: null, size: bytes.byteLength };
  }
  const pageUrl = [...jsonUrls, ...xmlUrls].find(url => !isPostimagesDirectUrl(url));
  if (!pageUrl) throw new UploadError("postimages", response.status, "missing direct URL");
  const page = await request(fetchFn, pageUrl, { method: "GET" });
  const pageBody = await responseBody(page);
  assertOk("postimages", page, pageBody);
  const match = pageBody.text.match(/https?:\/\/i\.postimg\.cc\/[^"'\s<]+/i);
  const pageDirectUrl = cleanUrl(match?.[0]);
  if (!isPostimagesDirectUrl(pageDirectUrl)) throw new UploadError("postimages", page.status, "missing direct URL");
  return { url: pageDirectUrl, viewer: pageUrl, size: bytes.byteLength };
}

async function uploadImgBb(bytes, filename, token, env, fetchFn) {
  const form = new FormData();
  form.append("image", imageBlob(bytes), filename);
  const response = await request(fetchFn, `${providerUrl("imgbb", env)}?key=${encodeURIComponent(token)}`, { method: "POST", body: form });
  const body = await responseBody(response);
  assertOk("imgbb", response, body);
  const data = body.json.data;
  if (!data?.url) throw new UploadError("imgbb", response.status, "missing direct URL");
  return { url: data.url, viewer: data.url_viewer || null, size: bytes.byteLength };
}

async function uploadImgLink(bytes, filename, token, env, fetchFn) {
  const form = new FormData();
  form.append("file", imageBlob(bytes), filename);
  form.append("visibility", "public");
  const response = await request(fetchFn, providerUrl("imglink", env), {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  });
  const body = await responseBody(response);
  assertOk("imglink", response, body);
  const image = body.json.images?.[0];
  if (!image?.url) throw new UploadError("imglink", response.status, "missing direct URL");
  return { url: image.url, viewer: image.viewer || null, size: image.size || bytes.byteLength };
}

async function uploadProvider(provider, bytes, filename, env, fetchFn) {
  const token = configuredSecret(provider, env);
  if (["imglink", "imgpile", "postimages", "imgbb"].includes(provider) && !token) {
    throw new UploadError(provider, 0, "provider credentials not configured");
  }
  if (provider === "catbox") return uploadCatbox(bytes, filename, env, fetchFn);
  if (provider === "imgpile") return uploadImgPile(bytes, filename, token, env, fetchFn);
  if (provider === "postimages") return uploadPostimages(bytes, filename, token, env, fetchFn);
  if (provider === "imgbb") return uploadImgBb(bytes, filename, token, env, fetchFn);
  if (provider === "imglink") return uploadImgLink(bytes, filename, token, env, fetchFn);
  throw new UploadError(provider, 0, "unknown provider");
}

export async function uploadImageWithFallback(filePath, env = process.env, fetchFn = globalThis.fetch) {
  const bytes = await fs.readFile(filePath);
  const filename = path.basename(filePath);
  const failures = [];
  for (const provider of uploadProviders(env)) {
    try {
      const result = await uploadProvider(provider, bytes, filename, env, fetchFn);
      return { status: "uploaded", provider, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      process.stderr.write(`[image-upload] ${message}; trying next provider\n`);
    }
  }
  throw new Error(`all image upload providers failed: ${failures.join(" | ") || "none configured"}`);
}
