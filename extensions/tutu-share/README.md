# tutu-share（扩展）

token 化文件分享的 pi 扩展：注册 5 个工具（上传/列表/下载/删除/建目录）。

## 架构

```text
┌────────────┐  share_upload/list/…   ┌──────────────────┐
│  pi agent  │ ─────────────────────▶ │ upload  :60306   │ 固定基础服务
│ (本扩展)   │ ◀───────────────────── │ download:60307   │ 服务绑 0.0.0.0，
└────────────┘   HTTP/Range/JSON      └──────────────────┘ LAN 与 wg 均可达
```

**service 是固定独立运行的基础服务**（部署于存储机的
`/home/yjq/share-service/`，systemd 单元 `share-upload` / `share-download`，
两个服务均绑定 `0.0.0.0`）。
本项目**不部署、不管理、不加载**该服务，只通过固定端点使用：

| 端点 | 地址 | 说明 |
| ---- | ---- | ---- |
| upload (LAN) | `http://192.168.50.31:60306` | 家内 LAN 直连（本机有 192.168.50.x 网卡时自动选用） |
| upload (wg) | `http://192.168.125.11:60306` | wg0 隧道兑底（PUT/MKCOL/DELETE/GET /api/list，无鉴权，勿暴露公网） |
| download (LAN) | `http://192.168.50.31:60307` | 家内 LAN 直连 |
| download (wg) | `http://192.168.125.11:60307` | wg0 隧道兑底（token，支持 Range/HEAD/ETag） |

公网下载链接形如 `https://nas.tutu.gold/<16位token>`，不暴露目录与文件名。
端点与域名固定写死在 `index.ts`，无任何配置层。

**端点择优**：本机任一网卡 IPv4 落在 `192.168.50.0/24` 时，上传/下载走
LAN 直连端点（不经 wg，满速）；否则走 wg 端点。
**返回链接固定为公网** `https://nas.tutu.gold/<token>`，不随本机所处网络变化。
LAN 端点 `192.168.50.31` 依赖路由器 DHCP 保留固定，IP 变了需同步改 `index.ts`。

## 安装

`init.sh` 自动安装到 `~/.pi/agent/extensions/tutu-share/`，新 pi 会话自动加载，
已开会话可用 `/reload` 热加载。手工更新时直接覆盖该目录即可。

## 工具

| 工具 | 作用 |
| ---- | ---- |
| `share_upload(local_path, remote_path?)` | 上传并返回公网下载链接（家内走 LAN 直连上传；同路径重传 → token 不变） |
| `share_list()` | 已分享文件：路径/链接/大小/缺失标记（链接固定公网域名） |
| `share_download(source, local_path)` | 按 token 或远程路径下载到本机 |
| `share_delete(remote_path)` | 删除文件并撤销链接 |
| `share_mkdir(dir)` | 建目录 |

上传需本机在家庭 LAN（192.168.50.x）或 tutu 内网（wg0，见 skill `tutu-wg-init`）；
返回的下载链接固定为公网直链 `https://nas.tutu.gold`。
