import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { executeAegisRequest } from "../executor/router-client.js";

const BROWSER_PROFILE_DIR = path.join(
  os.homedir(),
  ".aegis",
  "browser-profile",
);
const REBOOT_INTERVAL_MS = 60 * 60 * 1000;
const TOOL_TIMEOUT_MS = 60_000;

type BrowserAction = "click" | "type" | "select";

export class BrowserBusyError extends Error {
  constructor() {
    super("Browser Busy: another agent currently owns the browser.");
    this.name = "BrowserBusyError";
  }
}

class TryMutex {
  private locked = false;

  get isLocked(): boolean {
    return this.locked;
  }

  tryAcquire(): (() => void) | null {
    if (this.locked) return null;
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked = false;
    };
  }
}

export interface BrowserNavigateResult {
  ok: true;
  url: string;
  title: string;
}

export interface BrowserActResult {
  ok: true;
  action: BrowserAction;
  selector: string;
  url: string;
}

interface ParsedExtractionResult {
  markdown?: string;
  extractedData?: unknown;
  url?: string;
  fallback?: boolean;
  error?: string;
}

export class BrowserManager {
  private static instance: BrowserManager | null = null;

  static getInstance(): BrowserManager {
    BrowserManager.instance ??= new BrowserManager();
    return BrowserManager.instance;
  }

  readonly profileDir = BROWSER_PROFILE_DIR;

  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchPromise: Promise<void> | null = null;
  private rebootTimer: NodeJS.Timeout | null = null;
  private pendingReboot = false;
  private readonly operationLock = new TryMutex();

  private constructor() {}

  /** Warms Chromium in a visible window (always headed). */
  async start(): Promise<void> {
    await this.ensureStarted();
    this.startRebootTimer();
  }

  async rebootBrowser(): Promise<void> {
    if (this.operationLock.isLocked) {
      this.pendingReboot = true;
      return;
    }

    await this.closeContext();
    await this.ensureStarted();
  }

  async shutdown(): Promise<void> {
    if (this.rebootTimer) {
      clearInterval(this.rebootTimer);
      this.rebootTimer = null;
    }
    await this.closeContext();
  }

  async navigate(url: string): Promise<BrowserNavigateResult> {
    return this.withBrowserOperation(async (page) => {
      await page.goto(url, { waitUntil: "load", timeout: TOOL_TIMEOUT_MS });
      return {
        ok: true,
        url: page.url(),
        title: await page.title(),
      };
    });
  }

  async getA11yTree(): Promise<unknown> {
    return this.withBrowserOperation(async (page) => {
      const context = page.context();
      const session = await context.newCDPSession(page);
      try {
        return await session.send("Accessibility.getFullAXTree");
      } finally {
        await session.detach().catch(() => {});
      }
    });
  }

  async act(
    action: BrowserAction,
    selector: string,
    text?: string,
  ): Promise<BrowserActResult> {
    return this.withBrowserOperation(async (page) => {
      const locator = page.locator(selector).first();

      if (action === "click") {
        // Instead of locator.click(), use real mouse path (avoids synthetic isTrusted:false events).
        await locator.hover({ timeout: TOOL_TIMEOUT_MS });
        await page.mouse.down();
        await page.mouse.up();
      } else if (action === "type") {
        if (typeof text !== "string") {
          throw new Error('browser_act action "type" requires `text`.');
        }
        await locator.fill(text, { timeout: TOOL_TIMEOUT_MS });
      } else {
        if (typeof text !== "string") {
          throw new Error('browser_act action "select" requires `text`.');
        }
        await locator.selectOption(text, { timeout: TOOL_TIMEOUT_MS });
      }

      return { ok: true, action, selector, url: page.url() };
    });
  }

  async extractData(instructions: string): Promise<unknown> {
    return this.withBrowserOperation(async (page) =>
      this.extractPageData(page, instructions),
    );
  }

  /**
   * Load a URL in the persistent Chromium profile and return serialized HTML (for
   * domain relay: cookies, JS-rendered DOM, weaker bot fingerprints than bare fetch).
   * Does not call aegis-parse; relay callers normalize the returned HTML before
   * sending it over NATS.
   */
  async loadPageHtml(
    url: string,
    options?: { settleMs?: number },
  ): Promise<{ html: string; finalUrl: string; title: string }> {
    return this.withBrowserOperation(async (page) => {
      await page.goto(url, { waitUntil: "load", timeout: TOOL_TIMEOUT_MS });

      const settleMs =
        options?.settleMs ??
        (() => {
          const raw = Number(process.env.AEGIS_RELAY_BROWSER_SETTLE_MS);
          return Number.isFinite(raw) && raw >= 0 ? raw : 1_500;
        })();

      if (settleMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
      }

      return {
        html: await page.content(),
        finalUrl: page.url(),
        title: await page.title(),
      };
    });
  }

  /**
   * Navigate then extract on the same tab (single tool lock). Avoids extractData
   * attaching to a different open tab (e.g. persistent about:blank) than navigate used.
   */
  async navigateExtract(
    url: string,
    instructions: string,
    options?: { settleMs?: number },
  ): Promise<{ navigate: BrowserNavigateResult; data: unknown }> {
    return this.withBrowserOperation(async (page) => {
      await page.goto(url, { waitUntil: "load", timeout: TOOL_TIMEOUT_MS });

      const navigate: BrowserNavigateResult = {
        ok: true,
        url: page.url(),
        title: await page.title(),
      };

      const settle = options?.settleMs ?? 0;
      if (settle > 0)
        await new Promise((resolve) => setTimeout(resolve, settle));

      const data = await this.extractPageData(page, instructions);
      return { navigate, data };
    });
  }

  private async extractPageData(
    page: Page,
    instructions: string,
  ): Promise<unknown> {
    const url = page.url();

    // 🔬 SMOKE TEST BASELINE: Drop all smart logic. Hard wait for 10 seconds.
    console.warn(
      `[Browser] Testing ${url}... Sleeping hard for 10s to watch execution state.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20000));

    const html = await page.content();

    try {
      const response = await executeAegisRequest("aegis-html-to-markdown", {
        html,
        instructions,
      });
      return this.normalizeParseResponse(response, url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[Browser] aegis-parse extraction failed:", message);
      return {
        markdown: await this.getPageInnerText(page),
        url,
        fallback: true,
        error: message,
      } satisfies ParsedExtractionResult;
    }
  }

  private normalizeParseResponse(
    response: unknown,
    url: string,
  ): ParsedExtractionResult | string | unknown {
    const payload =
      response && typeof response === "object" && !Array.isArray(response)
        ? ((response as Record<string, unknown>).data ?? response)
        : response;

    if (typeof payload === "string") return payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }

    const parsed = payload as Record<string, unknown>;
    const inner =
      parsed.data &&
      typeof parsed.data === "object" &&
      !Array.isArray(parsed.data)
        ? (parsed.data as Record<string, unknown>)
        : {};

    const markdown =
      this.firstString(
        parsed.markdown,
        parsed.content,
        inner.markdown,
        inner.content,
      ) ?? "";
    const extractedData =
      parsed.extractedData ??
      parsed.extracted_data ??
      inner.extractedData ??
      inner.extracted_data;

    if (extractedData !== undefined) {
      return { markdown, extractedData, url };
    }
    if (markdown) return markdown;

    return { ...parsed, url };
  }

  private firstString(...values: unknown[]): string | undefined {
    return values.find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  private async getPageInnerText(page: Page): Promise<string> {
    try {
      return await page.locator("body").innerText({ timeout: 5_000 });
    } catch {
      return page.evaluate(() => document.body?.innerText ?? "");
    }
  }

  async screenshot(): Promise<{ mimeType: "image/png"; base64: string }> {
    return this.withBrowserOperation(async (page) => {
      const image = await page.screenshot({ type: "png", fullPage: false });
      return { mimeType: "image/png", base64: image.toString("base64") };
    });
  }

  async runVisibleAuthSession(): Promise<void> {
    await this.start();
    const page = await this.getPage();
    console.error(
      `Aegis browser auth session started with profile: ${this.profileDir}`,
    );
    console.error(
      "Log in to required sites in the visible browser, then press Ctrl+C when done.",
    );
    if (page.url() === "about:blank") {
      await page
        .goto("https://www.google.com", {
          waitUntil: "load",
          timeout: TOOL_TIMEOUT_MS,
        })
        .catch(() => {});
    }

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
      this.context?.once("close", done);
    });
    await this.shutdown();
  }

  private async withBrowserOperation<T>(
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const release = this.operationLock.tryAcquire();
    if (!release) throw new BrowserBusyError();

    try {
      await this.ensureStarted();
      try {
        return await fn(await this.getPage());
      } catch (err) {
        if (!this.isBrowserDeadError(err) && this.isHealthy()) throw err;
        await this.closeContext();
        await this.ensureStarted();
        return await fn(await this.getPage());
      }
    } finally {
      release();
      if (this.pendingReboot && !this.operationLock.isLocked) {
        this.pendingReboot = false;
        void this.rebootBrowser().catch((err) => {
          console.warn("[Browser] deferred reboot failed:", err);
        });
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.isHealthy()) return;
    if (this.launchPromise) {
      await this.launchPromise;
      return;
    }

    this.launchPromise = (async () => {
      await mkdir(this.profileDir, { recursive: true });
      await this.closeContext();

      console.error(
        `[Browser] Launching headed Chromium with profile ${this.profileDir}`,
      );

      /** Stability on Linux/low shared memory, plus anti-detection primitives */
      const args = [
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled", // Hides the automation flag from Cloudflare
      ];

      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        ignoreDefaultArgs: ["--enable-automation"],
        args,
        /** Match the actual window size instead of a fixed emulation rect. */
        viewport: null,
      });

      // Strips the webdriver property before any page scripts execute
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
        // Keeps user-agent string looking authentic
        (
          window as unknown as Window & {
            chrome: { runtime: Record<string, never> };
          }
        ).chrome = { runtime: {} };
      });

      this.context.once("close", () => {
        this.context = null;
        this.page = null;
      });

      this.page = await this.getPage();
    })();

    try {
      await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  private async getPage(): Promise<Page> {
    if (!this.context) throw new Error("Browser context is not available.");
    const ctx = this.context;
    const open = () => ctx.pages().filter((p: Page) => !p.isClosed());

    if (this.page && !this.page.isClosed()) {
      if (this.page.url() !== "about:blank") return this.page;
      const richer = open().find(
        (p: Page) => p !== this.page && p.url() !== "about:blank",
      );
      if (richer) this.page = richer;
      return this.page as Page;
    }

    const pages = open();
    const picked =
      pages.find((p: Page) => p.url() !== "about:blank") ?? pages[0] ?? null;
    this.page = picked ?? (await ctx.newPage());
    return this.page as Page;
  }

  private isHealthy(): boolean {
    return this.context !== null;
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => {});
  }

  private startRebootTimer(): void {
    if (this.rebootTimer) return;
    this.rebootTimer = setInterval(() => {
      void this.rebootBrowser().catch((err) => {
        console.warn("[Browser] scheduled reboot failed:", err);
      });
    }, REBOOT_INTERVAL_MS);
    this.rebootTimer.unref?.();
  }

  private isBrowserDeadError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /browser.*closed|context.*closed|page.*closed|target.*closed|disconnected|crash/i.test(
      message,
    );
  }
}

export const browserManager = BrowserManager.getInstance();
