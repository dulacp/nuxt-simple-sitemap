import { defineEventHandler, sendRedirect, setHeader } from "h3";
import { withBase } from "ufo";
import { buildSitemap } from "../util/builder.mjs";
import { useHostname } from "../util/nuxt.mjs";
import { useNitroApp, useRuntimeConfig } from "#internal/nitro";
import { getRouteRulesForPath } from "#internal/nitro/route-rules";
export default defineEventHandler(async (e) => {
  const sitemapConfig = useRuntimeConfig()["nuxt-simple-sitemap"];
  if (sitemapConfig.sitemaps) {
    return sendRedirect(e, withBase("/sitemap_index.xml", useRuntimeConfig().app.baseURL), process.dev ? 302 : 301);
  }
  setHeader(e, "Content-Type", "text/xml; charset=UTF-8");
  if (!process.dev)
    setHeader(e, "Cache-Control", "max-age=600, must-revalidate");
  const callHook = async (ctx) => {
    const nitro = useNitroApp();
    await nitro.hooks.callHook("sitemap:sitemap-xml", ctx);
  };
  return await buildSitemap({
    sitemapName: "sitemap",
    sitemapConfig: { ...sitemapConfig, host: useHostname(e) },
    baseURL: useRuntimeConfig().app.baseURL,
    getRouteRulesForPath,
    callHook
  });
});
