# AndroidManifest 摘要 — `com.cnvcs.junqi`

来源：`02-apktool/AndroidManifest.xml`（apktool 3.0.2 解码）

## 基本信息

| 项 | 值 |
|---|---|
| package | `com.cnvcs.junqi` |
| installLocation | `auto` |
| minSdk / targetSdk | 见 `02-apktool/apktool.yml` |
| usesCleartextTraffic | **true**（允许明文 HTTP） |
| allowBackup | **true** |
| appComponentFactory | `android.support.v4.app.CoreComponentFactory`（旧 support 库） |
| icon / label | `@mipmap/ic_launcher` / `@string/app_name` |

## 权限

| 权限 | 风险说明 |
|---|---|
| `INTERNET` | 网络访问 |
| `ACCESS_NETWORK_STATE` | 网络状态 |
| `ACCESS_WIFI_STATE` | WiFi 状态 |
| `WRITE_EXTERNAL_STORAGE` | 外部存储写入（旧版危险权限） |
| `READ_PHONE_STATE` | **读取设备标识**（IMEI 等，属敏感权限） |
| `ACCESS_COARSE_LOCATION` | 粗略定位（广告 SDK 常申请） |
| `BLUETOOTH` / `BLUETOOTH_ADMIN` | 蓝牙（对战/手柄用途） |
| `REQUEST_INSTALL_PACKAGES` | **可触发 APK 安装**（配合广告 SDK 的落地页下载） |
| `CHANGE_NETWORK_STATE` | 改变网络状态 |
| `QUERY_ALL_PACKAGES` | **枚举全部已安装应用**（Google Play 政策敏感项） |

## 组件

| 类型 | 名称 | exported | 说明 |
|---|---|---|---|
| activity | `com.cnvcs.App` | 隐式 exported（含 LAUNCHER intent-filter） | **唯一入口**，纵向固定，`Theme.Black.NoTitleBar` |
| provider | `com.cnvcs.ShareProvider` | false | 继承 `android.support.v4.content.FileProvider`，用于分享文件 |
| provider | `com.qq.e.comm.GDTFileProvider` | false | 广点通 SDK |
| service | `com.qq.e.comm.DownloadService` | false | 广点通广告 APK 下载服务（`multiprocess=true`） |
| activity | `com.qq.e.ads.ADActivity` | — | 广点通广告位 |
| activity | `com.qq.e.ads.PortraitADActivity` | — | 竖屏广告位 |
| activity | `com.qq.e.ads.LandscapeADActivity` | — | 横屏广告位 |
| activity | `com.qq.e.ads.RewardvideoPortraitADActivity` | — | 激励视频（竖屏，含刘海屏适配） |
| activity | `com.qq.e.ads.RewardvideoLandscapeADActivity` | — | 激励视频（横屏） |

## meta-data

| 名称 | 值 |
|---|---|
| `android.max_aspect` | `2.7`（适配长屏） |
| `android.notch_support` | `true`（激励视频 Activity） |

## 结论

组件结构极简：**1 个业务 Activity + 1 个自有 Provider + 1 个广播接收器（`BtReceiver`，未在 Manifest 注册，属代码内动态注册）+ 1 套广点通广告组件**。
业务逻辑不在 Java 层，入口 `com.cnvcs.App` 全部转发到 `libjunqi.so`。
