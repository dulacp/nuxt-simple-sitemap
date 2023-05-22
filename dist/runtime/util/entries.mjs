import { statSync } from "node:fs";
import { joinURL, withBase, withTrailingSlash, withoutTrailingSlash } from "ufo";
import { defu } from "defu";
import { createFilter } from "./urlFilter.mjs";
import { mergeOnKey, resolvePagesRoutes } from "./pageUtils.mjs";
import { normaliseDate } from "./normalise.mjs";
export async function generateSitemapEntries(options) {
  const {
    urls: configUrls,
    defaults,
    exclude,
    isNuxtContentDocumentDriven,
    include,
    trailingSlash,
    inferStaticPagesAsRoutes,
    hasApiRoutesUrl,
    autoLastmod,
    siteUrl,
    hasPrerenderedRoutesPayload,
    autoAlternativeLangPrefixes,
    dynamicUrlsApiEndpoint
  } = options.sitemapConfig;
  const baseURL = options.baseURL;
  const includeWithBase = include?.map((i) => withBase(i, baseURL));
  const excludeWithBase = exclude?.map((i) => withBase(i, baseURL));
  const urlFilter = createFilter({ include: includeWithBase, exclude: excludeWithBase });
  const defaultEntryData = { ...defaults };
  if (autoLastmod)
    defaultEntryData.lastmod = defaultEntryData.lastmod || /* @__PURE__ */ new Date();
  const fixLoc = (url) => {
    url = encodeURI(trailingSlash ? withTrailingSlash(url) : withoutTrailingSlash(url));
    return url.startsWith(baseURL) ? url : withBase(url, baseURL);
  };
  function preNormalise(entries) {
    return mergeOnKey(
      entries.map((e) => typeof e === "string" ? { loc: e } : e).map((e) => ({ ...defaults, ...e })).map((e) => ({ ...e, loc: fixLoc(e.loc || e.url) })),
      "loc"
    ).filter((e) => urlFilter(e.loc)).sort((a, b) => a.loc.length - b.loc.length).map((e) => {
      delete e.url;
      if (e.lastmod)
        e.lastmod = normaliseDate(e.lastmod);
      if (!e.lastmod)
        delete e.lastmod;
      if (Array.isArray(autoAlternativeLangPrefixes)) {
        if (autoAlternativeLangPrefixes.some((prefix) => {
          return e.loc.startsWith(withBase(`/${prefix}`, options.baseURL));
        }))
          return false;
        const loc = e.loc?.replace(options.baseURL, "") || "";
        e.alternatives = autoAlternativeLangPrefixes.map((prefix) => ({
          hreflang: prefix,
          href: fixLoc(joinURL(prefix, loc))
        }));
      }
      return e;
    }).filter(Boolean);
  }
  function postNormalise(e) {
    const siteUrlWithoutBase = siteUrl.replace(new RegExp(`${baseURL}$`), "");
    e.loc = withBase(e.loc, siteUrlWithoutBase);
    return e;
  }
  let pageUrls = [];
  if (process.dev || process.env.prerender) {
    if (options.sitemapConfig.pagesDirs && options.sitemapConfig.extensions) {
      const { pagesDirs, extensions } = options.sitemapConfig;
      pageUrls = inferStaticPagesAsRoutes ? (await resolvePagesRoutes(pagesDirs, extensions)).map((page) => {
        const entry = { loc: page.path };
        if (autoLastmod && page.file) {
          const stats = statSync(page.file);
          entry.lastmod = stats.mtime;
        }
        return entry;
      }) : [];
    }
  }
  let lazyApiUrls = [];
  if (hasApiRoutesUrl) {
    lazyApiUrls = await globalThis.$fetch(dynamicUrlsApiEndpoint, {
      responseType: "json",
      baseURL: options.baseURL
    });
  }
  let prerenderedRoutesPayload = [];
  if (hasPrerenderedRoutesPayload) {
    let isHtmlResponse = false;
    const routes = await globalThis.$fetch("/__sitemap__/routes.json", {
      responseType: "json",
      headers: {
        Accept: "application/json"
      },
      // host is the actual web server being used
      baseURL: withBase(options.baseURL, options.sitemapConfig.host || siteUrl),
      onResponse({ response }) {
        if (typeof response._data === "string" && response._data.startsWith("<!DOCTYPE html>"))
          isHtmlResponse = true;
      }
    });
    if (!isHtmlResponse)
      prerenderedRoutesPayload = routes;
  }
  let nuxtContentUrls = [];
  if (isNuxtContentDocumentDriven) {
    nuxtContentUrls = await globalThis.$fetch("/api/__sitemap__/document-driven-urls", {
      responseType: "json",
      baseURL: options.baseURL
    });
  }
  const urls = [
    "/",
    ...prerenderedRoutesPayload,
    ...lazyApiUrls,
    ...configUrls,
    ...pageUrls,
    ...nuxtContentUrls
  ];
  return mergeOnKey(
    preNormalise(urls).map((entry) => {
      const routeRules = options.getRouteRulesForPath(withoutTrailingSlash(entry.loc));
      if (routeRules.index === false)
        return false;
      return defu(routeRules.sitemap, entry);
    }).filter(Boolean).map(postNormalise),
    "loc"
  );
}
