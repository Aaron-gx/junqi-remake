// 导出 Ghidra 分析结果：函数清单、调用图、字符串表、逐函数 C 伪代码与合并文件。
//@category Junqi
//@keybinding
//@menupath
//@toolbar

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.util.task.ConsoleTaskMonitor;

import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class JunqiExport extends GhidraScript {

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String outDir = (args.length > 0) ? args[0] : ".";
        File dir = new File(outDir);
        File decDir = new File(dir, "decompiled");
        if (!decDir.exists()) {
            decDir.mkdirs();
        }

        FunctionManager fm = currentProgram.getFunctionManager();
        Listing listing = currentProgram.getListing();
        ReferenceManager rm = currentProgram.getReferenceManager();
        ConsoleTaskMonitor mon = new ConsoleTaskMonitor();

        // ---------- 1) 字符串表 + 交叉引用 ----------
        Map<String, List<String>> strXref = new LinkedHashMap<String, List<String>>();
        PrintWriter strings = new PrintWriter(new File(dir, "strings.tsv"), "UTF-8");
        strings.println("#address\tfunction\ttrigger");
        DataIterator di = listing.getDefinedData(true);
        int strCount = 0;
        while (di.hasNext()) {
            Data d;
            try {
                d = di.next();
            } catch (Exception e) {
                break;
            }
            Object v;
            try {
                v = d.getValue();
            } catch (Exception e) {
                continue;
            }
            if (!(v instanceof String)) {
                continue;
            }
            String val = ((String) v).trim();
            if (val.length() < 3) {
                continue;
            }
            strCount++;
            Address a = d.getAddress();
            ReferenceIterator ri = rm.getReferencesTo(a);
            List<String> fns = new ArrayList<String>();
            while (ri.hasNext()) {
                Reference r = ri.next();
                Function f = fm.getFunctionContaining(r.getFromAddress());
                if (f != null) {
                    fns.add(f.getName() + "@" + f.getEntryPoint());
                    strings.println(a + "\t" + f.getName() + "\t" + oneLine(val));
                }
            }
            if (!fns.isEmpty()) {
                strXref.put(a + "|" + oneLine(val), fns);
            }
        }
        strings.flush();
        strings.close();
        writeStringsXref(new File(dir, "strings-xref.json"), strXref);

        // ---------- 2) 函数清单 + C 伪代码 ----------
        DecompInterface dec = new DecompInterface();
        dec.setOptions(new ghidra.app.decompiler.DecompileOptions());
        dec.toggleCCode(true);
        dec.toggleSyntaxTree(true);
        if (!dec.openProgram(currentProgram)) {
            println("[JunqiExport] 反编译器初始化失败: " + dec.getLastMessage());
        }

        PrintWriter ftsv = new PrintWriter(new File(dir, "functions.tsv"), "UTF-8");
        ftsv.println("#addr\tname\tsize\tparams\tcallers\tcallees\tflags");
        PrintWriter all = new PrintWriter(new File(decDir, "_all-decompiled.c"), "UTF-8");
        all.println("/* libjunqi.so —— Ghidra 12.1.3 全量反编译结果（等价 C 伪代码）");
        all.println(" * 样本: com.cnvcs.junqi v1.58  base.apk → libjunqi.so");
        all.println(" * 架构: ARM 32-bit LE (ARMv7/Thumb-2)  已 strip");
        all.println(" * 注意: 变量名/函数名为推断结果，非原始符号 */");
        all.println();

        StringBuilder nodes = new StringBuilder();
        StringBuilder edges = new StringBuilder();
        Map<Long, Integer> index = new LinkedHashMap<Long, Integer>();

        FunctionIterator fit = fm.getFunctions(true);
        List<Function> funcs = new ArrayList<Function>();
        while (fit.hasNext()) {
            funcs.add(fit.next());
        }
        int i = 0;
        for (Function f : funcs) {
            long key = f.getEntryPoint().getOffset();
            index.put(Long.valueOf(key), Integer.valueOf(i));
            i++;
        }

        int ok = 0;
        int fail = 0;
        i = 0;
        for (Function f : funcs) {
            long key = f.getEntryPoint().getOffset();
            String name = f.getName();
            long size = f.getBody().getNumAddresses();
            int params = f.getParameterCount();
            int nc = 0;
            int ncall = 0;
            StringBuilder callers = new StringBuilder();
            StringBuilder callees = new StringBuilder();
            try {
                for (Function cf : f.getCallingFunctions(mon)) {
                    nc++;
                    Integer ci = index.get(Long.valueOf(cf.getEntryPoint().getOffset()));
                    if (ci != null) {
                        callers.append(ci).append(",");
                    }
                }
            } catch (Exception e) {
                // ignore
            }
            try {
                for (Function tf : f.getCalledFunctions(mon)) {
                    ncall++;
                    Integer ci = index.get(Long.valueOf(tf.getEntryPoint().getOffset()));
                    if (ci != null) {
                        callees.append(ci).append(",");
                        edges.append("[").append(i).append(",").append(ci).append("],");
                    }
                }
            } catch (Exception e) {
                // ignore
            }
            String flags = "";
            if (f.isThunk()) {
                flags += "thunk ";
            }
            if (f.isExternal()) {
                flags += "external ";
            }
            if (f.hasNoReturn()) {
                flags += "noreturn ";
            }
            ftsv.println(f.getEntryPoint() + "\t" + name + "\t" + size + "\t" + params
                    + "\t" + nc + "\t" + ncall + "\t" + flags.trim());

            // 调用图节点
            nodes.append("{\"id\":").append(i)
                    .append(",\"addr\":\"").append(f.getEntryPoint())
                    .append("\",\"name\":\"").append(esc(name))
                    .append("\",\"size\":").append(size)
                    .append(",\"params\":").append(params)
                    .append(",\"flags\":\"").append(flags.trim()).append("\"},");

            // C 伪代码
            String c = null;
            try {
                DecompileResults dr = dec.decompileFunction(f, 90, mon);
                if (dr != null && dr.decompileCompleted() && dr.getDecompiledFunction() != null) {
                    c = dr.getDecompiledFunction().getC();
                }
            } catch (Exception e) {
                c = null;
            }
            String fname = safeFileName(name) + "__" + String.format("%08x", key) + ".c";
            PrintWriter pw = new PrintWriter(new File(decDir, fname), "UTF-8");
            pw.println("/* " + name + " @ " + f.getEntryPoint() + "  size=" + size + " bytes */");
            if (c != null) {
                pw.println(c);
                ok++;
            } else {
                pw.println("/* 反编译失败，仅反汇编 */");
                fail++;
            }
            pw.flush();
            pw.close();

            all.println("/* ============================================================");
            all.println(" * " + name + " @ " + f.getEntryPoint() + "  size=" + size
                    + "  callers=" + nc + "  callees=" + ncall + "  " + flags.trim());
            all.println(" * ============================================================ */");
            if (c != null) {
                all.println(c);
            } else {
                all.println("/* 反编译失败 */");
            }
            all.println();
            i++;
        }
        ftsv.flush();
        ftsv.close();
        all.flush();
        all.close();

        // ---------- 3) 调用图 JSON ----------
        PrintWriter cg = new PrintWriter(new File(dir, "callgraph.json"), "UTF-8");
        cg.println("{\"program\":\"" + esc(currentProgram.getName()) + "\",");
        cg.println("\"imageBase\":\"" + currentProgram.getImageBase() + "\",");
        cg.println("\"nodes\":[" + trim(nodes.toString()) + "],");
        cg.println("\"edges\":[" + trim(edges.toString()) + "]}");
        cg.flush();
        cg.close();

        // ---------- 4) 摘要 ----------
        PrintWriter su = new PrintWriter(new File(dir, "ghidra-summary.txt"), "UTF-8");
        su.println("程序名    : " + currentProgram.getName());
        su.println("装载基址  : " + currentProgram.getImageBase());
        su.println("处理器    : " + currentProgram.getLanguageID());
        su.println("编译器规格: " + currentProgram.getCompilerSpec().getCompilerSpecID());
        su.println("函数总数  : " + funcs.size());
        su.println("反编译成功: " + ok);
        su.println("反编译失败: " + fail);
        su.println("已定义字符串: " + strCount);
        su.println("带交叉引用的字符串: " + strXref.size());
        su.flush();
        su.close();

        println("[JunqiExport] 函数 " + funcs.size() + " / 成功 " + ok + " / 失败 " + fail
                + " / 字符串 " + strCount);
    }

    private void writeStringsXref(File f, Map<String, List<String>> m) throws Exception {
        PrintWriter pw = new PrintWriter(f, "UTF-8");
        pw.println("{");
        int n = 0;
        for (Map.Entry<String, List<String>> e : m.entrySet()) {
            String[] kv = e.getKey().split("\\|", 2);
            pw.print("  \"" + esc(kv[0]) + "\": {\"text\":\"" + esc(kv.length > 1 ? kv[1] : "") + "\", \"refs\":[");
            for (int i = 0; i < e.getValue().size(); i++) {
                if (i > 0) {
                    pw.print(", ");
                }
                pw.print("\"" + esc(e.getValue().get(i)) + "\"");
            }
            pw.print("]}");
            n++;
            if (n < m.size()) {
                pw.print(",");
            }
            pw.println();
        }
        pw.println("}");
        pw.flush();
        pw.close();
    }

    private String trim(String s) {
        if (s.endsWith(",")) {
            return s.substring(0, s.length() - 1);
        }
        return s;
    }

    private String safeFileName(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length() && sb.length() < 80; i++) {
            char c = s.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '_' || c == '.' || c == '-') {
                sb.append(c);
            } else {
                sb.append('_');
            }
        }
        return sb.length() == 0 ? "FUN" : sb.toString();
    }

    private String esc(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') {
                sb.append('\\').append(c);
            } else if (c == '\n') {
                sb.append("\\n");
            } else if (c == '\r') {
                sb.append("\\r");
            } else if (c == '\t') {
                sb.append("\\t");
            } else if (c < 0x20) {
                sb.append(' ');
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private String oneLine(String s) {
        String r = s.replace("\t", " ").replace("\r", " ").replace("\n", " ");
        if (r.length() > 120) {
            r = r.substring(0, 120);
        }
        return r;
    }
}
