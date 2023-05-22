import { withBase } from "ufo";
import { getRequestHost, getRequestProtocol } from "h3";
import { useRuntimeConfig } from "#imports";
export function useHostname(e) {
  const base = useRuntimeConfig().app.baseURL;
  const host = getRequestHost(e, { xForwardedHost: true }) || process.env.NITRO_HOST || process.env.HOST || "localhost";
  const protocol = getRequestProtocol(e, { xForwardedProto: true });
  const useHttp = process.env.NODE_ENV === "development" || host.includes("127.0.0.1") || host.includes("localhost") || protocol === "http";
  let port = host.includes(":") ? host.split(":").pop() : false;
  if ((process.dev || process.env.prerender || host.includes("localhost")) && !port)
    port = process.env.NITRO_PORT || process.env.PORT;
  return withBase(base, `http${useHttp ? "" : "s"}://${host.includes(":") ? host.split(":")[0] : host}${port ? `:${port}` : ""}`);
}
