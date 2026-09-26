# File Handler Lab

一个零依赖静态 PWA，用 File Handling API 注册为系统文件处理器，并用 File API、FileReader、DOM 和 IndexedDB 展示、预览及恢复文件处理记录。

## 运行

必须通过安全上下文访问：

```bash
python3 -m http.server 8080
```

然后打开 `http://localhost:8080`。部署到公网时需要 HTTPS。

## 系统注册

1. 使用支持 File Handling API 的 Chromium 内核浏览器打开应用。
2. 点击“注册为系统文件处理器”，或使用浏览器地址栏的“安装”入口安装 PWA。
3. 安装后，浏览器会根据 `manifest.webmanifest` 中的 `file_handlers` 静态注册系统文件关联。
4. 在系统文件管理器中右键受支持文件，选择“打开方式”并选择本应用。

浏览器不支持、非安全上下文、Service Worker 注册失败或 Manifest 配置无效时，页面会显示对应提示；手动选择和拖拽仍然可用。

## 支持类型

- 文本：`.txt`、`.md`、`.csv`、`.json`、`.xml`、`.yaml`、`.html`、`.css`、`.js`、`.ts` 等
- 图片：`.png`、`.jpg`、`.webp`、`.gif`、`.svg`、`.avif`、`.ico`、`.bmp`
- PDF：`.pdf`

文本通过 FileReader 读取并预览；图片生成缩略图；PDF 校验文件头后通过 object URL 预览。多文件进入串行队列，按选择顺序处理。

## 最近记录

处理结果会保存到 IndexedDB，最多保留 50 条。文本记录保存内容片段，图片记录保存缩略图；系统文件句柄可用时可从“最近处理记录”重新打开原文件。
