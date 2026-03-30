from apps.backend.app.main import DEFAULT_ALLOWED_ORIGINS, allowed_origins_from_env


def test_allowed_origins_from_env_keeps_local_defaults_and_adds_configured_origins() -> None:
    origins = allowed_origins_from_env("https://www.zihanliang.com, https://www.zihanliang.com")

    assert origins == [*DEFAULT_ALLOWED_ORIGINS, "https://www.zihanliang.com"]


def test_allowed_origins_from_env_ignores_blank_entries() -> None:
    origins = allowed_origins_from_env(" , https://dag-workbench.zihanliang.com , ")

    assert origins == [*DEFAULT_ALLOWED_ORIGINS, "https://dag-workbench.zihanliang.com"]
