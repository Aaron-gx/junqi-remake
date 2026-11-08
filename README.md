# 军棋网页复刻与技术分析

基于 Android 应用 `com.cnvcs.junqi`（四国军棋，v1.58）的完整技术分析，
及其网页端复刻实现：**Vite + TypeScript + HTML5 Canvas** 的二人军棋（陆战棋）。

## 项目概述

原应用采用 Java + JNI + OpenGL ES 架构：Java 层仅承担应用生命周期与广告接入，
对局逻辑全部位于 native 库 `libjunqi.so`（ARM32），美术与音效资源存放于
自研加密容器格式 **SPAK** 之中。

本仓库包含两部分工作：

| 部分 | 目录 | 说明 |
|---|---|---|
| 技术分析 | `report/` `00-triage/` `scripts/` `evidence/` | 应用结构、资源格式、规则体系的完整解析，附可复现工具链与证据链 |
| 网页复刻 | `07-remake/` | 基于解析成果实现的网页版，界面与音效采用原版素材，呈现效果与原版一致 |

## 主要成果

| 层面 | 方法 | 结论 |
|---|---|---|
| Java 层 | jadx 静态分析 | 确认为 JNI/OpenGL 壳，业务逻辑全部位于 native |
| Native 层 | Ghidra headless | `libjunqi.so` 全部 6,158 个函数还原完成，无失败项 |
| 资源层 | 自研 SPAK 解析器 | 容器格式与加密算法完整还原，690/690 项资源全部解出 |
| 规则与数据 | 提取脚本 | 棋盘拓扑、走法表、AI 评级参数全部还原 |
| 网页复刻 | Vite + TS + Canvas | 棋盘、棋子、面板皮肤、音效与原版一致 |

复刻版直接采用原版解包素材：棋盘为原版 `board.png`（720×1071），棋子为原版
图集切片，面板为原版九宫格皮肤，音效为原版 `.wav`，因此界面与原版完全一致。

## 仓库结构

```
├── README.md               本文件
├── scope.md / timeline.md / workitems.md    分析流程契约与过程记录
├── report/                 技术分析报告（主交付物）
│   ├── 技术分析报告.md           总报告：结论、发现、复现方法
│   ├── 完整反编译结项报告.md       四层还原总结与 SPAK 算法细节
│   ├── 完全反编译路线.md         方法论
│   ├── 去广告与重制方案.md
│   └── ANIM-VERIFY.md
├── 00-triage/              侦察记录：应用指纹、Manifest、SPAK 解析过程
├── scripts/                可复现脚本：侦察、资源解包、数据表提取、Ghidra/Frida
├── evidence/               证据链（E-001~E-008）、工具日志、验收记录
└── 07-remake/              网页复刻版（可独立运行）
    ├── README.md / SPEC.md       实现说明、规则与数据结构文档
    ├── src/  server/  tests/  tools/
    └── public/                   原版素材（版权归原开发者所有）
```

## 快速开始

环境要求：Node.js ≥ 18。

```bash
cd 07-remake
npm install
npm run dev        # 开发服务器 http://localhost:5180
```

其他命令：

```bash
npm run typecheck  # TypeScript 类型检查
npm run test       # 核心逻辑自检（365 项）+ 网络对局回归测试（35 项）
npm run build      # 生产构建，输出至 dist/
```

内置交互与几何自检探针：`http://localhost:5180/?probe=1`

## 文档导读

| 若需了解 | 阅读 |
|---|---|
| 应用架构、资源体系与关键结论 | `report/技术分析报告.md` |
| SPAK 容器格式与加密算法细节 | `report/完整反编译结项报告.md` |
| 完整复现步骤 | `evidence/evidence-log.md` 与 `scripts/` |

## 版权与使用说明

1. 本项目仅用于学习与技术交流，不用于任何商业用途。
2. `07-remake/public/` 中的棋盘、棋子、音效等素材取自原应用，版权归原开发者
   所有；如有侵权请联系仓库所有者删除。
3. 本仓库不包含原 APK 及其反编译产物，相关内容仅本地留存。
