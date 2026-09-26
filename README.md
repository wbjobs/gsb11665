# 系统文件处理器（PWA）

注册为系统文件处理器，用户可从系统「打开方式」直接把文件交给本网页处理，展示文件名、类型、内容预览。支持多文件、拖拽、手动选择，并对各类异常场景给出提示与降级。

## 技术栈

File Handling API + File API + FileReader + DOM + IndexedDB（无框架、无构建步骤）

## 运行方式

File Handling API 要求**安全上下文**（HTTPS 或 localhost）且应用被**安装为 PWA**：

```bash
python3 -m http.server 8080   # 或任意静态服务器
# 浏览器打开 http://localhost:8080
# Chrome / Edge：地址栏点击“安装”图标安装应用
# 之后在文件管理器中右键 .txt/.md/.json/.png 等文件 → 打开方式 → 系统文件处理器
```

## 文件说明

- `manifest.webmanifest` — 通过 `file_handlers` 声明可处理的文件类型，注册为系统文件处理器
- `sw.js` — Service Worker，提供离线缓存，是 PWA 可安装的前提
- `index.html` — 页面结构：能力检测、拖拽区、本次处理、历史记录
- `app.js` — 核心逻辑（launchQueue 消费、FileReader 预览、IndexedDB 记录、降级方案）
- `style.css` — 样式

## 验收标准对照

| 验收标准 | 实现 |
| --- | --- |
| 注册成功后可被系统调用 | `manifest.webmanifest` 的 `file_handlers` + `launchQueue.setConsumer` 消费系统传入的文件句柄 |
| 文件预览正确 | 文本类用 `FileReader.readAsText` 预览（超长截断）；图片类用 `URL.createObjectURL` 缩略图 |
| 多文件按顺序处理 | `processFiles` 串行 `await` 逐个处理 |
| 不支持时有降级方案 | 检测 `launchQueue` 缺失时提示，并始终提供「拖拽 + `<input type=file>`」手动选择 |
| 注册失败有提示 | `navigator.serviceWorker.register` 失败时显示错误横幅 + toast |
| 类型不匹配有提示 | `isAcceptedFile` 校验扩展名/MIME，不匹配时 toast + 卡片标记 |
| 读取失败有提示 | `FileReader.onerror` / `handle.getFile()` 异常均有 toast + 卡片标记 |
| 重复打开不崩 | 会话内按 `名称|大小|修改时间` 去重，重复打开仅提示不重复渲染 |
| 最近处理记录可恢复 | 处理结果写入 IndexedDB（含文本预览/图片 Blob），刷新页面自动恢复，可一键清空 |
| 非安全上下文 | `isSecureContext` 检测，提示改用 HTTPS/localhost |
| 文件被删除 | `handle.getFile()` 抛错时提示“文件可能已被删除或移动” |

## 支持的文件类型

文本：`.txt` `.log` `.md` `.csv`；数据：`.json`；图片：`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`
