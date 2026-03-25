import struct, zlib, math, os, subprocess, shutil

def make_house_png(size):
    bg   = (14, 14, 12)
    gold = (200, 184, 112)

    cx = size / 2
    margin     = size * 0.12
    wall_left  = size * 0.18
    wall_right = size - size * 0.18
    bottom     = size - margin
    roof_peak_y= size * 0.18
    roof_base_y= size * 0.48

    door_w  = size * 0.16
    door_h  = size * 0.22
    door_x1 = cx - door_w / 2
    door_x2 = cx + door_w / 2
    door_y1 = bottom - door_h
    door_y2 = bottom

    stroke = max(2, int(size * 0.045))

    def on_seg(px, py, ax, ay, bx, by, t):
        dx, dy = bx - ax, by - ay
        length = math.sqrt(dx*dx + dy*dy)
        if length == 0:
            return False
        s = max(0, min(1, ((px-ax)*dx + (py-ay)*dy) / (length*length)))
        cx2 = ax + s * dx
        cy2 = ay + s * dy
        return math.sqrt((px-cx2)**2 + (py-cy2)**2) <= t / 2

    def rect_outline(px, py, x1, y1, x2, y2, t):
        return (on_seg(px,py,x1,y1,x2,y1,t) or on_seg(px,py,x2,y1,x2,y2,t) or
                on_seg(px,py,x2,y2,x1,y2,t) or on_seg(px,py,x1,y2,x1,y1,t))

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            draw = (
                on_seg(x,y, cx,roof_peak_y, wall_left,roof_base_y, stroke) or   # roof left
                on_seg(x,y, cx,roof_peak_y, wall_right,roof_base_y, stroke) or  # roof right
                on_seg(x,y, wall_left,roof_base_y, wall_left,bottom, stroke) or  # left wall
                on_seg(x,y, wall_right,roof_base_y, wall_right,bottom, stroke) or# right wall
                on_seg(x,y, wall_left,roof_base_y, wall_right,roof_base_y, stroke) or # eave
                on_seg(x,y, wall_left,bottom, door_x1,bottom, stroke) or         # floor left
                on_seg(x,y, door_x2,bottom, wall_right,bottom, stroke) or        # floor right
                rect_outline(x,y, door_x1,door_y1, door_x2,door_y2, stroke*0.8) # door
            )
            row.extend(gold if draw else bg)
        pixels.append(row)

    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)

    raw   = b''.join(b'\x00' + bytes(r) for r in pixels)
    ihdr  = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    idat  = zlib.compress(raw)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')


def main():
    os.makedirs('src-tauri/icons', exist_ok=True)

    # Standard PNG sizes Tauri needs
    for size, name in [(32,'32x32'), (128,'128x128'), (256,'128x128@2x'), (512,'512x512')]:
        with open(f'src-tauri/icons/{name}.png', 'wb') as f:
            f.write(make_house_png(size))
        print(f"  ✓ {name}.png")

    # Build .iconset for macOS iconutil
    iconset = 'src-tauri/icons/PropTrack.iconset'
    os.makedirs(iconset, exist_ok=True)
    for s in [16, 32, 64, 128, 256, 512]:
        with open(f'{iconset}/icon_{s}x{s}.png', 'wb') as f:
            f.write(make_house_png(s))
        with open(f'{iconset}/icon_{s}x{s}@2x.png', 'wb') as f:
            f.write(make_house_png(s * 2))

    result = subprocess.run(
        ['iconutil', '-c', 'icns', iconset, '-o', 'src-tauri/icons/icon.icns'],
        capture_output=True
    )
    if result.returncode == 0:
        print("  ✓ icon.icns")
    else:
        print("  ✗ iconutil failed:", result.stderr.decode())
        shutil.copy('src-tauri/icons/128x128.png', 'src-tauri/icons/icon.icns')

    shutil.copy('src-tauri/icons/32x32.png', 'src-tauri/icons/icon.ico')
    print("  ✓ icon.ico")
    print("\nDone! Rebuild with: npm run tauri build")


if __name__ == "__main__":
    main()
