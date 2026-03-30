from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from apps.backend.app.api.routes import router

DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def allowed_origins_from_env(env_value: str | None) -> list[str]:
    configured_origins = [item.strip() for item in (env_value or "").split(",") if item.strip()]
    return list(dict.fromkeys([*DEFAULT_ALLOWED_ORIGINS, *configured_origins]))


app = FastAPI(
    title="Causal Graph Workbench API",
    description="Rule-based DAG analysis focused on backdoor adjustment.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins_from_env(os.getenv("CAUSAL_WORKBENCH_ALLOWED_ORIGINS")),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
