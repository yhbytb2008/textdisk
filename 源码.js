/**
 * EdgeText-Pro: 终极集成版
 * 
 * 核心功能清单:
 * [√] 界面: 内置原生 HTML 管理后台 (零依赖，绝不空白)
 * [√] 逻辑: 禁止重复创建文件 (必须通过编辑模式修改)
 * [√] 同步: 保存后强制清理 Cache API 和 KV 缓存 (秒级更新)
 * [√] 缓存: 禁用浏览器本地强缓存 (no-cache)，确保访客刷新即见新内容
 * [√] 架构: D1 (持久化) + KV (加速) + Cache API (边缘缓存)
 * 
 * 必须配置:
 * - ADMIN_UUID: 管理员密码
 * - DB: 绑定 D1 数据库
 * - SHARE_KV: 绑定 KV 命名空间
 */

const CONFIG = {
  GLOBAL_CACHE_TTL: 86400,
};

// --- 基础响应函数 ---
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json;charset=utf-8" },
});

const text = (content, status = 200) => new Response(content, {
  status,
  headers: { 
    "Content-Type": "text/plain;charset=utf-8",
    // 强制浏览器不使用本地强缓存，每次访问必须向服务器验证
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  },
});

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// --- 存储管理类 ---
class StorageManager {
  constructor(env) { this.env = env; }

  async init() {
    await this.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        is_folder INTEGER,
        content TEXT,
        token TEXT,
        expires_at INTEGER, 
        version INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `).run();
  }

  async getFile(path) {
    return await this.env.DB.prepare("SELECT * FROM files WHERE path = ?").bind(path).first();
  }

  async saveFile(path, content, token, isUpdate = false, ttlDays = 0) {
    const existing = await this.getFile(path);
    
    // 【拦截重复创建】
    if (existing && !isUpdate) {
      throw new Error("文件已存在，请点击文件名进入编辑模式进行修改，或更换文件名");
    }

    const expiresAt = ttlDays > 0 ? (Date.now() + ttlDays * 86400 * 1000) : null;
    const finalToken = token || (existing ? existing.token : crypto.randomUUID().slice(0, 8)); 
    
    await this.env.DB.prepare(`
      INSERT INTO files (path, is_folder, content, token, expires_at, version, updated_at)
      VALUES (?, 0, ?, ?, ?, 1, unixepoch())
      ON CONFLICT(path) DO UPDATE SET 
        content = excluded.content, 
        token = COALESCE(excluded.token, files.token),
        expires_at = excluded.expires_at,
        version = files.version + 1,
        updated_at = unixepoch()
    `).bind(path, content, finalToken, expiresAt).run();
    
    return { path, token: finalToken };
  }

  async deleteRecursive(path) {
    const folderPath = path.endsWith('/') ? path : path + '/';
    await this.env.DB.prepare("DELETE FROM files WHERE path = ? OR path LIKE ? || '%'").bind(path, folderPath).run();
  }
}

// --- 内置管理界面 (原生 CSS, 绝不空白) ---
const ADMIN_HTML = `
<!DOCTYPE html>
<html>
<head>
    <title>EdgeText 管理</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; color: #1c1e21; margin: 0; padding: 20px; }
        .container { max-width: 900px; margin: 0 auto; }
        .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); margin-bottom: 20px; border: 1px solid #ddd; }
        h1 { font-size: 24px; margin-bottom: 20px; color: #333; }
        h3 { margin-top: 0; color: #555; }
        input, textarea { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        button { padding: 12px 20px; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px; transition: background 0.2s; }
        button:hover { background: #0056b3; }
        .btn-danger { background: #dc3545; }
        .btn-danger:hover { background: #c82333; }
        .hidden { display: none; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; }
        th { background: #f8f9fa; color: #666; }
        .link-cell { color: #007bff; font-family: monospace; cursor: pointer; text-decoration: underline; }
        .edit-mode { border: 2px solid #007bff !important; background: #f0f7ff !important; }
    </style>
</head>
<body>
    <div class="container">
        <div id="login-view" class="hidden card" style="max-width: 400px; margin: 100px auto; text-align: center;">
            <h1>管理登录</h1>
            <input id="pwd" type="password" placeholder="请输入 ADMIN_UUID">
            <button onclick="login()" style="width: 100%">登录系统</button>
        </div>
        <div id="main-view" class="hidden">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h1>文本分享云盘</h1>
                <button onclick="logout()" class="btn-danger">登出</button>
            </div>
            <div id="editor-card" class="card">
                <h3 id="editor-title">创建分享文件</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <input id="f-path" placeholder="文件名 (例如: note.txt)">
                    <input id="f-token" placeholder="自定义 Token (可选)">
                </div>
                <textarea id="f-content" placeholder="分享内容..." rows="6"></textarea>
                <div style="display: flex; gap: 10px;">
                    <button id="save-btn" onclick="saveFile()">保存并生成链接</button>
                    <button id="cancel-btn" class="hidden btn-danger" onclick="resetEditor()">取消编辑</button>
                </div>
            </div>
            <div class="card">
                <h3>文件列表 (点击路径修改内容)</h3>
                <table>
                    <thead>
                        <tr><th>路径 (点击编辑)</th><th>分享链接</th><th>管理</th></tr>
                    </thead>
                    <tbody id="file-list"></tbody>
                </table>
            </div>
        </div>
    </div>
    <script>
        const baseUrl = window.location.origin;
        let isEditing = false;

        async function login() {
            const password = document.getElementById('pwd').value;
            try {
                const res = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({password})
                });
                if (res.ok) { showView('main-view'); loadFiles(); } 
                else { alert('登录失败: ' + (await res.text())); }
            } catch(e) { alert('网络错误: ' + e.message); }
        }

        async function logout() {
            await fetch('/api/admin/logout', {method: 'POST'});
            showView('login-view');
        }

        async function loadFiles() {
            try {
                const res = await fetch('/api/admin/files');
                if (!res.ok) throw new Error(await res.text());
                const files = await res.json();
                const tbody = document.getElementById('file-list');
                tbody.innerHTML = files.map(f => {
                    const url = \`\${baseUrl}/s/\${f.token}/\${f.path}\`;
                    return \`<tr>
                        <td class="link-cell" onclick="editFile('\${f.path}')" style="font-weight:bold; color:#333">\${f.path}</td>
                        <td class="link-cell" onclick="copyUrl('\${url}')">\${url}</td>
                        <td><button onclick="deleteFile('\${f.path}')" class="btn-danger">删除</button></td>
                    </tr>\`;
                }).join('');
            } catch(e) { alert('加载列表失败: ' + e.message); }
        }

        async function editFile(path) {
            try {
                const res = await fetch(\`/api/admin/files?path=\${encodeURIComponent(path)}\`);
                if (!res.ok) throw new Error('获取文件失败');
                const file = await res.json();
                document.getElementById('f-path').value = file.path;
                document.getElementById('f-content').value = file.content;
                document.getElementById('f-token').value = file.token;
                document.getElementById('editor-title').innerText = '正在编辑: ' + path;
                document.getElementById('editor-card').classList.add('edit-mode');
                document.getElementById('save-btn').innerText = '更新并保存内容';
                document.getElementById('cancel-btn').classList.remove('hidden');
                isEditing = true;
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } catch(e) { alert('读取文件失败: ' + e.message); }
        }

        function resetEditor() {
            document.getElementById('f-path').value = '';
            document.getElementById('f-content').value = '';
            document.getElementById('f-token').value = '';
            document.getElementById('editor-title').innerText = '创建分享文件';
            document.getElementById('editor-card').classList.remove('edit-mode');
            document.getElementById('save-btn').innerText = '保存并生成链接';
            document.getElementById('cancel-btn').classList.add('hidden');
            isEditing = false;
        }

        async function saveFile() {
            const data = {
                path: document.getElementById('f-path').value,
                content: document.getElementById('f-content').value,
                token: document.getElementById('f-token').value,
                isUpdate: isEditing
            };
            if(!data.path) return alert('请填写文件名');
            try {
                const res = await fetch('/api/admin/files', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(data)
                });
                if (res.ok) { 
                    alert('✅ 操作成功！内容已实时同步'); 
                    resetEditor();
                    loadFiles(); 
                } else { 
                    const err = await res.text();
                    alert('❌ ' + err); 
                }
            } catch(e) { alert('❌ 请求崩溃: ' + e.message); }
        }

        async function deleteFile(path) {
            if(!confirm('确定删除?')) return;
            try {
                const res = await fetch(\`/api/admin/files?path=\${encodeURIComponent(path)}\`, {method: 'DELETE'});
                if (res.ok) loadFiles();
                else alert('删除失败');
            } catch(e) { alert('错误: ' + e.message); }
        }

        function copyUrl(text) {
            navigator.clipboard.writeText(text).then(() => alert('链接已复制！'));
        }

        function showView(id) {
            document.getElementById('login-view').classList.add('hidden');
            document.getElementById('main-view').classList.add('hidden');
            document.getElementById(id).classList.remove('hidden');
        }

        window.onload = async () => {
            try {
                const res = await fetch('/api/admin/files');
                if (res.ok) { showView('main-view'); loadFiles(); } 
                else { showView('login-view'); }
            } catch(e) { showView('login-view'); }
        }
    </script>
</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    if (!env.DB) return new Response("❌ Error: DB binding missing", { status: 500 });
    if (!env.SHARE_KV) return new Response("❌ Error: SHARE_KV binding missing", { status: 500 });
    if (!env.ADMIN_UUID) return new Response("❌ Error: ADMIN_UUID variable missing", { status: 500 });

    const sm = new StorageManager(env);
    await sm.init();

    const url = new URL(request.url);
    const { pathname } = url;

    // 1. 访客访问: /s/:token/:path
    if (pathname.startsWith('/s/')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length < 3) return json({ error: "Invalid path" }, 400);
      const [_, token, ...pathParts] = parts;
      const path = pathParts.join('/');
      
      // 检查边缘缓存
      const cacheKey = new Request(`${url.origin}/cache/${token}-${path}`);
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        // 强制浏览器每次请求都重新验证
        const response = new Response(cached.body, cached);
        response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return response;
      }

      const kvKey = `share:${token}:${path}`;
      const kvData = await env.SHARE_KV.get(kvKey, { type: "json" });
      if (kvData && kvData.token === token) {
        ctx.waitUntil(caches.default.put(cacheKey, new Response(kvData.content, { headers: { "Cache-Control": "public, max-age=3600" }})));
        return text(kvData.content);
      }

      const file = await sm.getFile(path);
      if (!file || file.token !== token) return json({ error: "Not found or Invalid Token" }, 403);
      ctx.waitUntil(env.SHARE_KV.put(kvKey, JSON.stringify({ token, content: file.content }), { expirationTtl: 86400 }));
      return text(file.content);
    }

    // 2. 管理员 API
    if (pathname.startsWith('/api/admin')) {
      const adminToken = getCookie(request, "admin_token");
      const isLoginPath = pathname === '/api/admin/login';
      const isLogoutPath = pathname === '/api/admin/logout';
      if (adminToken !== env.ADMIN_UUID && !isLoginPath) return json({ error: "Unauthorized" }, 401);
      if (isLoginPath && request.method === 'POST') {
        const { password } = await request.json();
        if (password !== env.ADMIN_UUID) return json({ error: "Wrong password" }, 401);
        return new Response("OK", { status: 200, headers: { "Set-Cookie": `admin_token=${env.ADMIN_UUID};Path=/;HttpOnly;SameSite=Lax;Secure` } });
      }
      if (isLogoutPath) return new Response("OK", { status: 200, headers: { "Set-Cookie": `admin_token=;Path=/;Max-Age=0` } });
      if (pathname.startsWith('/api/admin/files')) {
        try {
          const pathParam = url.searchParams.get('path');
          if (pathParam && request.method === 'GET') {
             const file = await sm.getFile(pathParam);
             if (!file) return json({ error: "File not found" }, 404);
             return json(file);
          }
          if (request.method === 'GET') {
            const files = await env.DB.prepare("SELECT path, token, version FROM files").all();
            return json(files.results);
          }
          if (request.method === 'POST') {
            const body = await request.json();
            const res = await sm.saveFile(body.path, body.content, body.token, body.isUpdate);
            
            const finalToken = res.token;
            // 强制清除边缘缓存，实现即时同步
            const cacheKey = new Request(`${url.origin}/cache/${finalToken}-${body.path}`);
            await caches.default.delete(cacheKey);
            // 更新 KV 缓存
            const kvKey = `share:${finalToken}:${body.path}`;
            await env.SHARE_KV.put(kvKey, JSON.stringify({ token: finalToken, content: body.content }), { expirationTtl: 86400 });
            
            return json({ message: "Success", ...res });
          }
          if (request.method === 'DELETE') {
            const path = url.searchParams.get('path');
            await sm.deleteRecursive(path);
            return json({ message: "Deleted" });
          }
        } catch(e) {
          return new Response(`API Error: ${e.message}`, { status: 500 });
        }
      }
    }
    return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }
};
