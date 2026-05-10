import os
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError


def _trim(value: Optional[str]) -> str:
    return (value or "").strip()


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                val = val[1:-1]
            if key and key not in os.environ:
                os.environ[key] = val
    except OSError:
        pass


def _parse_s3_uri(raw_uri: str) -> tuple[str, str]:
    parsed = urlparse(raw_uri)
    if parsed.scheme != "s3":
        raise ValueError("S3 URI must use the s3:// scheme, e.g. s3://my-bucket/my/prefix")
    bucket = (parsed.hostname or "").strip()
    key_prefix = parsed.path.lstrip("/").rstrip("/")
    if not bucket:
        raise ValueError("S3 URI is missing bucket name")
    return bucket, key_prefix


def _strip_key_prefix(full_key: str, prefix: str) -> str:
    p = prefix.rstrip("/")
    if not p:
        return full_key
    if full_key == p:
        return Path(full_key).name
    lead = p + "/"
    if full_key.startswith(lead):
        return full_key[len(lead) :]
    return full_key


def _build_s3_client(region: str, endpoint: Optional[str], force_path_style: bool):
    kwargs: dict = {"region_name": region}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if force_path_style:
        kwargs["config"] = Config(s3={"addressing_style": "path"})

    access_key = _trim(os.environ.get("AWS_ACCESS_KEY_ID"))
    secret_key = _trim(os.environ.get("AWS_SECRET_ACCESS_KEY"))
    session_token = _trim(os.environ.get("AWS_SESSION_TOKEN"))
    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key
        if session_token:
            kwargs["aws_session_token"] = session_token

    return boto3.client("s3", **kwargs)


def main() -> None:
    root = Path(__file__).resolve().parent
    _load_env_file(root / "backend" / ".env")
    _load_env_file(root / ".env")

    s3_uri = _trim(os.environ.get("LOCAL_S3_URI")) or _trim(os.environ.get("S3_URI"))
    if not s3_uri:
        print("❌ Set LOCAL_S3_URI or S3_URI (e.g. s3://my-bucket/images/NRDR).")
        sys.exit(1)

    try:
        bucket_name, key_prefix = _parse_s3_uri(s3_uri)
    except ValueError as e:
        print("❌", e)
        sys.exit(1)

    region = (
        _trim(os.environ.get("AWS_REGION"))
        or _trim(os.environ.get("AWS_DEFAULT_REGION"))
        or "us-east-1"
    )
    endpoint = _trim(os.environ.get("S3_ENDPOINT")) or None
    force_path = _trim(os.environ.get("S3_FORCE_PATH_STYLE")).lower() == "true"

    list_prefix = f"{key_prefix}/" if key_prefix and not key_prefix.endswith("/") else key_prefix

    download_dir = _trim(os.environ.get("S3_DOWNLOAD_DIR")) or "downloads"
    os.makedirs(download_dir, exist_ok=True)

    s3 = _build_s3_client(region, endpoint, force_path)

    try:
        response = s3.list_objects_v2(Bucket=bucket_name, Prefix=list_prefix)

        if "Contents" not in response:
            print("❌ No objects under prefix:", list_prefix or "(bucket root)")
            sys.exit(1)

        print(f"✅ Objects in s3://{bucket_name}/{list_prefix}\n")

        for obj in response["Contents"]:
            key = obj["Key"]
            if key.endswith("/"):
                continue

            print("-", key)
            rel = _strip_key_prefix(key, key_prefix)
            local_path = os.path.join(download_dir, rel)
            parent = os.path.dirname(local_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            s3.download_file(bucket_name, key, local_path)
            print(f"⬇ Downloaded -> {local_path}")

        print("\n✅ All files downloaded successfully!")

    except NoCredentialsError:
        print("❌ AWS credentials not found. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or use a profile/IAM role.")
    except ClientError as e:
        print("❌ AWS Error:", e)
    except Exception as e:
        print("❌ Failed:", e)


if __name__ == "__main__":
    main()
