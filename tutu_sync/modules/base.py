from abc import ABC, abstractmethod
from pathlib import Path


class SyncModule(ABC):
    name: str
    config_paths: list[Path]
    secret_patterns: list[str]
    exclude_patterns: list[str] = []

    @property
    def home(self) -> Path:
        return Path.home()

    def get_absolute_paths(self) -> list[Path]:
        return [self.home / p for p in self.config_paths]

    @abstractmethod
    def pre_sync(self) -> None:
        ...

    @abstractmethod
    def post_sync(self) -> None:
        ...

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(name={self.name!r})"
