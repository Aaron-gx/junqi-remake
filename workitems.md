# Work Items

| ID | title | role | targets | surface | status | evidence | notes |
|----|-------|------|---------|---------|--------|----------|-------|
| WI-001 | Establish scope and auth | lead | case | process | done | scope.md | offline-sample preset, auth=granted |
| WI-002 | Install jadx + apktool toolchain | lead | host | process | done | evidence-log.md | 1.5.6 / 3.0.2，哈希与 manifest 一致 |
| WI-003 | APK triage（指纹/加固/DEX/权限/组件） | lead | base.apk | static | done | E-001~E-003, E-008 | 未加壳，1224 类 |
| WI-004 | Java 层全量反编译 | lead | classes.dex | static | done | E-004 | 501 java / 0 错误 / 81876 行 |
| WI-005 | smali 与资源解包 | lead | base.apk | static | done | E-004 | 1223 smali / 233 res / 8 pak |
| WI-006 | native 库侦察 | lead | libjunqi.so | static | done | E-005, E-006 | ARM32，15 JNI 导出，自研引擎 |
| WI-007 | 资源容器格式识别 | lead | assets/*.pak | static | done | E-007 | SPAK 分片容器 |
| WI-008 | **native 反编译（军棋规则/AI/协议）** | lead | libjunqi.so | static+native | **pending** | — | 需 Ghidra headless 或 IDA Pro |
| WI-009 | SPAK 解包脚本 | lead | assets/*.pak | static | **pending** | — | 依赖 WI-008 定位解包函数 |
| WI-010 | 动态验证（Frida on MuMu 12） | lead | device | dynamic | **pending** | — | adb connect 127.0.0.1:7555（需 scope 授权设备） |

## Coverage
- [x] Recon/analysis complete for in_scope assets（Java 层 100%）
- [x] Critical/High candidates triaged（无高危；F-002~F-004 为低-中风险配置项）
- [x] Validated findings have Evidence (E-001~E-008)
- [x] Path documented（Java→JNI→libjunqi.so 调用路径已闭环记录）
- [x] Timeline continuous across major phases
- [x] Report 已产出（report/技术分析报告.md，未走 docs-generator skill）
- [ ] field-journal anonymized（未产出 journal）

## Refs
- skills/ops/timeline-workitem.md
- skills/ops/evidence-finding-path.md
- report/技术分析报告.md
- evidence/evidence-log.md
