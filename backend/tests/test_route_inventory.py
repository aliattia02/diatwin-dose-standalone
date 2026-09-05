"""
Every route, exercised.

This suite does not check business logic. It answers three questions across
the whole API surface at once, which no other test does:

*   Is every route that touches patient data behind authentication?
*   Does any route return a 500 on a well-formed but unauthenticated call?
*   Does the ``/api/v1/*`` compatibility proxy actually reach the same
    handler as the legacy path?

Routes are discovered from the URL map rather than listed by hand, so a new
blueprint is covered the moment it is registered. That is the point: the
value here is that it cannot fall out of date.
"""

from __future__ import annotations

import pytest

#: Routes that are public by design.
PUBLIC = {
    "/api/health",
    "/login",
    "/register",
    "/test",
}

#: Prefixes that are public by design — OAuth callbacks land here without a
#: bearer token because the provider is the caller.
PUBLIC_PREFIXES = (
    "/api/watch/oauth",
    "/static/",
)

#: Placeholder values by converter, so a rule with a variable part can be
#: turned into a concrete URL.
SAMPLE = {
    "string": "sample",
    "int": "1",
    "float": "1.0",
    "path": "sample",
    "default": "sample",
}


def _concrete(rule) -> str:
    """Fill a rule's variable parts with syntactically valid placeholders."""
    url = rule.rule
    for name, converter in rule._converters.items():
        kind = type(converter).__name__.replace("Converter", "").lower()
        url = url.replace(f"<{name}>", SAMPLE.get(kind, SAMPLE["default"]))
        for prefix in ("string:", "int:", "float:", "path:"):
            url = url.replace(f"<{prefix}{name}>", SAMPLE.get(kind, SAMPLE["default"]))
    return url


def _testable_rules(flask_app):
    """Every rule paired with one method we can safely call."""
    out = []
    for rule in flask_app.url_map.iter_rules():
        methods = rule.methods - {"HEAD", "OPTIONS"}
        if not methods:
            continue
        # Prefer a read method; fall back to whatever the rule accepts.
        method = "GET" if "GET" in methods else sorted(methods)[0]
        out.append((rule, method, _concrete(rule)))
    return sorted(out, key=lambda r: (r[2], r[1]))


def _is_public(url: str) -> bool:
    return url in PUBLIC or url.startswith(PUBLIC_PREFIXES)


# ─── Inventory ───────────────────────────────────────────────────────────────

def test_inventory_is_not_empty(flask_app):
    rules = _testable_rules(flask_app)
    assert len(rules) > 90, f"expected the full API surface, found {len(rules)} rules"


#: Route collisions accepted as known. Empty, and worth keeping that way:
#: the one entry that lived here (DELETE /api/meal/<meal_id>) was D1, fixed
#: 2026-09-05. See ``test_known_defects.py::TestDeleteMealCascade``.
KNOWN_COLLISIONS: set[str] = set()


def test_no_new_duplicate_rule_and_method(flask_app):
    """
    Two handlers on the same path and method means one silently wins.

    Flask allows it as long as the endpoint names differ, so it does not
    raise at registration — it just routes to whichever registered first.
    The known collision is tracked separately; this guards against new ones.
    """
    seen = {}
    collisions = []
    for rule in flask_app.url_map.iter_rules():
        for method in rule.methods - {"HEAD", "OPTIONS"}:
            key = (rule.rule, method)
            if key in seen and seen[key] != rule.endpoint:
                label = f"{method} {rule.rule}"
                if label not in KNOWN_COLLISIONS:
                    collisions.append(f"{label}: {seen[key]} vs {rule.endpoint}")
            seen[key] = rule.endpoint
    assert collisions == [], "new duplicate route registrations:\n  " + "\n  ".join(collisions)


# ─── Authentication coverage ─────────────────────────────────────────────────

def test_every_non_public_route_requires_authentication(client, flask_app):
    """
    The single most useful assertion in the backend suite.

    An unauthenticated call to a protected route must be rejected — 401 from
    the token decorator, or 403/404/405 if routing rejects it earlier. What
    it must never be is 2xx, which would mean patient data is reachable with
    no credentials at all.
    """
    unprotected = []

    for rule, method, url in _testable_rules(flask_app):
        if _is_public(url):
            continue
        response = client.open(url, method=method, json={})
        if 200 <= response.status_code < 300:
            unprotected.append(f"{method} {url} -> {response.status_code}")

    assert unprotected == [], (
        "routes returned success without authentication:\n  "
        + "\n  ".join(unprotected)
    )


def test_public_routes_are_reachable(client):
    assert client.get("/api/health").status_code == 200
    assert client.get("/test").status_code == 200


def test_health_is_not_cached(client):
    """A cached health check reports the last good state forever."""
    assert client.get("/api/health").headers.get("Cache-Control") == "no-store"


# ─── Error handling ──────────────────────────────────────────────────────────

#: Routes that 5xx on an unauthenticated call today.
#:
#: ``/api/bulk-import``   — no auth by design, crashes on an empty body.
#:                          See ``TestBulkImportIsUnauthenticated``.
#: ``/api/food/scan/test`` — public connectivity probe; reports a missing
#:                          GEMINI_API_KEY as 500, which is arguably correct
#:                          for a config check but makes it indistinguishable
#:                          from a real fault.
KNOWN_5XX = {
    "POST /api/bulk-import",
    "GET /api/food/scan/test",
}


def test_no_new_route_500s_when_unauthenticated(client, flask_app):
    """
    A missing token is a client error, never a server error.

    A 500 here means the handler ran far enough to throw before the auth
    check — which is both a leak of internal state and a sign the decorator
    is missing.
    """
    crashed = []
    for rule, method, url in _testable_rules(flask_app):
        response = client.open(url, method=method, json={})
        if response.status_code >= 500 and f"{method} {url}" not in KNOWN_5XX:
            crashed.append(f"{method} {url} -> {response.status_code}")
    assert crashed == [], "new 5xx without authentication:\n  " + "\n  ".join(crashed)


def test_unknown_route_returns_json_404(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.get_json() == {"error": "Resource not found"}


# Malformed-JSON handling is characterized in
# test_known_defects.py::TestMalformedJsonHandling — it currently 500s.


# ─── Auth token handling ─────────────────────────────────────────────────────

class TestTokenHandling:
    PROTECTED = "/api/patient/constants"

    def test_missing_header_is_401(self, client):
        assert client.get(self.PROTECTED).status_code == 401

    def test_garbage_token_is_401(self, client):
        r = client.get(self.PROTECTED, headers={"Authorization": "Bearer not-a-jwt"})
        assert r.status_code == 401

    def test_expired_token_is_401(self, client, patient, auth):
        r = client.get(self.PROTECTED, headers=auth(patient, expired=True))
        assert r.status_code == 401

    def test_token_for_deleted_user_is_401(self, client, db, patient, auth):
        headers = auth(patient)
        db.users.delete_one({"_id": patient["_id"]})
        assert client.get(self.PROTECTED, headers=headers).status_code == 401

    def test_token_signed_with_wrong_secret_is_401(self, client, patient):
        import jwt
        from datetime import datetime, timedelta, timezone
        forged = jwt.encode(
            {"user_id": str(patient["_id"]), "user_type": "admin",
             "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
            "a-different-secret", algorithm="HS256",
        )
        r = client.get(self.PROTECTED, headers={"Authorization": f"Bearer {forged}"})
        assert r.status_code == 401

    def test_valid_token_is_accepted(self, client, patient, auth):
        assert client.get(self.PROTECTED, headers=auth(patient)).status_code == 200

    def test_bare_token_without_bearer_prefix_is_accepted(self, client, flask_app, patient):
        """Documents current behaviour: the decorator splits on space and
        falls back to the whole header when there is none."""
        from tests.conftest import make_token
        token = make_token(flask_app, patient)
        r = client.get(self.PROTECTED, headers={"Authorization": token})
        assert r.status_code == 200

    def test_options_preflight_skips_auth(self, client):
        """CORS preflight carries no Authorization header by design."""
        r = client.open(self.PROTECTED, method="OPTIONS")
        assert r.status_code == 200


# ─── /api/v1 compatibility proxy ─────────────────────────────────────────────

class TestApiV1Proxy:
    """
    ``main.py`` proxies ``/api/v1/<path>`` to ``/api/<path>`` for the mobile
    client. If it stops resolving, every mobile call breaks at once, so it is
    worth an explicit check rather than trusting the URL map.
    """

    def test_proxy_reaches_the_same_handler(self, client, patient, auth):
        legacy = client.get("/api/patient/constants", headers=auth(patient))
        proxied = client.get("/api/v1/patient/constants", headers=auth(patient))
        assert legacy.status_code == proxied.status_code == 200
        assert legacy.get_json() == proxied.get_json()

    def test_proxy_preserves_401(self, client):
        assert client.get("/api/v1/patient/constants").status_code == 401

    def test_proxy_404s_for_unknown_paths(self, client, patient, auth):
        r = client.get("/api/v1/nothing-here", headers=auth(patient))
        assert r.status_code == 404

    def test_proxy_forwards_post_bodies(self, client, patient, auth):
        r = client.post("/api/v1/blood-sugar",
                        json={"bloodSugar": 120,
                              "bloodSugarTimestamp": "2026-03-01T12:00:00Z"},
                        headers=auth(patient))
        assert r.status_code < 400, r.get_data(as_text=True)
