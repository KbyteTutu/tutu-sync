import secrets
from pathlib import Path

import pytest

from tutu_sync.crypto import (
    CryptoError,
    decrypt_bytes,
    decrypt_file,
    decrypt_string,
    encrypt_bytes,
    encrypt_file,
    encrypt_string,
    generate_keypair,
)


class TestCrypto:
    def test_generate_keypair(self):
        identity, recipient = generate_keypair()
        assert identity.startswith("AGE-SECRET-KEY-")
        assert recipient.startswith("age1")

    def test_encrypt_decrypt_bytes(self):
        identity, recipient = generate_keypair()
        plaintext = secrets.token_bytes(1024)
        ciphertext = encrypt_bytes(plaintext, [recipient])
        assert plaintext not in ciphertext
        decrypted = decrypt_bytes(ciphertext, identity)
        assert decrypted == plaintext

    def test_encrypt_decrypt_file(self, tmp_path):
        identity, recipient = generate_keypair()
        input_file = tmp_path / "secret.txt"
        input_file.write_text("my-api-key-sk-12345")

        encrypted_path = encrypt_file(str(input_file), [recipient])
        assert encrypted_path.endswith(".age")
        assert b"sk-12345" not in Path(encrypted_path).read_bytes()

        decrypted_path = decrypt_file(encrypted_path, identity)
        assert Path(decrypted_path).read_text() == "my-api-key-sk-12345"

    def test_encrypt_nonexistent_file(self):
        with pytest.raises(CryptoError, match="file not found"):
            encrypt_file("/nonexistent/file.txt", ["age1test"])

    def test_encrypt_invalid_recipient(self):
        tmp_file = "/tmp/test_crypto_invalid.txt"
        Path(tmp_file).write_text("data")
        with pytest.raises(CryptoError, match="invalid age recipient"):
            encrypt_file(tmp_file, ["not-a-valid-recipient"])

    def test_decrypt_invalid_identity(self):
        identity, recipient = generate_keypair()
        ciphertext = encrypt_bytes(b"test", [recipient])
        with pytest.raises(CryptoError, match="invalid age identity"):
            decrypt_bytes(ciphertext, "not-a-valid-identity")

    def test_encrypt_decrypt_string(self):
        identity, recipient = generate_keypair()
        plaintext = "my-super-secret-password-12345"
        encoded = encrypt_string(plaintext, [recipient])
        assert isinstance(encoded, str)
        assert "password" not in encoded.lower()
        decrypted = decrypt_string(encoded, identity)
        assert decrypted == plaintext
