#!/usr/bin/env python3
"""Canopy 的 psd-tools 桥接脚本：高保真读取 / 合成 Photoshop 文件（可选增强，缺 psd-tools 时 Canopy 自动回退到内置 ag-psd 路径）。

用法（一律 JSON 进出）：
  python psd_tools_bridge.py probe
  python psd_tools_bridge.py inspect  <file.psd>
  python psd_tools_bridge.py composite <file.psd> <out.png> [--hidden id,id] [--visible id,id] [--max-side N]
  python psd_tools_bridge.py layer <file.psd> <layer-id> <out.png>

图层 id 是自下而上的路径（"2/0" = 第 3 个顶层图层里的第 1 个子层），与 Canopy 内置引擎一致。

psd-tools 1.19 的可选依赖（aggdraw / scipy / scikit-image）缺失时合成会抛 ImportError：这里统一转成带安装命令的提示，
单层导出退成文件内像素；psd-tools 重新合成时不画画板底色，这里按 Photoshop 的 artboardBackgroundType 补画。
"""

import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def fail(message):
    emit({"ok": False, "error": message})
    sys.exit(1)


try:
    from psd_tools import PSDImage
    from psd_tools.api.layers import Group
except Exception as exc:  # noqa: BLE001
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        emit({"ok": False, "error": "psd-tools 不可用: %s" % exc})
        sys.exit(0)
    fail("psd-tools 不可用: %s" % exc)


# psd-tools 1.19 把矢量描边（aggdraw）、调整层 / 渐变（scipy）、部分滤镜（scikit-image）做成可选依赖，缺了就抛 ImportError
OPTIONAL_DEPS = (("aggdraw", "aggdraw"), ("scipy", "scipy"), ("skimage", "scikit-image"))
OPTIONAL_HINT = "psd-tools 缺少可选依赖 %s（渲染矢量描边 / 调整层 / 渐变需要）：在同一个 Python 里 pip install \"psd-tools[composite]\""


def missing_optional_deps():
    missing = []
    for module, package in OPTIONAL_DEPS:
        try:
            __import__(module)
        except Exception:  # noqa: BLE001
            missing.append(package)
    return missing


def optional_dep_hint(exc):
    """是可选依赖缺失导致的 ImportError 就返回提示，否则 None。"""
    if not isinstance(exc, ImportError):
        return None
    text = str(exc)
    for module, package in OPTIONAL_DEPS:
        if module in text or package in text:
            return OPTIONAL_HINT % package
    return None


def layer_kind(layer):
    if layer.is_group():
        return "artboard" if getattr(layer, "kind", "") == "artboard" else "group"
    kind = getattr(layer, "kind", "pixel") or "pixel"
    if kind == "type":
        return "text"
    if kind == "smartobject":
        return "smart-object"
    if kind == "shape":
        return "shape"
    if kind in ("pixel", "psdimage"):
        return "pixel"
    if kind == "adjustment" or kind in ("brightnesscontrast", "levels", "curves", "exposure", "vibrance", "huesaturation",
                                         "colorbalance", "blackandwhite", "photofilter", "channelmixer", "colorlookup",
                                         "invert", "posterize", "threshold", "gradientmap", "selectivecolor",
                                         "solidcolorfill", "gradientfill", "patternfill"):
        return "adjustment"
    return "pixel"


def describe(layer, layer_id):
    node = {
        "id": layer_id,
        "name": layer.name,
        "kind": layer_kind(layer),
        "hidden": not layer.visible,
        "opacity": round(layer.opacity / 255.0, 3),
        "blendMode": str(layer.blend_mode.name).lower().replace("_", " ") if layer.blend_mode is not None else "normal",
        "bounds": {"left": layer.left, "top": layer.top, "right": layer.right, "bottom": layer.bottom},
        "hasMask": bool(layer.mask),
        # psd-tools 1.10+ 叫 clipping，更早的版本叫 clipping_layer（新版本访问旧名会打 DeprecationWarning）
        "clipping": bool(layer.clipping if hasattr(type(layer), "clipping") else getattr(layer, "clipping_layer", False)),
    }
    effects = []
    try:
        for effect in layer.effects:
            effects.append(type(effect).__name__)
    except Exception:  # noqa: BLE001
        pass
    if effects:
        node["effects"] = effects
    if getattr(layer, "kind", "") == "type":
        try:
            node["text"] = layer.text
        except Exception:  # noqa: BLE001
            pass
    if layer.is_group():
        children = []
        for index, child in enumerate(layer):
            children.append(describe(child, "%s/%d" % (layer_id, index)))
        node["children"] = children
    return node


def walk(psd):
    return [describe(layer, str(index)) for index, layer in enumerate(psd)]


def find_layer(psd, layer_id):
    parts = [int(p) for p in layer_id.split("/") if p != ""]
    current = psd
    for part in parts:
        items = list(current)
        if part < 0 or part >= len(items):
            return None
        current = items[part]
    return current


def apply_visibility(psd, hidden_ids, visible_ids):
    def visit(layer, layer_id):
        if layer_id in visible_ids:
            layer.visible = True
        elif layer_id in hidden_ids:
            layer.visible = False
        if layer.is_group():
            for index, child in enumerate(layer):
                visit(child, "%s/%d" % (layer_id, index))

    for index, layer in enumerate(psd):
        visit(layer, str(index))


def artboard_background(layer):
    """画板底色 (r, g, b, a)：Photoshop 的 artboardBackgroundType 1 白 / 2 黑 / 3 透明 / 4 自定义色；不是画板或透明返回 None。"""
    try:
        from psd_tools.constants import Tag
        block = layer.tagged_blocks.get_data(Tag.ARTBOARD_DATA1) if layer.is_group() else None
    except Exception:  # noqa: BLE001
        return None
    if block is None:
        return None
    kind = block.get("artboardBackgroundType")
    kind = int(kind) if kind is not None else 1
    if kind == 3:
        return None
    if kind == 2:
        return (0, 0, 0, 255)
    if kind == 4:
        color = block.get("Clr ")
        if color is not None:
            try:
                return (int(round(float(color.get("Rd  ") or 0))), int(round(float(color.get("Grn ") or 0))), int(round(float(color.get("Bl  ") or 0))), 255)
            except Exception:  # noqa: BLE001
                return (255, 255, 255, 255)
    return (255, 255, 255, 255)


def draw_artboard_background(canvas, board, offset=(0, 0)):
    """把画板底色直接画在 canvas 上（底色不透明，会盖住画板矩形内更下面的内容——与 Photoshop 一致）。"""
    from PIL import ImageDraw
    color = artboard_background(board)
    if color is None:
        return canvas
    left, top, right, bottom = board.bbox
    ImageDraw.Draw(canvas).rectangle([left - offset[0], top - offset[1], right - offset[0] - 1, bottom - offset[1] - 1], fill=color)
    return canvas


def composite_with_artboards(psd):
    """
    psd-tools 重新合成时不画画板底色（Photoshop 会画）。按顶层图层顺序分段合成：画板段先在画布上垫底色再叠它的子层，
    非画板的连续顶层图层合成一段。没有画板就是一次普通合成。段与段之间按 normal 叠（顶层非 normal 混合模式的画板文件极少见）。
    """
    from PIL import Image
    tops = [layer for layer in psd if layer.is_visible()]
    if not any(artboard_background(layer) is not None for layer in tops):
        return psd.composite(force=True)
    segments = []
    for layer in tops:
        if artboard_background(layer) is not None:
            segments.append((layer, [layer]))
        elif segments and segments[-1][0] is None:
            segments[-1][1].append(layer)
        else:
            segments.append((None, [layer]))
    canvas = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))
    for board, layers in segments:
        allowed = set()
        for layer in layers:
            allowed.add(id(layer))
            if layer.is_group():
                for child in layer.descendants():
                    allowed.add(id(child))
        part = psd.composite(force=True, layer_filter=lambda layer, allowed=allowed: id(layer) in allowed and layer.is_visible())
        if part.mode != "RGBA":
            part = part.convert("RGBA")
        if board is not None:
            canvas = draw_artboard_background(canvas, board)
        canvas = Image.alpha_composite(canvas, part)
    return canvas


def paint_artboard_backgrounds(boards, image, offset=(0, 0)):
    """单独导出画板时：把画板底色垫在它的合成图下面。offset 是合成图左上角在文档里的坐标。"""
    from PIL import Image
    base = Image.new("RGBA", image.size, (0, 0, 0, 0))
    for board in boards:
        base = draw_artboard_background(base, board, offset)
    return Image.alpha_composite(base, image if image.mode == "RGBA" else image.convert("RGBA"))


def parse_flags(args):
    flags = {"hidden": set(), "visible": set(), "max_side": None}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--hidden" and i + 1 < len(args):
            flags["hidden"] = set(x for x in args[i + 1].split(",") if x)
            i += 2
        elif arg == "--visible" and i + 1 < len(args):
            flags["visible"] = set(x for x in args[i + 1].split(",") if x)
            i += 2
        elif arg == "--max-side" and i + 1 < len(args):
            flags["max_side"] = int(args[i + 1])
            i += 2
        else:
            i += 1
    return flags


def main(argv):
    if len(argv) < 1:
        fail("缺少命令")
    command = argv[0]
    if command == "probe":
        import psd_tools
        emit({"ok": True, "version": psd_tools.__version__, "missingOptionalDeps": missing_optional_deps()})
        return
    if len(argv) < 2:
        fail("缺少 PSD 路径")
    path = argv[1]
    psd = PSDImage.open(path)
    if command == "inspect":
        emit({
            "ok": True,
            "width": psd.width,
            "height": psd.height,
            "colorMode": str(psd.color_mode.name).lower() if psd.color_mode is not None else "rgb",
            "depth": psd.depth,
            "layers": walk(psd),
        })
        return
    if command == "composite":
        if len(argv) < 3:
            fail("缺少输出 PNG 路径")
        out_path = argv[2]
        flags = parse_flags(argv[3:])
        overrides = bool(flags["hidden"] or flags["visible"])
        if overrides:
            apply_visibility(psd, flags["hidden"], flags["visible"])
        # 无改写且文件自带合成图时直接用 Photoshop 存的那张（最保真）；否则按图层重新合成
        recompose = overrides or not psd.has_preview()
        try:
            image = composite_with_artboards(psd) if recompose else psd.composite()
        except ImportError as exc:
            hint = optional_dep_hint(exc)
            if hint:
                fail(hint)
            raise
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        if flags["max_side"] and max(image.size) > flags["max_side"]:
            ratio = flags["max_side"] / float(max(image.size))
            image = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))))
        image.save(out_path, format="PNG")
        emit({"ok": True, "width": psd.width, "height": psd.height, "outPath": out_path, "renderedWidth": image.width, "renderedHeight": image.height})
        return
    if command == "layer":
        if len(argv) < 4:
            fail("缺少图层 id 或输出路径")
        layer = find_layer(psd, argv[2])
        if layer is None:
            fail("找不到图层 %s" % argv[2])
        warning = None
        try:
            image = layer.composite()
        except ImportError as exc:
            # 缺可选依赖时矢量描边 / 剪贴的调整层画不了：图层自带像素的话就用像素（Canopy 写出的文件都带）
            hint = optional_dep_hint(exc)
            if not hint:
                raise
            if not layer.has_pixels():
                fail(hint)
            image = layer.topil()
            warning = hint + "；本次用文件内的图层像素代替"
        if image is None:
            fail("图层 %s 没有像素" % argv[2])
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        if artboard_background(layer) is not None:
            image = paint_artboard_backgrounds([layer], image, offset=(layer.left, layer.top))
        image.save(argv[3], format="PNG")
        payload = {"ok": True, "outPath": argv[3], "bounds": {"left": layer.left, "top": layer.top, "right": layer.right, "bottom": layer.bottom}}
        if warning:
            payload["warning"] = warning
        emit(payload)
        return
    fail("未知命令: %s" % command)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail("%s: %s" % (type(exc).__name__, exc))
