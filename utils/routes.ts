import { BrowserContext, Page } from "playwright";

/**
 * On some Quest Data Modeler deployments, nginx serves the SPA's index.html
 * (Content-Type: text/html) for `/runtime-config.js` when the file isn't
 * present. The `<script>` tag tries to parse HTML as JS and throws, which
 * prevents the SPA from bootstrapping ("Unexpected token '<'" and downstream
 * `undefined.trim()`). This route handler intercepts that file: if the real
 * response is valid JavaScript it's passed through unchanged; otherwise it's
 * replaced with an empty-but-valid JS stub.
 */
export async function stubBrokenRuntimeConfig(target: Page | BrowserContext): Promise<void> {
  await target.route("**/runtime-config.js", async (route) => {
    const resp = await route.fetch().catch(() => null);
    const ct = (resp?.headers()["content-type"] || "").toLowerCase();
    if (resp && (ct.includes("javascript") || ct.includes("ecmascript"))) {
      await route.fulfill({ response: resp });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "/* stubbed by demo-agent — real runtime-config.js was not JavaScript */",
    });
  });
}
