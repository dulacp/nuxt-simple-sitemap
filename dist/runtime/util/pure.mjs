import { joinURL } from "ufo";
export function urlWithBase(url, base, siteUrl) {
  return joinURL(siteUrl.replace(new RegExp(`${base}$`), ""), base, url.replace(new RegExp(`^${base}`), ""));
}
