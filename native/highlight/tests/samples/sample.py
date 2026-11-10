import os
from typing import Optional

@decorator
class Thing(Base):
    """Docstring."""
    def method(self, x: int = 3, *args, **kw) -> Optional[str]:
        if x > 0 and not None:
            return f"value {x!r}"
        return None  # comment
