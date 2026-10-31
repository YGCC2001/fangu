# 把「反骨」放到公网（固定网址）

现在应用跑在这台机器上：参与者 `:3000`、运营台 `:3001`。公网暂时靠临时隧道，域名每次重启都会换。
要一个能长期对外发的网址，照下面做，**大约 5 分钟**，全程免费、不需要信用卡。

---

## 路线 A：Render（推荐）

结果：`https://fangu-xxxx.onrender.com` —— 固定地址，不依赖你的电脑。

### A-1 先注册两个免费账号

- GitHub：https://github.com/signup （只要邮箱）
- Render：https://dashboard.render.com/register （可以直接用 GitHub 登录，省一次注册）

### A-2 把代码放到 GitHub（不用命令行）

1. 打开 https://github.com/new
   - Repository name 填 `fangu`
   - 选 **Public**
   - 点 **Create repository**
2. 在新仓库页面点 **uploading an existing file**
3. 把 `fangu-render.zip` 解压，选中解压出来的**所有文件和文件夹**，一起拖进浏览器窗口
   - 根目录必须有：`server.js`、`package.json`、`render.yaml`、`Dockerfile`、`public/`
   - 不要多套一层文件夹
4. 点 **Commit changes**

### A-3 在 Render 部署

1. 打开 https://dashboard.render.com → 右上 **New +** → **Blueprint**
2. 选刚才的 `fangu` 仓库 → **Apply**
   `render.yaml` 已经写好 Build / Start / 环境变量，不需要你填任何东西
3. 等 2–3 分钟，服务状态变绿，页面顶部就是你的网址

如果 Blueprint 没认出来，改用 **New + → Web Service**，手动填三项：

| 字段 | 值 |
|---|---|
| Build Command | `npm install --omit=dev` |
| Start Command | `node server.js` |
| Environment Variable | `ADMIN_PORT` = `0` |

---

## 路线 B：Railway / Fly.io（同样是免费额度，能挂持久盘）

代码不用改，仓库里已有 `Dockerfile`：

```bash
fly launch --no-deploy
fly volumes create fangu_data --size 1
# fly.toml 增加：
#   [mounts]
#     source = "fangu_data"
#     destination = "/app/data"
fly deploy
```

Railway：New Project → Deploy from GitHub → 自动识别 Node；要留数据就挂 Volume 到 `/app/data`。

---

## 路线 C：域名 + Cloudflare 命名隧道（地址固定，仍跑本机）

适合你已经有域名、又想把数据留在自己机器上的情况。需要一个 Cloudflare 账号（免费）和一个域名。

```bash
cloudflared tunnel login
cloudflared tunnel create fangu
cloudflared tunnel route dns fangu fangu.你的域名.com
```

`%USERPROFILE%\.cloudflared\config.yml`：

```yaml
tunnel: fangu
credentials-file: C:\Users\<你>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: fangu.你的域名.com
    service: http://localhost:3000
  - hostname: ops.你的域名.com
    service: http://localhost:3001
  - service: http_status:404
```

```bash
cloudflared tunnel run fangu
cloudflared service install    # 开机自启
```

---

## 数据持久化

数据是一个 JSON 文件，默认 `./data/db.json`，可用环境变量 `DATA_DIR` 改路径。

- **Render 免费层没有持久盘**：每次重新部署 / 重启会回到种子数据。要保住用户数据，需要付费实例挂 Disk（挂载点例如 `/var/data`，再设 `DATA_DIR=/var/data`），或改走 Railway / Fly 的 Volume。
- 迁移或备份就一句：把 `data/db.json` 复制走。

---

## 运营入口怎么办

托管平台只对外暴露一个端口，所以线上用 `ADMIN_PORT=0` 关掉运营台，公网只留参与者站；
需要发布辩题、审核留言时，在本机 `npm start` 用 `http://localhost:3001` 操作，改完的数据通过 `data/db.json` 同步。

如果运营台也想远程用，两条路：单独部署一个实例（`ADMIN_PORT` 用默认值，单独域名），或者走路线 C 的两条 ingress。

---

## 交接给 WorkBuddy 自动化

如果不想自己点，把下面两样发过来，我可以直接建服务、部署、并在线上验证注册 / 表态 / 留言：

1. GitHub 仓库地址（Public）
2. Render API Key：https://dashboard.render.com/u/settings → **API Keys** → Create

---

## 常见问题

**第一次打开很慢**：Render 免费实例 15 分钟无人访问会休眠，冷启动约 30–50 秒。

**网址又变了**：说明你还在用 `trycloudflare.com` 临时隧道，只有路线 A/B/C 才会固定。

**数据回到初始 14 期**：容器没有持久盘，见上面「数据持久化」。

**运营台打不开**：线上已用 `ADMIN_PORT=0` 关闭，属于预期；本机 `:3001` 仍然可用。
