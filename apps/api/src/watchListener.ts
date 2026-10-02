/**
 * The watch-only listener (Q73, WATCH_PORT, default 3001). The public watch host is proxied here,
 * never to PORT: standalone through Caddy's :8088 site, on the Vibe Appliance as the `watch`
 * surface in the manifest, whose Caddy vhost forwards the whole hostname to one upstream with no
 * path filtering. So the limit is enforced in the api itself: this listener hands Fastify only the
 * exact client watch routes and answers 404 to everything else, before any route, hook or plugin
 * sees the request. `/api/*`, `/auth/*` and the health endpoints do not exist here.
 */
import http from "node:http";
import type { FastifyInstance } from "fastify";

/** The page, its two posts, the video and the captions. Nothing else, no dot segments, no encodings. */
export const WATCH_ROUTE = /^\/watch\/[A-Za-z0-9_-]{43}(?:\/(?:code|verify|video\.mp4|captions\.vtt))?(?:\?[A-Za-z0-9=&_.-]*)?$/;
const METHODS = new Set(["GET", "HEAD", "POST"]);

export function watchOnly(app: FastifyInstance): http.RequestListener {
  return (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("User-agent: *\nDisallow: /\n");
      return;
    }
    if (!METHODS.has(req.method ?? "") || !WATCH_ROUTE.test(url)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end("Not found\n");
      return;
    }
    // Behind Cloudflare the client's address arrives as Cf-Connecting-Ip, while X-Forwarded-For
    // holds the tunnel's. Only this listener prefers it: it feeds the share timeline and the
    // per-IP rate limits; the per-share code, cooldown and lock counters do not depend on it.
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && /^[0-9a-fA-F:.]{2,45}$/.test(cf)) req.headers["x-forwarded-for"] = cf;
    app.routing(req, res);
  };
}

/** Start the watch-only listener once the app is ready. The caller closes it at shutdown. */
export async function listenWatch(app: FastifyInstance, port: number, host: string): Promise<http.Server> {
  const server = http.createServer(watchOnly(app));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
