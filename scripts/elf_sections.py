"""列出 libjunqi.so 的节区映射（vaddr ↔ file offset）。32 位 ARM ELF。"""
import struct
from pathlib import Path

buf = Path("E:/Learn/MeProject/2026.9.10-reverse/work/2026.9.10-base-apk/03-native/libjunqi.so").read_bytes()
assert buf[:4] == b"\x7fELF"
assert buf[4] == 1, f"期望 32 位 ELF，实际 class={buf[4]}"

e_shoff, = struct.unpack_from("<I", buf, 0x20)
e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", buf, 0x2E)
sh_str_off, sh_str_size = struct.unpack_from("<II", buf, e_shoff + e_shstrndx * e_shentsize + 0x10)
strtab = buf[sh_str_off:sh_str_off + sh_str_size]

print(f"sections={e_shnum}  shstrndx={e_shstrndx}")
print(f"{'name':20s} {'addr':>10s} {'offset':>10s} {'size':>9s}   delta")
rows = []
for i in range(e_shnum):
    o = e_shoff + i * e_shentsize
    name_off, sh_type, sh_flags, addr, off, size = struct.unpack_from("<IIIIII", buf, o)
    name = strtab[name_off:strtab.find(b"\0", name_off)].decode()
    if addr:
        rows.append((name, addr, off, size))
        print(f"{name:20s} {addr:#10x} {off:#10x} {size:#9x}  {addr - off:#x}")

print()
for probe in (0x132AE0, 0x133350, 0x132724, 0x1329F4, 0x13F00C):
    for name, addr, off, size in rows:
        if addr <= probe < addr + size:
            print(f"vaddr {probe:#x} 在节区 {name}: fileoff = {off + (probe - addr):#x}")
            break
    else:
        print(f"vaddr {probe:#x} 不在任何有地址的节区内")
