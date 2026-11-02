"""JsonGridder_icon.png から src-tauri/icons/ のアイコンを全部作り直す。

使い方: python assets/icon/make_icons.py
必要な物: Python 3 と Pillow（12.1.0 で確かめた）。ビルドと試験には要らない。
生成物はリポジトリに入れてあるので、絵を替えるときだけ走らせる。元の画像は書き換えない。

- 64 以上は全体の絵を使う。
- 48 以下は全体の絵が潰れるので、顔と括弧の切り出しを使う。
- 四隅の外は角丸の透過にする。
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "JsonGridder_icon.png"
ICONS = HERE.parent.parent / "src-tauri" / "icons"

CROP_BOX = (110, 170, 1040, 1100)  # 顔と括弧
LARGEST_CROP_SIZE = 48  # これ以下は切り出しを使う
RADIUS_RATIO = 0.045  # 元の絵の角丸の外の色が残らない半径
MIN_RADIUS_PX = 3.5  # これ以上なら、16 でも隅のピクセルが完全に透過になる
INSET_RATIO = 2 / 1254  # 元の絵の縁の明るい線を外す
MASK_SCALE = 8

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
PNG_FILES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}


def rounded_mask(size):
    """size の正方形の、角丸の内側だけが不透明なマスク。"""
    scaled = size * MASK_SCALE
    inset = size * INSET_RATIO * MASK_SCALE
    radius = max(size * RADIUS_RATIO, MIN_RADIUS_PX) * MASK_SCALE
    mask = Image.new("L", (scaled, scaled), 0)
    box = (inset, inset, scaled - inset - 1, scaled - inset - 1)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    return mask.resize((size, size), Image.Resampling.BOX)


def render(full, crop, size):
    """size の大きさのアイコンを 1 枚作る。"""
    source = crop if size <= LARGEST_CROP_SIZE else full
    icon = source.resize((size, size), Image.Resampling.LANCZOS)
    icon.putalpha(rounded_mask(size))
    return icon


def main():
    with Image.open(SOURCE) as image:
        full = image.convert("RGB")
    crop = full.crop(CROP_BOX)

    for name, size in PNG_FILES.items():
        render(full, crop, size).save(ICONS / name, optimize=True)

    ico_images = [render(full, crop, size) for size in ICO_SIZES]
    ico_images[-1].save(
        ICONS / "icon.ico",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=ico_images[:-1],
    )

    icns_images = [render(full, crop, size) for size in ICNS_SIZES]
    icns_images[-1].save(ICONS / "icon.icns", append_images=icns_images[:-1])


if __name__ == "__main__":
    main()
