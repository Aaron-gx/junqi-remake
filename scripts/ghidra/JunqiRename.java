// 基于字符串交叉引用，把匿名函数（FUN_xxx）重命名为业务语义名。
// 用途：libjunqi.so 已 strip，817 个函数默认叫 FUN_xxx；但样本字符串全明文，
//      通过 "引用了哪条字符串" 可以反推函数用途。
//@category Junqi
//@keybinding
//@menupath
//@toolbar

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.SymbolTable;

import java.io.File;
import java.io.PrintWriter;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class JunqiRename extends GhidraScript {

    private static final int MAX_NAME = 60;

    private final Set<String> taken = new HashSet<String>();
    private int renamed = 0;
    private int considered = 0;
    private int skippedNamed = 0;
    private PrintWriter mapOut;

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String outDir = (args.length > 0) ? args[0] : ".";
        File dir = new File(outDir);
        if (!dir.exists()) {
            dir.mkdirs();
        }
        mapOut = new PrintWriter(new File(dir, "rename-map.tsv"), "UTF-8");
        mapOut.println("# oldName\tnewName\taddress\tstringTrigger");

        Listing listing = currentProgram.getListing();
        ReferenceManager rm = currentProgram.getReferenceManager();
        FunctionManager fm = currentProgram.getFunctionManager();
        SymbolTable st = currentProgram.getSymbolTable();

        // 先登记现有全部符号名，避免重名
        for (ghidra.program.model.symbol.Symbol s : st.getAllSymbols(true)) {
            taken.add(s.getName());
        }

        DataIterator di = listing.getDefinedData(true);
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
            if (val.length() < 4 || val.length() > 512) {
                continue;
            }
            String base = suggestName(val);
            if (base == null) {
                continue;
            }
            Address a = d.getAddress();
            ReferenceIterator ri = rm.getReferencesTo(a);
            while (ri.hasNext()) {
                Reference r = ri.next();
                Function f = fm.getFunctionContaining(r.getFromAddress());
                if (f == null) {
                    continue;
                }
                considered++;
                String oldName = f.getName();
                if (!oldName.startsWith("FUN_")) {
                    skippedNamed++;
                    continue;              // 已有名字（JNI 导出 / demangle 结果）不动
                }
                if (f.isThunk() || f.isExternal()) {
                    continue;
                }
                String newName = uniquify(base);
                try {
                    f.setName(newName, SourceType.USER_DEFINED);
                    renamed++;
                    mapOut.println(oldName + "\t" + newName + "\t" + f.getEntryPoint() + "\t" + oneLine(val));
                } catch (Exception e) {
                    // 名字非法或重复，跳过
                }
            }
        }

        mapOut.flush();
        mapOut.close();
        println("[JunqiRename] 字符串引用命中函数 " + considered
                + " 次；已重命名 " + renamed + " 个；跳过已有名 " + skippedNamed);
    }

    /** 由字符串内容推导函数名 */
    private String suggestName(String val) {
        String s = val;
        if (s.startsWith("Junqi.")) {
            return "Msg_" + sanitize(s.substring(6));
        }
        if (s.startsWith("data/") || s.startsWith("/data/")) {
            String tail = s.substring(s.lastIndexOf('/') + 1);
            if (tail.length() == 0) {
                return null;
            }
            return "Res_" + sanitize(tail);
        }
        if (s.contains("/download/junqi.apk") || s.contains("/share/junqi.apk")) {
            return "Updater_Distribute";
        }
        if (s.equals("SPAK")) {
            return "Pake_MagicCheck";
        }
        if (s.equals("Online.Side") || s.contains(".Sid")) {
            return "Online_ServerTag";
        }
        if (s.startsWith("net") && s.endsWith("dlg.xml")) {
            return "UI_" + sanitize(s);
        }
        if (s.endsWith("dlg.xml") || s.equals("ui.xml")) {
            return "UI_" + sanitize(s);
        }
        if (s.endsWith(".cfg")) {
            return "Cfg_" + sanitize(s);
        }
        if (s.endsWith(".txt")) {
            return "Text_" + sanitize(s);
        }
        if (s.indexOf('%') >= 0 && s.indexOf("clip") > 0) {
            return "Render_ClipSrc";
        }
        if (s.startsWith("http://") || s.startsWith("https://")) {
            return "URL_" + sanitize(s.replace("://", "_"));
        }
        return null;   // 普通文案不参与命名，避免噪声
    }

    private String sanitize(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
                sb.append(c);
            } else if (c == '.' || c == '-' || c == '_' || c == ' ' || c == '/') {
                sb.append('_');
            }
            if (sb.length() >= MAX_NAME) {
                break;
            }
        }
        String out = sb.toString();
        while (out.indexOf("__") >= 0) {
            out = out.replace("__", "_");
        }
        while (out.startsWith("_")) {
            out = out.substring(1);
        }
        while (out.endsWith("_")) {
            out = out.substring(0, out.length() - 1);
        }
        if (out.length() == 0) {
            return "";
        }
        if (out.charAt(0) >= '0' && out.charAt(0) <= '9') {
            out = "n" + out;
        }
        return out;
    }

    private String uniquify(String base) {
        String nm = base;
        int i = 2;
        while (taken.contains(nm)) {
            nm = base + "_" + i;
            i++;
        }
        taken.add(nm);
        return nm;
    }

    private String oneLine(String s) {
        String r = s.replace("\t", " ").replace("\r", " ").replace("\n", " ");
        if (r.length() > 90) {
            r = r.substring(0, 90);
        }
        return r;
    }
}
