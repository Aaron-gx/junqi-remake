# Timeline (append-only)

## 2026-09-10T14:48:16.1490415+08:00 | lead | init
- action: case-init
- command_or_ref: skills/scripts/case-init.ps1
- result_summary: case directory created; scope ready_for_act=true
- artifacts: [scope.md, workitems.md]
- evidence_ids: []
- decision_delta: [case_initialized]
- carry_forward_refs: [scope.md]
- next: open PRIMARY SKILL.md and ACT within scope

## 2026-09-10T14:46+08:00 | lead | toolchain
- action: bootstrap jadx + apktool（用户确认后按技能 manifest 安装）
- command_or_ref: curl -x http://127.0.0.1:7897（GitHub 直连被拦，走 Clash 代理）→ %USERPROFILE%\Tools\
- result_summary: jadx 1.5.6 / apktool 3.0.2 安装完成，SHA-256 与 manifest 一致；refresh-tool-index 后 tool-index 标记可用
- artifacts: []
- evidence_ids: []
- decision_delta: [toolchain_ready]
- carry_forward_refs: [evidence/evidence-log.md]
- next: 侦察样本

## 2026-09-10T14:47+08:00 | lead | fix
- action: 修复 reverse-skill `case-init.ps1:198` 管道调用 bug
- command_or_ref: Edit skills/scripts/case-init.ps1
- result_summary: Windows PowerShell 5.1 下 `& <powershell.exe> -File x.ps1 | Out-Null` 抛 "无法在管道中间运行文档"，改为 `$null = & ... 2>&1` 后 case-init 正常
- artifacts: [scope.md, timeline.md, workitems.md, README.md]
- evidence_ids: []
- decision_delta: [skill_bug_fixed]
- carry_forward_refs: []
- next: triage

## 2026-09-10T14:50+08:00 | lead | recon
- action: APK 侦察 + jadx 全量反编译 + apktool 解包 + ELF 侦察
- command_or_ref: scripts/apk_triage.py / jadx 1.5.6 / apktool 3.0.2 / scripts/elf_triage.py
- result_summary: com.cnvcs.junqi v1.58；1 dex / 1224 类 / 12788 方法；未加壳；Java 501 文件（0 错误）；smali 1223；libjunqi.so ARM32 15 个 JNI 导出、无网络无反调试；assets 为自研 SPAK 分片容器
- artifacts: [00-triage/*, 01-java/sources, 02-apktool, 03-native, evidence/evidence-log.md]
- evidence_ids: [E-001, E-002, E-003, E-004, E-005, E-006, E-007, E-008]
- decision_delta: [java_layer_fully_recovered, core_logic_is_native]
- carry_forward_refs: [report/技术分析报告.md]
- next: libjunqi.so native 反编译（Ghidra/IDA）以还原军棋规则与 AI

## 2026-09-10T15:00+08:00 | lead | report
- action: 输出技术分析报告与目录规范
- command_or_ref: report/技术分析报告.md
- result_summary: F-001~F-006 汇总；明确未完成项（native 反编译、SPAK 解包）与复现命令
- artifacts: [report/技术分析报告.md, README.md, workitems.md]
- evidence_ids: [E-001, E-005, E-007, E-008]
- decision_delta: [phase1_complete]
- carry_forward_refs: [report/技术分析报告.md]
- next: 等用户确认是否继续 native 反编译