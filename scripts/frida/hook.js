/*
 * Frida hook: com.cnvcs.junqi v1.58
 * 目的：
 *   1) 观察 Java↔native 事件总线（OnEvent 的 (String, String) 是业务主通道）
 *   2) 追踪 libc 的 open/openat/fopen，直接暴露 SPAK 容器的读取与挂载路径
 *   3) 打印模块基址，便于把静态偏移换算成运行时地址
 * 用法：
 *   frida -U -f com.cnvcs.junqi -l hook.js --no-pause
 */

'use strict';

var CONFIG = {
    logFiles: true,      // 追踪文件打开
    logFrame: false,     // OnUpdate 每帧都调，默认关闭
    logTouch: false
};

function tag(s) {
    return '[junqi] ' + s;
}

/* ---------------- 1. 模块信息 ---------------- */
function dumpModules() {
    Process.enumerateModules().forEach(function (m) {
        if (m.name.indexOf('junqi') >= 0 || m.name.indexOf('libc') >= 0) {
            console.log(tag('module ' + m.name + ' base=' + m.base + ' size=' + m.size + ' path=' + m.path));
        }
    });
}

/* ---------------- 2. Java 层 native 方法 ---------------- */
function hookJava() {
    Java.perform(function () {
        var App;
        try {
            App = Java.use('com.cnvcs.App');
        } catch (e) {
            console.log(tag('App 类加载失败: ' + e));
            return;
        }
        console.log(tag('App 类已加载, classloader ok'));

        function wrap(methodName, sigs, dump) {
            try {
                var m = (sigs && sigs.length) ? App[methodName].overload.apply(App[methodName], sigs) : App[methodName];
                m.implementation = function () {
                    try {
                        var args = Array.prototype.slice.call(arguments);
                        if (dump) {
                            dump(args);
                        }
                    } catch (e) {
                        console.log(tag(methodName + ' hook 内部错误: ' + e));
                    }
                    return m.call.apply(m, [this].concat(Array.prototype.slice.call(arguments)));
                };
                console.log(tag('hooked App.' + methodName));
            } catch (e) {
                console.log(tag('hook ' + methodName + ' 失败: ' + e));
            }
        }

        // 事件总线：(name, payload) —— Junqi.* 协议消息都走这里
        wrap('OnEvent', ['java.lang.String', 'java.lang.String'], function (a) {
            console.log(tag('OnEvent  name=' + a[0] + '  payload=' + JSON.stringify(String(a[1]))));
        });

        wrap('OnCreate', null, function () { console.log(tag('OnCreate  ← 初始化开始')); });
        wrap('OnDestroy', null, function () { console.log(tag('OnDestroy')); });
        wrap('OnResume', null, null);
        wrap('OnPause', null, null);
        wrap('OnGraphCreate', null, function () { console.log(tag('OnGraphCreate ← GL 上下文就绪 (资源加载点)')); });
        wrap('OnGraphChange', null, function (a) { console.log(tag('OnGraphChange w=' + a[0] + ' h=' + a[1])); });
        wrap('OnInput', ['java.lang.String'], function (a) { console.log(tag('OnInput  text=' + JSON.stringify(String(a[0])))); });
        wrap('OnPermission', null, function (a) { console.log(tag('OnPermission req=' + a[0] + ' result=' + a[2])); });
        wrap('OnResult', null, function (a) { console.log(tag('OnResult  req=' + a[0] + ' res=' + a[1])); });
        wrap('OnBluetooth', null, function () { console.log(tag('OnBluetooth')); });

        if (CONFIG.logFrame) {
            wrap('OnUpdate', null, null);
            wrap('OnTimer', null, null);
        } else {
            // 只统计调用次数，避免刷屏
            try {
                var cnt = { u: 0, t: 0 };
                var mu = App.OnUpdate;
                mu.implementation = function () {
                    if (cnt.u === 0 || cnt.u % 120 === 0) {
                        console.log(tag('OnUpdate 第 ' + cnt.u + ' 帧'));
                    }
                    cnt.u++;
                    return mu.call(this);
                };
                var mt = App.OnTimer;
                mt.implementation = function () {
                    if (cnt.t === 0 || cnt.t % 50 === 0) {
                        console.log(tag('OnTimer 第 ' + cnt.t + ' 次'));
                    }
                    cnt.t++;
                    return mt.call(this);
                };
                console.log(tag('hooked App.OnUpdate / OnTimer (采样)'));
            } catch (e) {
                console.log(tag('hook 帧循环失败: ' + e));
            }
        }

        if (CONFIG.logTouch) {
            wrap('OnKey', null, null);
            wrap('OnTouch', null, null);
        }
    });
}

/* ---------------- 3. libc 文件访问追踪 ---------------- */
function hookFileIO() {
    var libc = Process.findModuleByName('libc.so');
    if (!libc) {
        console.log(tag('libc.so 未找到，跳过文件追踪'));
        return;
    }

    function attach(name, argIndex) {
        var addr = null;
        try {
            addr = Module.findExportByName('libc.so', name);
        } catch (e) {
            addr = null;
        }
        if (!addr) {
            console.log(tag('libc.' + name + ' 未导出，跳过'));
            return;
        }
        Interceptor.attach(addr, {
            onEnter: function (args) {
                try {
                    var p = args[argIndex];
                    if (p.isNull()) {
                        return;
                    }
                    var path = p.readCString();
                    if (path && (path.indexOf('/data') === 0 || path.indexOf('/sdcard') === 0 ||
                        path.indexOf('.pak') > 0 || path.indexOf('junqi') > 0 ||
                        path.indexOf('.apk') > 0 || path.indexOf('sg/') > 0)) {
                        console.log(tag(name + '(' + path + ')'));
                    }
                } catch (e) {
                    // ignore
                }
            }
        });
        console.log(tag('hooked libc.' + name));
    }

    attach('open', 0);
    attach('openat', 1);
    attach('fopen', 0);
    attach('stat', 0);
}

/* ---------------- 4. 常用导出，便于运行时手工调用 ---------------- */
var R = new Rpc.exports = {};

R.dumpModule = function () {
    var base = Module.findBaseAddress('libjunqi.so');
    return base ? base.toString() : 'null';
};

R.jniAddrs = function () {
    var base = Module.findBaseAddress('libjunqi.so');
    if (!base) {
        return {};
    }
    var offs = {
        OnPause: 0x1d8a9, OnResume: 0x1d8b9, OnGraphCreate: 0x1d8c9, OnGraphChange: 0x1d8d9,
        OnUpdate: 0x1d8e9, OnTimer: 0x1d8f9, OnKey: 0x1d909, OnTouch: 0x1d919,
        OnBluetooth: 0x1d929, OnResult: 0x1d939, OnPermission: 0x1d949, OnInput: 0x1d959,
        OnEvent: 0x1d969, OnCreate: 0x1da4d, OnDestroy: 0x1dab9
    };
    var out = {};
    for (var k in offs) {
        out[k] = base.add(offs[k]).toString();
    }
    return out;
};

/* ---------------- 启动 ---------------- */
console.log(tag('脚本载入, pid=' + Process.id + ' arch=' + Process.arch));
setTimeout(function () {
    dumpModules();
    hookFileIO();
    hookJava();
    console.log(tag('全部 hook 就绪'));
}, 0);
