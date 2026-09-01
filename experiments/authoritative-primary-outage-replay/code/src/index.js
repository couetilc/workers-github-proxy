const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

function jsonError(message, status) {
  return Response.json({ error: message }, { status });
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function gitRoute(pathname) {
  const match = pathname.match(/^\/([^/]+)\.git(\/.*)?$/);
  if (!match || !REPO_NAME.test(match[1])) return null;
  return { name: match[1], suffix: match[2] ?? "" };
}

export function artifactsGitUrl(accountId, namespace, route, search = "") {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("invalid Artifacts account ID");
  if (!REPO_NAME.test(namespace)) throw new Error("invalid Artifacts namespace");
  if (!route || !REPO_NAME.test(route.name)) throw new Error("invalid repository route");

  const url = new URL(`https://${accountId}.artifacts.cloudflare.net`);
  url.pathname = `/git/${namespace}/${route.name}.git${route.suffix}`;
  url.search = search;
  return url;
}

async function proxyGit(request, env, url, route) {
  if (!env.ARTIFACTS_ACCOUNT_ID) {
    return jsonError("ARTIFACTS_ACCOUNT_ID is required for the Git proxy", 503);
  }

  const repo = await env.ARTIFACTS.get(route.name);
  const token = await repo.createToken("write", 300);
  const upstream = artifactsGitUrl(
    env.ARTIFACTS_ACCOUNT_ID,
    env.ARTIFACTS_NAMESPACE,
    route,
    url.search,
  );
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token.plaintext}`);
  headers.delete("Host");

  return fetch(upstream, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const route = gitRoute(url.pathname);
    if (route && (request.method === "GET" || request.method === "POST")) {
      return proxyGit(request, env, url, route);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/repos") {
      const page = await env.ARTIFACTS.list({ limit: 100 });
      return Response.json({
        repos: page.repos.map(({ name, status }) => ({ name, status })),
        cursor: page.cursor ?? null,
      });
    }

    if (request.method === "POST" && url.pathname === "/repos") {
      const body = await parseJson(request);
      if (typeof body.name !== "string" || !REPO_NAME.test(body.name)) {
        return jsonError("a valid repository name is required", 400);
      }

      const created = await env.ARTIFACTS.create(body.name, {
        description: "workers-github-proxy authoritative primary experiment",
        readOnly: false,
        setDefaultBranch: "main",
      });

      return Response.json(
        {
          name: created.name,
          remote: created.remote,
          defaultBranch: created.defaultBranch,
          token: created.token,
        },
        { status: 201 },
      );
    }

    const tokenMatch = url.pathname.match(/^\/repos\/([^/]+)\/tokens$/);
    if (request.method === "POST" && tokenMatch) {
      const name = decodeURIComponent(tokenMatch[1]);
      if (!REPO_NAME.test(name)) {
        return jsonError("invalid repository name", 400);
      }

      const body = await parseJson(request);
      const scope = body.scope === "read" ? "read" : "write";
      const ttl = Number.isInteger(body.ttl) ? body.ttl : 3600;
      const repo = await env.ARTIFACTS.get(name);
      const created = await repo.createToken(scope, ttl);
      return Response.json({ token: created.plaintext, expiresAt: created.expiresAt });
    }

    return jsonError("not found", 404);
  },
};
