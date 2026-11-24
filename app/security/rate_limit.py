import time
from collections import defaultdict
from typing import Dict, List
from fastapi import HTTPException, status

class InMemoryRateLimiter:
    """
    Sliding-window in-memory rate limiter.
    """
    def __init__(self):
        # key -> list of request timestamps
        self.requests: Dict[str, List[float]] = defaultdict(list)

    def check_rate_limit(self, key: str, max_requests: int = 15, window_seconds: int = 60) -> bool:
        now = time.time()
        timestamps = self.requests[key]
        
        # Clean older than window
        cutoff = now - window_seconds
        self.requests[key] = [t for t in timestamps if t > cutoff]
        
        if len(self.requests[key]) >= max_requests:
            return False
        
        self.requests[key].append(now)
        return True

    def reset(self):
        self.requests.clear()

rate_limiter = InMemoryRateLimiter()

def enforce_rate_limit(key: str, max_requests: int = 20, window_seconds: int = 60):
    if not rate_limiter.check_rate_limit(key, max_requests, window_seconds):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Please wait a moment before trying again."
        )
