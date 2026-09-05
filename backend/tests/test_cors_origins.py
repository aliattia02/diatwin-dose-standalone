"""
CORS origin policy.

Every deployment URL used to cost a commit, a push and a backend redeploy, and
a blocked origin produced an unexplained `ERR_NETWORK` in the browser rather
than a CORS message — because the preflight handler echoed back whatever
`Origin` it was sent while the response handler checked a list. Preflight said
yes, the real response carried no `Access-Control-Allow-Origin`, and the
browser discarded it.

These tests pin the policy itself rather than any one hostname:

  - a listed origin is allowed
  - an unlisted origin is refused, including one that merely *contains* a
    listed one
  - preview deployments of our own Vercel teams are allowed by pattern
  - another team's Vercel project is refused — the pattern is scoped, and a
    blanket `.*\\.vercel\\.app` would let anyone's app call this API with
    credentials attached
  - `CORS_EXTRA_ORIGINS` adds origins without a code change
  - preflight and response agree, which is the defect that made this hard to
    diagnose
"""

import importlib

import pytest


@pytest.fixture
def config_module(monkeypatch):
    """Reimport config so module-level origin parsing re-runs per test."""
    def _load(extra=None):
        if extra is None:
            monkeypatch.delenv("CORS_EXTRA_ORIGINS", raising=False)
        else:
            monkeypatch.setenv("CORS_EXTRA_ORIGINS", extra)
        import config
        return importlib.reload(config)
    return _load


class TestOriginPolicy:
    def test_a_listed_origin_is_allowed(self, config_module):
        config = config_module()
        assert config.is_origin_allowed("https://diatwin.vercel.app")

    def test_the_new_production_origin_is_allowed(self, config_module):
        # The one that was actually broken: HTTP 200 with no
        # access-control-allow-origin, which axios reports as ERR_NETWORK.
        config = config_module()
        assert config.is_origin_allowed("https://diatwin-ten.vercel.app")

    def test_an_unknown_origin_is_refused(self, config_module):
        config = config_module()
        assert not config.is_origin_allowed("https://evil.example.com")

    def test_no_origin_is_refused(self, config_module):
        config = config_module()
        assert not config.is_origin_allowed(None)
        assert not config.is_origin_allowed("")

    def test_a_prefix_or_suffix_of_a_listed_origin_is_refused(self, config_module):
        # A substring check instead of equality would allow all of these.
        config = config_module()
        for origin in (
            "https://diatwin.vercel.app.evil.com",
            "https://evil.com/https://diatwin.vercel.app",
            "https://notdiatwin.vercel.app",
        ):
            assert not config.is_origin_allowed(origin), origin

    def test_a_trailing_slash_does_not_change_the_verdict(self, config_module):
        config = config_module()
        assert config.is_origin_allowed("https://diatwin.vercel.app/")


class TestPreviewPatterns:
    def test_our_preview_deployments_are_allowed(self, config_module):
        # Vercel names each preview after the commit, so no fixed list works.
        config = config_module()
        assert config.is_origin_allowed("https://diatwin-a4jd1n5pv-clidatech.vercel.app")
        assert config.is_origin_allowed("https://diatwin-git-master-clidatech.vercel.app")

    def test_another_teams_vercel_project_is_refused(self, config_module):
        # The negative case that justifies scoping the pattern. A blanket
        # `.*\.vercel\.app` would allow every one of these, and the browser
        # would attach cookies and the Authorization header.
        config = config_module()
        for origin in (
            "https://anything.vercel.app",
            "https://attacker-someoneelse.vercel.app",
            "https://diatwin-abc-otherteam.vercel.app",
        ):
            assert not config.is_origin_allowed(origin), origin

    def test_the_pattern_is_anchored(self, config_module):
        # Unanchored, this would match a host that merely ends with ours.
        config = config_module()
        assert not config.is_origin_allowed(
            "https://x-clidatech.vercel.app.attacker.com")

    def test_http_is_not_accepted_for_a_preview_host(self, config_module):
        config = config_module()
        assert not config.is_origin_allowed("http://diatwin-abc-clidatech.vercel.app")


class TestExtraOriginsFromEnvironment:
    def test_an_env_origin_is_allowed(self, config_module):
        config = config_module("https://staging.example.com")
        assert config.is_origin_allowed("https://staging.example.com")

    def test_several_comma_separated_origins(self, config_module):
        config = config_module("https://a.example.com, https://b.example.com")
        assert config.is_origin_allowed("https://a.example.com")
        assert config.is_origin_allowed("https://b.example.com")

    def test_an_empty_variable_adds_nothing(self, config_module):
        config = config_module("")
        assert not config.is_origin_allowed("")
        assert config.is_origin_allowed("https://diatwin.vercel.app")

    def test_the_env_var_does_not_replace_the_baseline(self, config_module):
        config = config_module("https://staging.example.com")
        assert config.is_origin_allowed("https://diatwin.vercel.app")


class TestPreflightAndResponseAgree:
    """
    The defect that made this expensive to diagnose.

    The preflight handler echoed `Origin` back unconditionally, so OPTIONS
    always succeeded; the response handler checked the list, so the real
    request came back without the header and the browser dropped it. The two
    must now reach the same verdict for any origin.
    """

    @pytest.mark.parametrize("origin", [
        "https://diatwin-ten.vercel.app",
        "https://diatwin-abc123-clidatech.vercel.app",
        "https://evil.example.com",
        "https://anything.vercel.app",
    ])
    def test_preflight_matches_response(self, client, origin):
        allowed = client.application  # app under test built by conftest
        preflight = client.open("/api/health", method="OPTIONS",
                                headers={"Origin": origin})
        actual = client.get("/api/health", headers={"Origin": origin})

        pre_header = preflight.headers.get("Access-Control-Allow-Origin")
        act_header = actual.headers.get("Access-Control-Allow-Origin")
        assert bool(pre_header) == bool(act_header), (
            f"{origin}: preflight={pre_header!r} response={act_header!r} — "
            "a preflight that permits what the response refuses shows up in "
            "the browser as an unexplained network error")

    def test_an_allowed_origin_gets_the_header_on_a_real_request(self, client):
        response = client.get("/api/health",
                              headers={"Origin": "https://diatwin-ten.vercel.app"})
        assert response.status_code == 200
        assert response.headers.get("Access-Control-Allow-Origin") == \
            "https://diatwin-ten.vercel.app"

    def test_a_refused_origin_gets_no_header(self, client):
        response = client.get("/api/health",
                              headers={"Origin": "https://evil.example.com"})
        # The request still succeeds server-side; it is the browser that
        # enforces CORS. What matters is that we do not advertise permission.
        assert response.headers.get("Access-Control-Allow-Origin") is None
