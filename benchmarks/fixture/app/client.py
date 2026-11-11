from app.settings import BASE_TIMEOUT, RETRIES


def get_timeout():
    return BASE_TIMEOUT * RETRIES
