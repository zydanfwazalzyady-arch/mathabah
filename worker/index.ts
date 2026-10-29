interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
// @ts-nocheck
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB?: any;
  MATHABAH_KV?: any;
  ADMIN_PASSWORD?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-User, X-Admin-Password",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...corsHeaders,
    },
  });
}

async function readRecord(env: Env, key: string, cacheUrl: string): Promise<Record<string, any> | null> {
  if (env.DB) {
    try {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS mathabah_store (id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT)").run();
      const row = await env.DB.prepare("SELECT payload FROM mathabah_store WHERE id = ?").bind(key).first();
      if (row && row.payload) return JSON.parse(row.payload);
    } catch {}
  }
  if (env.MATHABAH_KV) {
    try {
      const raw = await env.MATHABAH_KV.get(key);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  try {
    const cache = (caches as any).default;
    const cached = await cache.match(new Request(cacheUrl, { method: "GET" }));
    if (cached) return await cached.json();
  } catch {}
  return null;
}

async function writeRecord(env: Env, key: string, cacheUrl: string, value: Record<string, any>): Promise<void> {
  const serialized = JSON.stringify(value);
  const now = new Date().toISOString();
  if (env.DB) {
    try {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS mathabah_store (id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT)").run();
      await env.DB.prepare("INSERT OR REPLACE INTO mathabah_store (id, payload, updated_at) VALUES (?, ?, ?)").bind(key, serialized, now).run();
    } catch {}
  }
  if (env.MATHABAH_KV) {
    try {
      await env.MATHABAH_KV.put(key, serialized);
    } catch {}
  }
  try {
    const cache = (caches as any).default;
    const responseToCache = new Response(serialized, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=31536000" },
    });
    await cache.put(new Request(cacheUrl, { method: "GET" }), responseToCache);
  } catch {}
}

async function verifyAdmin(env: Env, cacheUrl: string, userIn: string, passIn: string): Promise<boolean> {
  const stored = await readRecord(env, "site_data", cacheUrl);
  const expectedUser = (stored?.adminAuth?.username || "admin").trim().toLowerCase();
  const expectedPass = String(stored?.adminAuth?.password || env.ADMIN_PASSWORD || "7788").trim();
  const cleanUser = (userIn || "admin").trim().toLowerCase();
  const cleanPass = String(passIn || "").trim();
  return cleanPass === expectedPass && (cleanUser === expectedUser || cleanUser === "admin");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const dbCacheUrl = `${url.origin}/__internal_mathabah_cms_db_v1`;
    const leadsCacheUrl = `${url.origin}/__internal_mathabah_leads_db_v1`;

    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (path === "/api/site-data" && request.method === "GET") {
      const stored = await readRecord(env, "site_data", dbCacheUrl);
      if (!stored) return jsonResponse({ ok: true, data: null });
      const safeData = { ...stored };
      if (safeData.adminAuth) safeData.adminAuth = { username: safeData.adminAuth.username || "admin" };
      return jsonResponse({ ok: true, data: safeData });
    }

    if (path === "/api/admin/login" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const ok = await verifyAdmin(env, dbCacheUrl, body.username || "admin", body.password || "");
        if (!ok) return jsonResponse({ ok: false, error: "اسم المستخدم أو كلمة المرور غير صحيحة" }, 401);
        return jsonResponse({ ok: true, username: body.username || "admin" });
      } catch {
        return jsonResponse({ ok: false, error: "طلب غير صالح" }, 400);
      }
    }

    if (path === "/api/site-data" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const ok = await verifyAdmin(env, dbCacheUrl, body.username || "admin", body.password || "");
        if (!ok) return jsonResponse({ ok: false, error: "غير مصرح لك بالحفظ" }, 401);
        const existing = (await readRecord(env, "site_data", dbCacheUrl)) || {};
        const nextAdminAuth = {
          username: body.data?.adminAuth?.username?.trim() || existing?.adminAuth?.username || "admin",
          password: body.data?.adminAuth?.newPassword?.trim() || existing?.adminAuth?.password || body.password || "7788",
        };
        const payload = { ...existing, ...body.data, adminAuth: nextAdminAuth, updatedAt: new Date().toISOString() };
        await writeRecord(env, "site_data", dbCacheUrl, payload);
        return jsonResponse({ ok: true, data: { ...payload, adminAuth: { username: nextAdminAuth.username } } });
      } catch {
        return jsonResponse({ ok: false, error: "حدث خطأ أثناء الحفظ" }, 500);
      }
    }

    if (path === "/api/leads" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const currentObj = (await readRecord(env, "leads_data", leadsCacheUrl)) || { leads: [] };
        const leads = Array.isArray(currentObj.leads) ? currentObj.leads : [];
        const newLead = {
          id: `${Date.now()}`,
          name: String(body.name || "").trim(),
          project: String(body.project || "").trim(),
          location: String(body.location || "").trim(),
          details: String(body.details || "").trim(),
          createdAt: new Date().toISOString(),
        };
        await writeRecord(env, "leads_data", leadsCacheUrl, { leads: [newLead, ...leads].slice(0, 200) });
        return jsonResponse({ ok: true, lead: newLead });
      } catch {
        return jsonResponse({ ok: false }, 500);
      }
    }

    if (path === "/api/admin/leads") {
      const ok = await verifyAdmin(env, dbCacheUrl, request.headers.get("X-Admin-User") || "admin", request.headers.get("X-Admin-Password") || "");
      if (!ok) return jsonResponse({ ok: false, error: "غير مصرح" }, 401);
      const currentObj = (await readRecord(env, "leads_data", leadsCacheUrl)) || { leads: [] };
      if (request.method === "DELETE") {
        const id = url.searchParams.get("id");
        const filtered = (currentObj.leads || []).filter((item: any) => item.id !== id);
        await writeRecord(env, "leads_data", leadsCacheUrl, { leads: filtered });
        return jsonResponse({ ok: true, leads: filtered });
      }
      return jsonResponse({ ok: true, leads: currentObj.leads || [] });
    }

    const response = await env.ASSETS.fetch(request);
    return response;
  },
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
    const metadata: Record<string, { title: string; description: string }> = {
      "/services/glass": {
        title: "أعمال الزجاج والسيكوريت وكبائن الشاور في الرياض والسعودية",
        description: "تنفيذ الواجهات الزجاجية وزجاج السيكوريت، كبائن الشاور، قواطع الدبل جلاس، الدرابزينات وأعمال الاستركشر في الرياض.",
      },
      "/services/interior-decor": {
        title: "تصميم وتنفيذ الديكور الداخلي في الرياض | مؤسسة مثابة",
        description: "حلول الديكور الداخلي والخارجي للمنازل والمكاتب والمساحات التجارية في الرياض، من دراسة الاستخدام واختيار الخامات إلى التنفيذ.",
      },
      "/services/woodwork": {
        title: "أعمال النجارة والديكورات الخشبية في الرياض | مؤسسة مثابة",
        description: "تنفيذ أعمال النجارة والديكورات الخشبية والدواليب والكسوات والأثاث المخصص في الرياض.",
      },
      "/services/aluminum": {
        title: "أعمال الألمنيوم والواجهات الخارجية في الرياض | مؤسسة مثابة",
        description: "حلول الألمنيوم للنوافذ والأبواب والواجهات والتكسيات الخارجية والكلادينج في الرياض.",
      },
    };
    const service = metadata[path];
    if (!service || !response.headers.get("content-type")?.includes("text/html")) return response;
    const html = await response.text();
    const canonical = `https://mathabahksa.com${path}`;
    const updated = html
      .replace(/<title>[^<]*<\/title>/, `<title>${service.title}</title>`)
      .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${service.description}" />`)
      .replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${canonical}" />`)
      .replace(/<meta property="og:title" content="[^"]*"\s*\/>/, `<meta property="og:title" content="${service.title}" />`)
      .replace(/<meta property="og:description" content="[^"]*"\s*\/>/, `<meta property="og:description" content="${service.description}" />`)
      .replace(/<meta property="og:url" content="[^"]*"\s*\/>/, `<meta property="og:url" content="${canonical}" />`)
      .replace(/<meta name="twitter:title" content="[^"]*"\s*\/>/, `<meta name="twitter:title" content="${service.title}" />`)
      .replace(/<meta name="twitter:description" content="[^"]*"\s*\/>/, `<meta name="twitter:description" content="${service.description}" />`);
    return new Response(updated, { headers: response.headers });
  },
};
