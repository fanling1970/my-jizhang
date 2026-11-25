# my-jizhang · 家庭记账本

一个跑在浏览器里的家庭日常收支记录小工具，打包成 Docker 镜像，可直接部署在 ARM64 路由器 / NAS 上。左侧目录树按「笔记本 → 年份 → 月份」组织，右侧是带格式的编辑窗口。

## 功能

- **目录树 + 编辑窗口**：左侧「我的笔记本 → 2026年 → 2026年1~12月」，右侧为对应月份的记账页；界面对齐思源笔记的观感。支持新建文档 / 目录、重命名、删除、右键菜单、顶部标签页、面包屑。
- **收入 / 支出（表格形态）**：点击工具栏「＋收入」或「－支出」，会在光标处插入一张账目表（或往当前文档已有的表格里追加一行），列为 `日期 / 类型 / 内容 / 金额`；表格底部自带合计行，实时显示本表**收入、支出、结余**。
- **自动合计**：点击「自动合计」插入文档级合计卡，汇总本页所有表格的收入、支出与结余，录入即更新。
- **图片**：支持「插入图片」（本地文件、粘贴剪贴板图片）和「网络图片」（填 URL）。一次选多张会**一张一行**插入，互不影响，可单独删除。鼠标移到图片上，右上角出现 `⋮`，点开菜单可改地址/标题/提示文本、向左/向右旋转 90°、居中/居左、按 px 或百分比精确设置宽高、复制、剪切、删除。
- **文字格式**：字号（12~32）、加粗、倾斜、下划线、撤销/重做。
- **即时保存**：输入后 250 毫秒自动保存，另有每 5 秒兜底保存；切换文档、切到后台、关闭页面时用 `sendBeacon` 强制落盘，不会丢内容。

## 本地运行（开发调试）

需要 Node.js 18+，无需安装任何依赖：

```bash
node server.mjs
```

打开 http://localhost:8080 。数据保存在项目下的 `data/ledger.json`。

可用环境变量：`PORT`（默认 8080）、`DATA_DIR`（默认 `./data`）。

## 镜像构建（GitHub Actions）

仓库已内置工作流 [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)：

- 推送到 `main` / `master` 分支，或打 `v*` 标签，或手动触发，都会自动构建。
- 用 QEMU + Buildx 构建 **linux/arm64 + linux/amd64** 多架构镜像，推送到 GitHub Container Registry。
- 镜像地址：`ghcr.io/<GitHub用户名>/my-jizhang:latest`（本仓库为 `ghcr.io/fanling1970/my-jizhang:latest`）。

首次构建完成后，在 GitHub 仓库右侧 **Packages** 里能看到该镜像。若路由器拉取提示无权限，把该 Package 的可见性改成 **Public**（Package → Settings → Change visibility），或在路由器上先登录：

```bash
docker login ghcr.io -u fanling1970   # 密码填带 read:packages 权限的 PAT
```

## 路由器部署（ARM64）

> 前提：路由器已装 Docker（如 OpenWrt 的 dockerd、或自带容器功能的路由系统），并能访问外网拉取镜像。

### 方式一：docker run

```bash
docker pull ghcr.io/fanling1970/my-jizhang:latest

docker run -d \
  --name my-jizhang \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /mnt/usb/my-jizhang:/data \
  -e TZ=Asia/Shanghai \
  ghcr.io/fanling1970/my-jizhang:latest
```

把 `/mnt/usb/my-jizhang` 换成路由器上真实存在的持久化目录（U 盘、外接硬盘或 overlay 空间），否则重启后数据会丢。

### 方式二：docker compose（推荐）

把仓库里的 [docker-compose.yml](docker-compose.yml) 放到路由器上，执行：

```bash
docker compose up -d
```

然后浏览器访问 `http://路由器IP:8080`，手机、电脑在同一局域网内都能用。

### 常用运维

```bash
docker compose pull && docker compose up -d   # 更新到最新镜像
docker logs -f my-jizhang                     # 查看日志
docker restart my-jizhang                     # 重启
```

数据只有一个文件：挂载目录下的 `ledger.json`，直接复制走即可备份。

## 目录结构

```
server.mjs                     零依赖 Node 服务：静态资源 + 文档 CRUD + JSON 持久化
public/index.html              页面结构（顶栏 / 目录树 / 工具栏 / 编辑区）
public/styles.css              界面样式
public/app.js                  目录树、编辑器、收支块、合计、图片与格式逻辑
Dockerfile                     镜像定义（node:20-alpine）
docker-compose.yml             路由器 / NAS 部署模板
.github/workflows/docker-publish.yml   ARM64 + AMD64 镜像构建与推送
```
