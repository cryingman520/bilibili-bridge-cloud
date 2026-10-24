# Bilibili Bridge Cloud 3.1

这是现有 dsh-bilibili / Bilibili Bridge 的云端移植版，运行在 Sites / Cloudflare Workers，使用 R2 持久存储，不调用用户电脑或本地隧道。

## 功能

- MCP 2026-07-28 的 server/discover、tools/list、tools/call，以及旧版 initialize 兼容。
- 视频元数据、搜索、字幕、评论、弹幕，及按时间裁剪的 B站时间轴实际图像。
- 在私有页面用 B站客户端扫码登录；凭据以 AES-GCM 加密，按 ChatGPT 用户隔离。
- 账号资料、本人稿件、空间信息读取。
- 评论、回复、弹幕、文字动态、个人签名、空间公告、投稿草稿；在网页核对并确认后才执行。
- 云端分块上传、B站 UPOS 分片传输、上传与最终投稿分离。
- 手机或网页选择封面图片，浏览器压缩后上传；封面和视频都不会自动提交投稿。
- 带 `?p=` 的多分P链接使用对应的 cid、章节时长、字幕和弹幕。
- 视频追加分P的编辑草稿可通过工具创建，保留已有分P的 cid。
- 操作审计、重复确认防护、发送结果不明时停止自动重试。

## 开发与发布

```text
npm ci
npm test
npm run build
npm run validate
```

修改 src/ 下的模块；构建器把它们打包到 worker/index.js，再生成 dist/server/index.js。通过 Sites source workflow 同步源码并发布 dist 工件。

运行时变量：BILI_CREDENTIAL_KEY 为私有 32 字节 AES 密钥的 Base64；SITE_ORIGIN 为正式站点地址。密钥只配置在 Sites 环境变量中，不写入源码或浏览器。R2 绑定名为 BUCKET。

可选托管后端：`backend/server.mjs` 运行于 Node 22 及以上。`render.yaml` 选择 Render 免费实例；`Dockerfile.backend` 和 `railway.json` 供其他正常托管使用。托管端只需 `BILI_BACKEND_KEY`；Sites 端配置同一密钥以及固定 HTTPS 根域名 `BILI_BACKEND_URL`。后端不保存账号或视频文件，重启不会清空 R2 中的登录与草稿。后端未配置时保留原 Sites 直连路径；配置后失败不会偷偷切换线路或重发请求。

后端仅开放本项目实现的 B站接口、字幕、时间轴图像和 UPOS 分块上传；每次请求签名覆盖目标、请求头和原始二进制正文，并检查时效和进程内防重放。响应 Cookie 只在服务端处理。实际 B站发布仍由 Sites 的单次草稿确认控制，不依赖后端进程内缓存。免费实例休眠会有首次唤醒延迟，不能承诺随时立即响应。禁止通过持续请求规避免费休眠规则。

大型 JPEG / PNG 时间轴图像在托管后端裁剪后再返回小图片，避免占用 Sites 的图像解码内存。裁剪坐标也纳入签名。后端以 4 个上游请求槽处理请求，额外的已鉴权请求进入有上限的短队列；排队不是重新发送请求，412/429 和发送结果不明时仍停止。

部署后可用 `scripts/probe-backend.mjs` 实测元数据和二维码生成：通过标准输入提供 `{url,key}`，不要把密钥放在命令参数、仓库或聊天。测试不会登录或发布内容。只有线上请求实测通过后，才能把托管方案称为 B站可用。Render 的 Git 部署另需可访问的 GitHub/GitLab/Bitbucket 仓库；仅有 Sites 的内部源码快照还不够。

需要 Playwright 和 Edge 时，可运行 scripts/qa-ui.mjs 做隔离的桌面/手机布局检查；它使用模拟登录状态，不调用真实 B站账号。可通过 BRIDGE_QA_PLAYWRIGHT 指定现有 Playwright 安装。

## 证据边界

网站会话接口不是 B站开放平台的稳定合同。所有线上能力需要实际网络和有效登录；遇到账号验证、HTTP 412/429 或平台限制时停止并报告。没有实现验证码绕过或代理轮换。

时间轴图片是视频实际内容的低分辨率采样，不等同于任意时刻的高清 FFmpeg 帧。没有字幕时不会虚构文稿；当前未配置独立的云端语音转录服务。

测试覆盖凭据隔离、CSRF、草稿确认、重复发送防护、风控错误、时间轴图片映射及 MCP 协议。测试成功不等于真实账号发布验收；未经用户提供具体内容并确认，不进行实际发布测试。
