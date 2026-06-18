from tutu_sync.modules.base import SyncModule
from tutu_sync.modules.opencode import OpenCodeModule
from tutu_sync.modules.piagent import PiAgentModule
from tutu_sync.modules.registry import discover_modules, get_module, list_modules


class TestModuleDiscovery:
    def test_discover_modules(self):
        modules = discover_modules()
        assert "opencode" in modules
        assert "piagent" in modules

    def test_discover_modules_are_subclasses(self):
        modules = discover_modules()
        for cls in modules.values():
            assert issubclass(cls, SyncModule)

    def test_list_modules(self):
        names = list_modules()
        assert "opencode" in names
        assert "piagent" in names

    def test_get_module(self):
        m = get_module("opencode")
        assert isinstance(m, OpenCodeModule)
        assert m.name == "opencode"

    def test_get_module_unknown(self):
        import pytest
        with pytest.raises(ValueError, match="unknown module"):
            get_module("nonexistent")


class TestOpenCodeModule:
    def test_basics(self):
        m = OpenCodeModule()
        assert m.name == "opencode"
        assert len(m.config_paths) > 0
        assert len(m.secret_patterns) > 0
        assert "**/auth.json" in m.secret_patterns

    def test_absolute_paths(self):
        m = OpenCodeModule()
        paths = m.get_absolute_paths()
        for p in paths:
            assert str(p).startswith("/home") or str(p).startswith("/root")

    def test_pre_post_sync_noop(self):
        m = OpenCodeModule()
        m.pre_sync()
        m.post_sync()


class TestPiAgentModule:
    def test_basics(self):
        m = PiAgentModule()
        assert m.name == "piagent"
        assert len(m.config_paths) == 1
        assert str(m.config_paths[0]) == "pi-backup.age"

    def test_absolute_paths(self):
        m = PiAgentModule()
        paths = m.get_absolute_paths()
        for p in paths:
            assert str(p).startswith("/home") or str(p).startswith("/root")

    def test_has_pi_sync_methods(self):
        m = PiAgentModule()
        assert hasattr(m, "export_config")
        assert hasattr(m, "import_config")
        assert hasattr(m, "setup_password")
        assert hasattr(m, "install_extension")
        assert hasattr(m, "_get_password")
        assert hasattr(m, "_set_password")
