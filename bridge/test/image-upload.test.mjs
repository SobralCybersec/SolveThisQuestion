import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { uploadImageWithFallback, uploadProviders } from "../image-upload.mjs";

test("provider order is deduplicated and configurable", () => {
  assert.deepEqual(uploadProviders({ SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS: "catbox, imgbb, catbox" }), ["catbox", "imgbb"]);
});

test("429 from one host falls through to next host", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "screen-agent-upload-")), "capture.png");
  await fs.writeFile(file, Buffer.from("png"));
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === "https://catbox.test/upload") return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ data: { url: "https://i.ibb.co/test/capture.png" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await uploadImageWithFallback(file, {
    SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS: "catbox,imgbb",
    SCREEN_AGENT_CATBOX_URL: "https://catbox.test/upload",
    SCREEN_AGENT_IMGBB_URL: "https://imgbb.test/1/upload",
    SCREEN_AGENT_IMGBB_API_KEY: "test-key",
  }, fetchFn);
  assert.equal(result.provider, "imgbb");
  assert.equal(result.url, "https://i.ibb.co/test/capture.png");
  assert.deepEqual(calls, ["https://catbox.test/upload", "https://imgbb.test/1/upload?key=test-key"]);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("uses current ImgPile binary upload API and data.urls.original", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "screen-agent-upload-")), "capture.png");
  await fs.writeFile(file, Buffer.from("png"));
  let request;
  const result = await uploadImageWithFallback(file, {
    SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS: "imgpile",
    SCREEN_AGENT_IMGPILE_URL: "https://imgpile.test/uploads",
    SCREEN_AGENT_IMGPILE_API_TOKEN: "pile-key",
  }, async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ data: { pageUrl: "https://imgpile.com/m/test", urls: { original: "https://cdn.imgpile.com/f/test.png" } } }), { status: 201 });
  });
  assert.equal(result.provider, "imgpile");
  assert.equal(result.url, "https://cdn.imgpile.com/f/test.png");
  assert.match(request.url, /https:\/\/imgpile\.test\/uploads\?filename=capture\.png/);
  assert.equal(Buffer.from(request.init.body).toString(), "png");
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("uses Postimages API endpoint and parses direct XML URL", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "screen-agent-upload-")), "capture.png");
  await fs.writeFile(file, Buffer.from("png"));
  let requestBody = "";
  const result = await uploadImageWithFallback(file, {
    SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS: "postimages",
    SCREEN_AGENT_POSTIMAGES_URL: "https://api.postimage.test/1/upload",
    SCREEN_AGENT_POSTIMAGES_API_KEY: "post-key",
  }, async (_url, init) => {
    requestBody = init.body.toString();
    return new Response('<?xml version="1.0"?><data success="1" status="200"><url>https://i.postimg.cc/abcd/capture.png</url></data>', { status: 200 });
  });
  assert.equal(result.provider, "postimages");
  assert.equal(result.url, "https://i.postimg.cc/abcd/capture.png");
  assert.match(requestBody, /key=post-key/);
  assert.match(requestBody, /image=cG5n/);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});
