# Feel My Heartbeat

只有两个人的房间。你点一下，两边的爱心一起冒。

零依赖，只用 Node.js 内置模块。两个文件就是全部：`server.js` 和 `index.html`。

项目目录：`/home/young/WorkSpace/love`

---

## 这台机器上跑着什么

想让对方能连上，这台机器上要同时跑着两个东西，缺一不可：

| 角色 | 是什么 | 命令 | 端口 |
|------|--------|------|------|
| **服务器** | Node 网站本体，存心跳、发纸条 | `node server.js` | 本机 `8787` |
| **Cloudflare 隧道** | 把本机 8787 端口暴露到公网，给你一个 `https://xxx.trycloudflare.com` 网址 | `cloudflared tunnel --url http://localhost:8787` | — |

房间口令（ROOM_KEY）：`123456` —— 对方打开网址后要输入这个才能进房间。

> ⚠️ 现在用的是**临时隧道（quick tunnel）**。它最大的特点：**每次重启 cloudflared，网址都会变一个新的。** 重启完记得把新网址发给对方。
>
> ⚠️ **放到公网之前一定要改掉默认口令。**

---

## 跑起来

服务器负责数据。改了 `server.js`、或者它崩了，就重启它。

```bash
# 1) 先关掉旧的
pkill -f "node server.js"

# 2) 进目录，带着口令重新启动
cd /home/young/WorkSpace/love
ROOM_KEY=123456 PORT=8787 node server.js
```

启动成功会看到「Feel My Heartbeat」和版本号，以及累计心跳、同频次数，日志里也会打印本机地址和局域网地址。
数据都存在同目录的 `hearts.json`，重启不会丢。

打开 `http://localhost:8787`，填名字和口令进去。

**想让它在后台一直跑、关掉终端也不停：**

```bash
cd /home/young/WorkSpace/love
ROOM_KEY=123456 PORT=8787 nohup node server.js > server.log 2>&1 &
```

之后看日志：`tail -f /home/young/WorkSpace/love/server.log`

---

## 让朋友连上

推荐 Cloudflare Tunnel，免费、不用买服务器、不用开路由器端口。
网址打不开、或者你重启了服务器，就重启隧道：

```bash
# 1) 关掉旧隧道
pkill -f "cloudflared tunnel"

# 2) 重新开一个，指向本机 8787
cloudflared tunnel --url http://localhost:8787
```

启动后屏幕上会刷出一大段，找这样一行框起来的网址：

```
+--------------------------------------------------------+
|  https://随机单词-随机单词.trycloudflare.com            |
+--------------------------------------------------------+
```

**这就是新网址，复制它发给对方。**

**想让它在后台跑、并且把网址记到文件里：**

```bash
cd /home/young/WorkSpace/love
nohup cloudflared tunnel --url http://localhost:8787 > tunnel.log 2>&1 &

# 等几秒，把网址捞出来
sleep 6 && grep -o 'https://.*trycloudflare.com' tunnel.log | head -1
```

**重启 node 不需要重启 cloudflared**，隧道只认端口不认进程。

临时隧道每次重启都换网址。想要固定网址，注册域名接到 Cloudflare，再建命名隧道（`cloudflared tunnel create` → `route dns`）。

### 对方怎么用

1. 确认两个进程都在跑（见下方「检查现在跑没跑」）。
2. 拿到当前的 `https://xxx.trycloudflare.com` 网址。
3. 把**网址**和**口令 `123456`** 发给对方。
4. 对方用手机／电脑浏览器打开网址，输入口令，就进房间了。
5. 你自己也打开同一个网址、同一个口令，两个人就连上了。

> 房间最多 4 个连接（`MAX_CLIENTS`），够两个人来回刷新用。

---

## 检查现在跑没跑

```bash
# 看两个进程在不在
ps aux | grep -E "server.js|cloudflared tunnel" | grep -v grep

# 看 8787 端口有没有在监听
ss -tlnp | grep 8787

# 本机自测网站（返回 HTML 就对了）
curl -s localhost:8787 | head -1
```

两个进程都在、端口在监听，就是正常的。

---

## 一键全部重启（先服务器后隧道）

```bash
cd /home/young/WorkSpace/love
pkill -f "node server.js"; pkill -f "cloudflared tunnel"
sleep 1
ROOM_KEY=123456 PORT=8787 nohup node server.js > server.log 2>&1 &
sleep 1
nohup cloudflared tunnel --url http://localhost:8787 > tunnel.log 2>&1 &
sleep 6
echo "新网址："; grep -o 'https://.*trycloudflare.com' tunnel.log | head -1
echo "口令：123456"
```

---

## 怎么玩

| | |
|---|---|
| 点一下 | 两边同时冒小爱心。你是粉色，对方是青色 |
| 按住不放 | 连发。空格键同理 |
| 同频 | 两人 3 秒内先后点击，两边一起爆开金色 |
| 对方不在时 | 你点的都攒着，等 TA 上线一次放出 |
| 小纸条 | 快捷词或自由输入，飘过两边屏幕。服务端留存，`?debug` 面板可翻 |
| 悬浮窗 | 始终置顶的小窗，需要 Chrome 或 Edge 116+ |

悬浮窗要求安全上下文，只有 `localhost` 和 `https://` 能开，`http://` 的局域网 IP 不行。

---

## 版本管理

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，前后端共用一个号。

**版本号写在三个地方，改的时候三处都要改：**

1. `package.json` 的 `version` 字段（唯一来源，服务端优先读它）
2. `server.js` 顶部的 `let VERSION`（读不到 package.json 时的兜底）
3. `index.html` 里的 `const VERSION`

**两道自动检查：**

- **启动时**：服务端会读 `index.html` 比对版本，不一致就在日志里警告
- **登录时**：前端向 `/check` 要服务端版本，对不上直接拦在登录页，提示「服务端是 X，前端是 Y」

这两道检查是从实际踩坑里来的 —— 更新时只换了一个文件、或者忘了重启，表现出来是各种莫名其妙的连接故障，很难排查。

改动记在 `CHANGELOG.md`。

---

## 排查

**看服务器眼里现在有谁**

```bash
curl "http://localhost:8787/who?key=你的口令"
```

返回连接数、每个人的名字、连了多久、多久没动静、有没有挂着的请求。

**清空统计**（调试数据积多了）

```bash
curl -X POST "http://localhost:8787/reset?key=你的口令"
```

**前端调试面板**

网址后面加 `?debug`，左下角显示前后端版本、连接状态、往返延迟、服务器推来的原始名单；
右下角是聊天记录面板，见下方「聊天记录」。

**常见情况**

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 对方说网址打不开 | 隧道网址变了（重启过），或隧道没跑 | 按「让朋友连上」重开，发新网址 |
| 能打开但进不去房间 / 提示口令不对 | 口令要一字不差 | 确认是 `123456` |
| 能打开但没有实时同步、心跳不动 | 服务器（node）没跑 | 按「跑起来」重启 |
| 登录页提示版本不一致 | 只换了一个文件，或者没重启 node | 三处版本对齐后重启 node |
| 两个人互相看不见 | 名字填成一样了 —— 按名字认人，同名会被当成同一个人 | 换个不一样的名字 |
| 改完 `server.js` 没生效 | node 要重启才会加载新代码 | 重启 node；改 `index.html` 前端不用重启，对方刷新即可 |
| 一直显示重连中 | 服务器没跑，或者隧道断了 | 检查两个进程 |
| 延迟高 | 隧道线路本身的往返时间 | 换命名隧道或 VPS 直连 |
| 数据不见了 | 没在同一个目录启动 | 检查 `hearts.json` 还在不在、是不是在同目录启动 |

---

## 通信

HTTP 长轮询。四个接口：

- `POST /join` 进房间拿 id
- `GET /poll` 取消息，有货立刻回，没货挂住最多 25 秒
- `POST /send` 发消息
- `POST /leave` 关页面时立刻下线

另有三个带口令的辅助接口：`/who` 看在线情况、`/reset` 清统计、`/history` 取聊天记录。

之所以是长轮询而不是更时髦的方案：SSE 经 Cloudflare 隧道会被缓冲，消息一阵一阵地到；WebSocket 的 upgrade 请求隧道压根不转发，握手直接失败。长轮询每次都是完整的短请求，没有需要保持的流，任何代理都拦不住。

细节见 `CHANGELOG.md` 里的早期迭代记录。

---

## 数据

统计存在 `hearts.json`，重启不丢。包含累计次数、今日次数、分人计数、同频次数，以及对方不在时攒下的心跳和纸条。

---

## 聊天记录

纸条会存在 `history/` 下，一天一个文件，文件名是当天日期：

```
history/20260727
```

一行一条 JSON（JSON Lines），追加写入，服务端不读回内存，攒多了也不吃内存：

```
{"t":1785123319008,"name":"yuang","text":"想你了"}
```

**怎么看**

网址后面加 `?debug`，右下角会出现记录面板：上面选日期，下面按 `时间 名字 内容` 列出来。
看的是今天就每 5 秒自动跟进，翻旧日期时不打扰。自己刚发的纸条会立刻出现。

也可以直接用命令行：

```bash
# 有哪几天的记录
curl "http://localhost:8787/history?key=你的口令"

# 看某一天
curl "http://localhost:8787/history?key=你的口令&date=20260727"
```

要删记录直接删文件：`rm history/20260727`。`/reset` 只清统计，不动记录。

> `history/` 和 `hearts.json` 一样在 `.gitignore` 里，不进仓库。
