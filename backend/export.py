import argparse
from pathlib import Path

from ultralytics import YOLO


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export YOLO classification .pt model to ONNX with explicit parameters."
    )
    parser.add_argument("--model", default="best.pt", help="Input .pt model path.")
    parser.add_argument(
        "--imgsz",
        type=int,
        default=256,
        help="Input image size for export (must match inference pipeline).",
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=17,
        help="ONNX opset version. Use <= runtime-supported version.",
    )
    parser.add_argument(
        "--simplify",
        action="store_true",
        default=True,
        help="Simplify ONNX graph after export (default: enabled).",
    )
    parser.add_argument(
        "--dynamic",
        action="store_true",
        help="Enable dynamic axes (default: disabled for parity).",
    )
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    if not model_path.exists():
        raise FileNotFoundError(f"Model file not found: {model_path}")

    print(f"Loading model: {model_path}")
    model = YOLO(str(model_path))

    print("Exporting ONNX with settings:")
    print(
        {
            "imgsz": args.imgsz,
            "opset": args.opset,
            "simplify": args.simplify,
            "dynamic": args.dynamic,
        }
    )

    output_path = model.export(
        format="onnx",
        imgsz=args.imgsz,
        opset=args.opset,
        simplify=args.simplify,
        dynamic=args.dynamic,
    )

    print(f"ONNX export complete: {output_path}")


if __name__ == "__main__":
    main()

