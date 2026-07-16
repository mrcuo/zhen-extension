# Zhen · 国翻

**极简英中网页翻译 Chrome 插件**

一键将英文网页翻译为中文，100% 保留原生排版。

## ✨ 特性

- 🚀 **极速翻译** — 视口优先翻译，先翻译可见内容，后台翻译剩余部分
- 🎯 **精准翻译** — 智能识别翻译单元，跨 inline 标签合并，保留完整语义
- 🔄 **动态内容** — MutationObserver 自动翻译新加载的内容（SPA / 无限滚动）
- 💾 **翻译缓存** — 缓存已翻译内容，避免重复 API 调用
- ⌨️ **快捷键** — `Alt+Z` 一键翻译
- 🔀 **多引擎** — 支持 Google 翻译（免费）、OpenAI / 兼容 API、DeepL
- 🎨 **零侵入** — 完美保留原页面排版和样式
- ↩️ **一键恢复** — 再次点击恢复原文

## 🚀 使用方法

1. 在 Chrome 中加载此插件（开发者模式 → 加载已解压的扩展程序）
2. 点击工具栏的 Zhen 图标
3. 选择"翻译此页"
4. 或使用快捷键 `Alt+Z`

## ⚙️ 配置

默认使用 **Google 翻译**（免费，无需 API Key）。

如需更高质量翻译，可在设置页切换引擎：

| 引擎 | API Key | 特点 |
|------|---------|------|
| Google 翻译 | 不需要 | 免费、速度快 |
| OpenAI / 兼容 | 需要 | 高质量、支持自定义端点 |
| DeepL | 需要 | 专业翻译质量 |

**兼容 API** 支持：OpenAI、DeepSeek、Kimi、Claude 等任何 OpenAI 兼容接口。

## 📂 文件结构

```
zhen/
├── manifest.json     # 扩展配置
├── background.js     # Service Worker（翻译调度 + API 调用 + 缓存）
├── content.js        # Content Script（DOM 遍历 + 翻译渲染）
├── popup.html/js     # 弹出窗口 UI
├── options.html/js   # 设置页面
├── icons/            # 扩展图标
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

## 🏗️ 技术架构

**参考了 [immersive-translate](https://github.com/nicedoc/immersive-translate) 和 [KISS Translator](https://github.com/nicedoc/kiss-translator) 的设计模式：**

1. **视口优先翻译** — 借鉴 IntersectionObserver 模式，先翻译用户可见内容
2. **DOM Walker** — 递归遍历 DOM 树，智能识别 block/inline 边界
3. **翻译单元合并** — 跨 `<span>`、`<a>` 等 inline 标签合并连续文本
4. **批量 API 调用** — 将文本分批发送，控制并发数量
5. **MutationObserver** — 监听 DOM 变化，自动翻译动态加载的内容
6. **Session 缓存** — 利用 `chrome.storage.session` 缓存翻译结果

## 📄 许可

MIT License
