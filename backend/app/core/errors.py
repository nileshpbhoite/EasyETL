"""Friendly error handling. Business users never see raw HTTP/Spark/JDBC errors —
they get a plain-English title and message, with technical details available on demand."""
from __future__ import annotations

import logging
import traceback

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger("easyetl")


class FriendlyError(Exception):
    def __init__(self, title: str, message: str, *, status_code: int = 400, technical: str | None = None,
                 hint: str | None = None):
        super().__init__(message)
        self.title, self.message, self.status_code = title, message, status_code
        self.technical, self.hint = technical, hint


# Map low-level failures to plain-English explanations.
_PATTERNS: list[tuple[tuple[str, ...], str, str]] = [
    (("login failed", "authentication", "401", "invalid_grant", "password"), "Sign-in failed",
     "The credentials were rejected. Please verify the username, password or token."),
    (("403", "forbidden", "permission denied", "not authorized"), "Access denied",
     "The account connected doesn't have permission for this resource. Ask the system owner to grant access."),
    (("timed out", "timeout", "unreachable", "name or service not known", "connection refused",
      "could not connect", "getaddrinfo", "no route"), "Couldn't reach the system",
     "We couldn't connect. Please verify the server address, port and that the network allows access."),
    (("unsupported", "could not determine", "not a zip", "badzipfile", "invalid file"), "File couldn't be read",
     "This file appears to be damaged or in an unexpected format. Try re-exporting it and upload again."),
    (("sparkexception", "analysisexception"), "Processing error",
     "The processing engine couldn't run this step. Review the transformation settings."),
]


def friendly_from_exception(exc: Exception, *, context: str = "") -> FriendlyError:
    raw = f"{type(exc).__name__}: {exc}"
    lowered = raw.lower()
    for needles, title, message in _PATTERNS:
        if any(n in lowered for n in needles):
            prefix = f"{context}: " if context else ""
            return FriendlyError(title, prefix + message, technical=raw)
    return FriendlyError(
        "Something went wrong",
        (f"{context}. " if context else "") + "Please try again. If it keeps happening, share the technical details with your data team.",
        status_code=500,
        technical=raw,
    )


def _payload(title: str, message: str, technical: str | None = None, hint: str | None = None) -> dict:
    return {"error": {"title": title, "message": message, "technical": technical, "hint": hint}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(FriendlyError)
    async def _friendly(_: Request, exc: FriendlyError):
        return JSONResponse(status_code=exc.status_code, content=_payload(exc.title, exc.message, exc.technical, exc.hint))

    @app.exception_handler(HTTPException)
    async def _http(_: Request, exc: HTTPException):
        titles = {401: "Please sign in", 403: "Not allowed", 404: "Not found", 409: "Conflict"}
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(titles.get(exc.status_code, "Request problem"), str(exc.detail), f"HTTP {exc.status_code}"),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        fields = ", ".join(".".join(str(p) for p in e["loc"][1:]) for e in exc.errors())
        return JSONResponse(
            status_code=422,
            content=_payload("Some settings need attention", f"Please check: {fields or 'the form values'}.", str(exc.errors())),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.error("Unhandled error: %s", traceback.format_exc())
        f = friendly_from_exception(exc)
        return JSONResponse(status_code=f.status_code, content=_payload(f.title, f.message, f.technical))
