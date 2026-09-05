# utils/error_handler.py
from functools import wraps
from flask import jsonify
from werkzeug.exceptions import HTTPException
import logging

logger = logging.getLogger(__name__)


def api_error_handler(f):
    """
    Turn an unhandled exception into a JSON 500, without swallowing the
    client's own errors on the way.

    D3: the previous version had a single ``except Exception`` returning 500.
    That is right for a genuine server fault and wrong for everything Werkzeug
    raises to signal a *client* fault. A malformed request body makes
    ``request.json`` raise ``BadRequest``; the blanket handler reported it as a
    server error, so a client sending bad JSON was told the server had failed,
    and the fault was logged at error level where it hid real faults in the
    noise.

    ``HTTPException`` is the base of every status Werkzeug raises —
    ``BadRequest`` (400) from a malformed body, ``UnsupportedMediaType`` (415),
    ``MethodNotAllowed`` (405), and any ``abort(...)`` a handler raises
    deliberately. All of them already carry the status the client should see,
    so they are re-raised as themselves rather than flattened to 500. That also
    fixes a quieter case: an `abort(404)` inside a decorated route used to
    come back as a 500.

    Anything else is still an unexpected server fault: logged, and reported
    without detail so an internal message cannot leak to a caller.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except HTTPException as e:
            # Client error. `description` is Werkzeug's own generic text
            # ("Failed to decode JSON object…"), never application internals.
            logger.info("API client error %s: %s", e.code, e.description)
            return jsonify({'error': e.description}), e.code or 400
        except Exception as e:
            logger.error(f"API Error: {str(e)}")
            return jsonify({'error': 'An unexpected error occurred'}), 500
    return decorated
