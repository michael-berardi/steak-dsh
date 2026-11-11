from app.client import get_timeout

GRACE = 2
EFFECTIVE_TIMEOUT = get_timeout() + GRACE
