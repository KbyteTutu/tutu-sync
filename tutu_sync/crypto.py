import base64
from pathlib import Path

import pyrage


class CryptoError(Exception):
    pass


def generate_keypair() -> tuple[str, str]:
    identity = pyrage.x25519.Identity.generate()
    identity_str = str(identity)
    recipient_str = str(identity.to_public())
    return identity_str, recipient_str


def _parse_recipients(recipients: list[str]) -> list:
    result = []
    for r in recipients:
        try:
            result.append(pyrage.x25519.Recipient.from_str(r))
        except Exception:
            raise CryptoError(f"invalid age recipient: {r[:50]}...")
    return result


def _parse_identity(identity: str):
    try:
        return pyrage.x25519.Identity.from_str(identity)
    except Exception:
        raise CryptoError(f"invalid age identity: {identity[:50]}...")


def encrypt_bytes(data: bytes, recipients: list[str]) -> bytes:
    try:
        age_recipients = _parse_recipients(recipients)
        return pyrage.encrypt(data, age_recipients)
    except CryptoError:
        raise
    except Exception as e:
        raise CryptoError(f"encryption failed: {e}") from e


def decrypt_bytes(data: bytes, identity: str) -> bytes:
    try:
        age_identity = _parse_identity(identity)
        return pyrage.decrypt(data, [age_identity])
    except CryptoError:
        raise
    except Exception as e:
        raise CryptoError(f"decryption failed: {e}") from e


def encrypt_string(plaintext: str, recipients: list[str]) -> str:
    ciphertext = encrypt_bytes(plaintext.encode("utf-8"), recipients)
    return base64.b64encode(ciphertext).decode("ascii")


def decrypt_string(encoded: str, identity: str) -> str:
    ciphertext = base64.b64decode(encoded.encode("ascii"))
    return decrypt_bytes(ciphertext, identity).decode("utf-8")


def encrypt_file(
    input_path: str, recipients: list[str], output_path: str | None = None
) -> str:
    in_path = Path(input_path)
    if not in_path.exists():
        raise CryptoError(f"file not found: {input_path}")
    if not in_path.is_file():
        raise CryptoError(f"not a regular file: {input_path}")

    out_path = Path(output_path) if output_path else in_path.with_suffix(in_path.suffix + ".age")

    try:
        plaintext = in_path.read_bytes()
    except PermissionError as e:
        raise CryptoError(f"cannot read {input_path}: {e}") from e

    ciphertext = encrypt_bytes(plaintext, recipients)
    out_path.write_bytes(ciphertext)
    return str(out_path)


def decrypt_file(
    input_path: str, identity: str, output_path: str | None = None
) -> str:
    in_path = Path(input_path)
    if not in_path.exists():
        raise CryptoError(f"file not found: {input_path}")
    if not in_path.is_file():
        raise CryptoError(f"not a regular file: {input_path}")

    out_path = Path(output_path) if output_path else in_path.with_name(in_path.stem)

    try:
        ciphertext = in_path.read_bytes()
    except PermissionError as e:
        raise CryptoError(f"cannot read {input_path}: {e}") from e

    plaintext = decrypt_bytes(ciphertext, identity)
    out_path.write_bytes(plaintext)
    return str(out_path)
