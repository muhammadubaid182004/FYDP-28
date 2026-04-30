import argparse
import json
from pathlib import Path

from ultralytics import YOLO


def build_recommendation(label: str) -> str:
    normalized = label.strip().lower()
    if normalized in {"no dr", "no_dr", "nrdr"}:
        return "No referable diabetic retinopathy detected. Continue routine screening."
    if normalized in {"mild dr", "mild_dr"}:
        return "Mild diabetic retinopathy detected. Follow-up screening is recommended."
    return "Referable diabetic retinopathy suspected. Clinical review is recommended."


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run direct inference from a PyTorch .pt model with Ultralytics."
    )
    parser.add_argument(
        "--model",
        default="best.pt",
        help="Path to the .pt model file (default: best.pt).",
    )
    parser.add_argument(
        "--image",
        help="Path to a single input image.",
    )
    parser.add_argument(
        "--images-dir",
        help="Path to a directory containing images for batch inference.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=256,
        help="Inference image size (default: 256).",
    )
    args = parser.parse_args()

    model_path = Path(args.model).resolve()

    if not model_path.exists():
        raise FileNotFoundError(f"Model file not found: {model_path}")
    if not args.image and not args.images_dir:
        raise ValueError("Provide either --image or --images-dir.")

    model = YOLO(str(model_path))
    names = model.names if isinstance(model.names, dict) else {}

    def classify_one(image_path: Path) -> dict:
        results = model.predict(source=str(image_path), imgsz=args.imgsz, verbose=False)
        if not results:
            raise RuntimeError(f"Model returned no results for {image_path}.")

        result = results[0]
        probs = result.probs
        if probs is None:
            raise RuntimeError(
                f"Classification probabilities were not returned for {image_path}."
            )

        top_index = int(probs.top1)
        confidence = float(probs.top1conf.item())
        label = str(names.get(top_index, f"class_{top_index}"))
        return {
            "image_path": str(image_path),
            "class": label,
            "confidence": confidence,
            "recommendation": build_recommendation(label),
        }

    if args.image:
        image_path = Path(args.image).resolve()
        if not image_path.exists():
            raise FileNotFoundError(f"Image file not found: {image_path}")
        payload = {
            "model_path": str(model_path),
            "model_version": "pt-direct-local-1.0.0",
            **classify_one(image_path),
        }
        print(json.dumps(payload, indent=2))
        return

    images_dir = Path(args.images_dir).resolve()
    if not images_dir.exists() or not images_dir.is_dir():
        raise FileNotFoundError(f"Images directory not found: {images_dir}")

    allowed_exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    image_files = sorted(
        [p for p in images_dir.iterdir() if p.is_file() and p.suffix.lower() in allowed_exts]
    )
    if not image_files:
        raise RuntimeError(f"No supported image files found in {images_dir}.")

    batch_results = [classify_one(image_path) for image_path in image_files]
    payload = {
        "model_path": str(model_path),
        "model_version": "pt-direct-local-1.0.0",
        "images_dir": str(images_dir),
        "total": len(batch_results),
        "results": batch_results,
    }
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()

