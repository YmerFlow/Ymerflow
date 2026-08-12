import importlib.metadata
import asyncio


def _load_entry_points(name):
    # Sorted by distribution name so fan-out order (and run_first's "first") is
    # deterministic instead of depending on filesystem/import order.
    eps = importlib.metadata.entry_points(group='ymerflow.hooks')
    eps = sorted((ep for ep in eps if ep.name == name), key=lambda ep: ep.dist.name)
    return [ep.load() for ep in eps]


def _run_sync(name, *args, **kwargs):
    fns = _load_entry_points(name)
    results, errors = [], []
    for fn in fns:
        try:
            r = fn(*args, **kwargs)
            if r:
                results.extend(r)
        except Exception as e:
            errors.append(e)
    if errors:
        for later in errors[1:]:
            later.__context__ = errors[0]
        raise errors[-1]
    return results


async def _run_async(name, *args, **kwargs):
    fns = _load_entry_points(name)
    results, errors = [], []
    for fn in fns:
        try:
            r = fn(*args, **kwargs)
            if asyncio.iscoroutine(r):
                r = await r
            if r:
                results.extend(r)
        except Exception as e:
            errors.append(e)
    if errors:
        for later in errors[1:]:
            later.__context__ = errors[0]
        raise errors[-1]
    return results


def _run_first(name, default, *args, **kwargs):
    """Return the first non-None result from registered plugins (dist-name order),
    or default if none answer.

    Unlike run/run_async, disagreement between plugins is not an error — first
    registered wins, the rest are silently ignored. A plugin author relying on any
    other precedence is relying on unspecified behavior.
    """
    for fn in _load_entry_points(name):
        result = fn(*args, **kwargs)
        if result is not None:
            return result
    return default


class _Namespace:
    def __init__(self, impl):
        self._impl = impl

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)

        def caller(*args, **kwargs):
            return self._impl(name, *args, **kwargs)
        return caller


class _AsyncNamespace:
    def __init__(self):
        pass

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)

        async def caller(*args, **kwargs):
            return await _run_async(name, *args, **kwargs)
        return caller


class _Hooks:
    run = _Namespace(_run_sync)
    run_async = _AsyncNamespace()
    run_first = _Namespace(_run_first)  # NOTE: signature is (name, default, *args);
                                         # _Namespace.caller forwards default through args

    @staticmethod
    def any_registered(name):
        """Whether any plugin registers a hook by this name, distinguishing "zero plugins
        registered" from "plugins registered but all returned nothing" for callers of
        run/run_async that need to fall back only in the former case."""
        return bool(_load_entry_points(name))


hooks = _Hooks()
