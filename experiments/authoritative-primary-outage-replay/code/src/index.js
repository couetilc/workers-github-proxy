const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
