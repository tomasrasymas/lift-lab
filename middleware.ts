// Vercel Routing Middleware: runs at the edge before every request, including
// static files. Only requests that carry the MyAppsTree key get through, so the
// app answers only when it is opened through MyAppsTree.
//
// MYAPPSTREE_KEY is a server-side environment variable. It must never get a
// VITE_ prefix, which would bundle it into the client.

declare const process: { env: Record<string, string | undefined> };

const DENIED = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>LiftLab</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 18px/1.5 system-ui, sans-serif; background: #10141a; color: #e8edf2; }
  a { color: #ff9a3c; }
</style>
</head>
<body>
<p>Open this app from <a href="https://liftlab-rc-flight-simulator.myappstr.ee">MyAppsTree</a></p>
</body>
</html>
`;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time: both sides are hashed to the same length and every byte is compared. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

export default async function middleware(request: Request): Promise<Response> {
  const expected = process.env.MYAPPSTREE_KEY;
  const given = request.headers.get('x-myappstree-key');

  if (!expected || !given || !(await sameSecret(given, expected))) {
    return new Response(DENIED, {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // Same response `next()` from @vercel/functions builds: carry on to the static files.
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
