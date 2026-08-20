import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRun, statusLabelFor, submitRun } from "./App";
import { queueChat } from "./ChatOverlay";
import { normalizeProviders, reorderProviders } from "./components/SettingsControls";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("run state labels", () => {
  it("maps every run state to user-facing text", () => {
    expect(statusLabelFor("ready")).toBe("Ready");
    expect(statusLabelFor("capturing")).toBe("Reading screen");
    expect(statusLabelFor("answer")).toBe("Answer ready");
    expect(statusLabelFor("error")).toBe("Needs attention");
  });
});

describe("run requests", () => {
  it("posts the capture request and returns success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queueRun({ url: "https://example.com", prompt: "Summarize", webSearch: true }),
    ).resolves.toEqual({ ok: true, error: "Could not queue run" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com",
          prompt: "Summarize",
          web_search: true,
        }),
      }),
    );
  });

  it("moves submit state to error when request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const setState = vi.fn();
    const setAnswer = vi.fn();
    const setError = vi.fn();

    await submitRun(
      { preventDefault: vi.fn() } as unknown as Parameters<typeof submitRun>[0],
      {
        url: "https://example.com",
        prompt: "Summarize",
        webSearch: false,
        setState,
        setAnswer,
        setError,
      },
    );

    expect(setState).toHaveBeenNthCalledWith(1, "capturing");
    expect(setState).toHaveBeenLastCalledWith("error");
    expect(setAnswer).toHaveBeenCalledWith("");
    expect(setError).toHaveBeenLastCalledWith("network down");
  });
});

describe("chat requests", () => {
  it("posts prompt with visible conversation history", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: "message-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(queueChat("Follow up", [{ role: "user", content: "First" }])).resolves.toEqual({
      ok: true,
      messageId: "message-1",
      error: "Could not send message",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "Follow up", history: [{ role: "user", content: "First" }] }),
      }),
    );
  });
});

describe("settings controls", () => {
  it("keeps provider fallback order draggable and deduplicated", () => {
    expect(normalizeProviders("catbox, imgpile, catbox")).toEqual(["catbox", "imgpile"]);
    expect(reorderProviders(["catbox", "imgpile", "imgbb"], 2, 0)).toEqual(["imgbb", "catbox", "imgpile"]);
  });
});
