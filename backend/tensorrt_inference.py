import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def preprocess_image(image_path: Path, image_size: int) -> np.ndarray:
    image = Image.open(image_path).convert("RGB")
    src_w, src_h = image.size
    scale = min(image_size / src_w, image_size / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = image.resize((new_w, new_h), Image.BILINEAR)

    canvas = Image.new("RGB", (image_size, image_size), (0, 0, 0))
    pad_x = (image_size - new_w) // 2
    pad_y = (image_size - new_h) // 2
    canvas.paste(resized, (pad_x, pad_y))

    arr = np.asarray(canvas).astype(np.float32) / 255.0
    chw = np.transpose(arr, (2, 0, 1))
    return np.expand_dims(chw, axis=0).astype(np.float32)


def softmax(x: np.ndarray) -> np.ndarray:
    x = x - np.max(x, axis=1, keepdims=True)
    e = np.exp(x)
    return e / np.sum(e, axis=1, keepdims=True)


def run_tensorrt(engine_path: Path, input_tensor: np.ndarray) -> np.ndarray:
    try:
        import tensorrt as trt
        import pycuda.autoinit  # noqa: F401
        import pycuda.driver as cuda
    except Exception as exc:
        raise RuntimeError(
            "TensorRT runtime dependencies missing. Install tensorrt and pycuda."
        ) from exc

    logger = trt.Logger(trt.Logger.ERROR)
    runtime = trt.Runtime(logger)
    engine_data = engine_path.read_bytes()
    engine = runtime.deserialize_cuda_engine(engine_data)
    if engine is None:
        raise RuntimeError("Failed to deserialize TensorRT engine.")

    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError("Failed to create TensorRT execution context.")

    input_name = engine.get_tensor_name(0)
    output_name = engine.get_tensor_name(1)

    context.set_input_shape(input_name, input_tensor.shape)
    output_shape = tuple(context.get_tensor_shape(output_name))
    if any(dim < 0 for dim in output_shape):
        raise RuntimeError(f"Invalid output shape from TensorRT engine: {output_shape}")

    input_nbytes = input_tensor.nbytes
    output = np.empty(output_shape, dtype=np.float32)
    output_nbytes = output.nbytes

    d_input = cuda.mem_alloc(input_nbytes)
    d_output = cuda.mem_alloc(output_nbytes)

    cuda.memcpy_htod(d_input, input_tensor)
    context.set_tensor_address(input_name, int(d_input))
    context.set_tensor_address(output_name, int(d_output))

    if not context.execute_async_v3(0):
        raise RuntimeError("TensorRT execution failed.")

    cuda.memcpy_dtoh(output, d_output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="TensorRT engine inference helper")
    parser.add_argument("--engine", required=True, help="Path to TensorRT .engine file")
    parser.add_argument("--image", required=True, help="Path to input image")
    parser.add_argument("--imgsz", type=int, default=256, help="Model input image size")
    parser.add_argument("--labels", default="Nrdr,Rdr", help="Comma-separated class labels")
    args = parser.parse_args()

    engine_path = Path(args.engine).resolve()
    image_path = Path(args.image).resolve()
    labels = [x.strip() for x in args.labels.split(",") if x.strip()]

    if not engine_path.exists():
        raise FileNotFoundError(f"Engine not found: {engine_path}")
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    input_tensor = preprocess_image(image_path, args.imgsz)
    raw_output = run_tensorrt(engine_path, input_tensor)

    if raw_output.ndim == 1:
        raw_output = raw_output.reshape(1, -1)

    probs = softmax(raw_output)
    top_idx = int(np.argmax(probs[0]))
    confidence = float(probs[0][top_idx])
    predicted = labels[top_idx] if top_idx < len(labels) else f"class_{top_idx}"

    if predicted.lower() == "nrdr":
        recommendation = "No referable diabetic retinopathy. Continue scheduled screening."
    else:
        recommendation = "Referable diabetic retinopathy suspected. Clinical review is recommended."

    print(
        json.dumps(
            {
                "class": predicted,
                "confidence": confidence,
                "recommendation": recommendation,
                "model_version": "tensorrt-engine-local",
            }
        )
    )


if __name__ == "__main__":
    main()

