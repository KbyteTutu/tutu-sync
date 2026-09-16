#!/usr/bin/env python3
"""Deterministic tutu model sync. Python standard library + curl; Linux only."""
import argparse
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

BASE = 'http://192.168.125.11:8317'
ENDPOINT = BASE + '/v1/models'
CATALOG = BASE + '/v0/resource/plugins/tutu-cpa-plugin/models.json'
LEVELS = ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
PARAMS = {'contextWindow', 'maxTokens', 'reasoning', 'thinkingLevelMap', 'input', 'name', 'cost'}
STANDARD = PARAMS | {'id'}
COST_KEYS = ('input', 'output', 'cacheRead', 'cacheWrite')
MAX_BYTES = 8 * 1024 * 1024


class SyncError(Exception):
    pass


def decode(raw, label):
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError('duplicate key')
            obj[key] = value
        return obj

    def invalid_constant(value):
        raise ValueError('non-finite number')

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (ValueError, UnicodeError):
        raise SyncError(label + ': invalid JSON') from None


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def object_value(value, label):
    if not isinstance(value, dict):
        raise SyncError(label + ': expected object')
    return value


def index_models(rows, label, nonempty=False):
    if not isinstance(rows, list) or (nonempty and not rows):
        raise SyncError(label + ': expected nonempty array' if nonempty else label + ': expected array')
    result = {}
    for row in rows:
        object_value(row, label)
        ident = row.get('id')
        if not isinstance(ident, str) or not ident.strip() or any(ord(c) < 32 for c in ident):
            raise SyncError(label + ': invalid model id')
        if ident in result:
            raise SyncError(label + ': duplicate model id')
        result[ident] = row
    return result


def check_target(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise SyncError(path.name + ': must be an owned regular file, not a symlink')
    if info.st_nlink != 1:
        raise SyncError(path.name + ': hard-linked file refused')


def read_bytes(path):
    check_target(path)
    try:
        if path.stat().st_size > MAX_BYTES:
            raise SyncError(path.name + ': file too large')
        return path.read_bytes()
    except FileNotFoundError:
        return None


@contextmanager
def locked(home):
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SyncError('agent directory must be owned, non-symlink and not group/world writable')
    path = home / 'tutu-pi-update.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise SyncError('unsafe lock file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError('another tutu-pi-update is running') from None
        yield
    finally:
        os.close(fd)  # Do not unlink a lock inode used by another process.


def atomic_write(path, data):
    check_target(path)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def fetch_json(url, token=False):
    # curl supplies a TOTAL deadline; urllib socket timeouts are per-operation.
    with tempfile.TemporaryDirectory(prefix='tutu-pi-update-') as tmp:
        output = Path(tmp) / 'response.json'
        command = ['curl', '--silent', '--show-error', '--noproxy', '*',
                   '--proto', '=http', '--connect-timeout', '3', '--max-time', '8',
                   '--max-filesize', str(MAX_BYTES), '--output', str(output),
                   '--write-out', '%{http_code}']
        if token:
            command += ['--header', 'Authorization: Bearer tutu']
        try:
            proc = subprocess.run(command + [url], capture_output=True, timeout=10, check=False)
        except subprocess.TimeoutExpired:
            raise SyncError('HTTP total deadline exceeded') from None
        if proc.returncode != 0 or proc.stdout != b'200':
            # Do not echo response bodies, headers, credentials or curl stderr.
            raise SyncError('HTTP request failed (curl=%s, status=%s)' %
                            (proc.returncode, proc.stdout.decode(errors='replace')[:3]))
        if output.stat().st_size > MAX_BYTES:
            raise SyncError('HTTP response exceeds size limit')
        return decode(output.read_bytes(), 'HTTP response')


def complete_cost(model):
    """pi schema requires all four cost keys; return a normalized copy, never mutate."""
    cost = model.get('cost')
    if not isinstance(cost, dict) or all(key in cost for key in COST_KEYS):
        return model, False
    completed = dict(cost)
    for key in COST_KEYS:
        completed.setdefault(key, 0)
    normalized = dict(model)
    normalized['cost'] = completed
    return normalized, True


def thinking_map(levels):
    if not isinstance(levels, list) or any(not isinstance(x, str) or not x for x in levels):
        raise SyncError('thinking levels must be a string array')
    if not levels:
        return None  # Unknown is not evidence of support for all levels.
    mapped = {key: key if key in levels else None for key in LEVELS}
    if 'extra-low' in levels and 'minimal' not in levels:
        mapped['minimal'] = 'extra-low'  # pi key -> provider value, not a fabricated key.
    return mapped


def catalog_patch(row, warnings=None):
    """Return supplied fields only; None thinking map explicitly clears the old map."""
    patch = {}
    for source, target in [('context_window', 'contextWindow'), ('max_output_tokens', 'maxTokens')]:
        value = row.get(source)
        if value is not None:
            if type(value) is not int or value <= 0:
                raise SyncError(source + ': expected positive integer')
            patch[target] = value
    display = row.get('display_name')
    if display is not None:
        if not isinstance(display, str) or not display.strip():
            raise SyncError('display_name: expected non-empty string')
        patch['name'] = display
    modalities = row.get('modalities')
    if modalities is not None:
        if not isinstance(modalities, list) or any(not isinstance(m, str) or not m for m in modalities):
            raise SyncError('modalities: expected string array')
        if modalities:
            # pi input only has text/image; file, audio etc. are agent-level, not pi config.
            patch['input'] = ['text', 'image'] if 'image' in modalities else ['text']
    pricing = row.get('pricing')
    if pricing is not None:
        object_value(pricing, 'pricing')
        if pricing.get('currency', 'USD') != 'USD':
            if warnings is not None:
                warnings.append('non-USD pricing skipped: ' + str(pricing.get('currency')))
        else:
            for source, target in [('input_per_mtok', 'input'), ('output_per_mtok', 'output'),
                                   ('cache_read_per_mtok', 'cacheRead'),
                                   ('cache_write_per_mtok', 'cacheWrite')]:
                value = pricing.get(source)
                if value is None:
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                    raise SyncError('pricing.' + source + ': expected non-negative number')
                # Normalize binary float artifacts (0.19999999999999998 -> 0.2), keep real values.
                patch.setdefault('cost', {})[target] = round(value, 10)
            if 'cost' in patch:
                for key in COST_KEYS:
                    patch['cost'].setdefault(key, 0)  # pi rejects partial cost objects.
    thinking = row.get('thinking')
    if thinking is not None:
        object_value(thinking, 'thinking')
        supported = thinking.get('supported')
        if supported is not None:
            if type(supported) is not bool:
                raise SyncError('thinking.supported: expected boolean')
            patch['reasoning'] = supported
        levels = thinking.get('levels')
        mapped = thinking_map(levels) if levels is not None else None
        if isinstance(supported, bool) and not supported:
            patch['thinkingLevelMap'] = None
        elif levels is not None:
            patch['thinkingLevelMap'] = mapped
        elif isinstance(supported, bool) and supported:
            patch['thinkingLevelMap'] = None
    return patch


def apply_patch(model, patch):
    model = deepcopy(model)
    for key, value in patch.items():
        if value is None:
            model.pop(key, None)
        elif key == 'cost' and isinstance(model.get('cost'), dict):
            model['cost'] = {**model['cost'], **value}  # Sub-field merge keeps tiers and unknown keys.
        else:
            model[key] = value
    return model


def normalized(ident):
    # Strip routing/vendor segments for search only; never alter the endpoint id.
    name = re.sub(r'[\s_]+', '-', ident.rsplit('/', 1)[-1].lower())
    return re.sub(r'-(thinking|agent)$', '', name)


def family_version(ident):
    name = normalized(ident)
    match = re.fullmatch(r'([a-z]+(?:-[a-z]+)*?)-v?(\d+(?:[.-]\d+)*)(?:-(?:pro|max|mini|nano|flash|lite|high|low))?', name)
    if not match:
        return name, None  # Ambiguous aliases/variants must not be silently skipped.
    try:
        version = tuple(int(part) for part in re.split(r'[.-]', match[2]))
    except ValueError:
        return name, None
    return match[1], version


def old_versions(ids):
    groups = {}
    parsed = {ident: family_version(ident) for ident in ids}
    for family, version in parsed.values():
        if version is not None:
            groups.setdefault(family, set()).add(version)
    latest = {family: sorted(versions)[-2:] for family, versions in groups.items()}
    return {ident for ident, (family, version) in parsed.items()
            if version is not None and version not in latest[family]}


def research_patch(value):
    object_value(value, 'research result')
    if set(value) - {'contextWindow', 'maxTokens', 'reasoning', 'levels', 'sources'}:
        raise SyncError('research result has unsupported fields')
    sources = value.get('sources')
    if not isinstance(sources, list) or not sources or any(
            not isinstance(s, str) or not s.startswith(('https://', 'http://')) for s in sources):
        raise SyncError('research result requires source URLs')
    row = {source: value[target] for source, target in
           [('context_window', 'contextWindow'), ('max_output_tokens', 'maxTokens')] if target in value}
    if 'reasoning' in value or 'levels' in value:
        row['thinking'] = {}
        if 'reasoning' in value:
            row['thinking']['supported'] = value['reasoning']
        if 'levels' in value:
            row['thinking']['levels'] = value['levels']
    patch = catalog_patch(row)
    if not patch:
        raise SyncError('research result contains no parameters')
    return patch


def cache_entries(raw, warnings):
    if raw is None:
        return {}, False
    try:
        cache = object_value(decode(raw, 'cache'), 'cache')
        entries = object_value(cache.get('models'), 'cache.models')
        repaired = False
        for ident, entry in entries.items():
            object_value(entry, 'cache entry')
            model, changed = complete_cost(object_value(entry.get('model'), 'cache model'))
            entry['model'] = model
            repaired = repaired or changed
            if model.get('id') != ident or type(entry.get('fallback')) is not bool:
                raise SyncError('invalid cache entry')
        return entries, repaired
    except SyncError:
        warnings.append('cache_invalid: rebuilt from current models; custom values preserved')
        return {}, False


def build(config, entries, endpoint, catalog, results=None, full=False):
    """Pure plan; only unknown models produce research work. No external I/O."""
    endpoint = index_models(object_value(endpoint, 'endpoint').get('data'), 'endpoint.data', True)
    providers = object_value(config.get('providers', {}), 'providers')
    provider = object_value(providers.get('tu', {}), 'providers.tu')
    object_value(provider.get('compat', {}), 'providers.tu.compat')
    current = {ident: complete_cost(model)[0]
               for ident, model in index_models(provider.get('models', []), 'local models').items()}
    catalog_index = {}
    warnings = []
    if catalog is not None:
        try:
            catalog_index = index_models(object_value(catalog, 'catalog').get('models'), 'catalog.models')
        except SyncError as error:
            warnings.append('catalog_unavailable: ' + str(error))
    candidates = old_versions(endpoint)
    results = {} if results is None else object_value(results, 'research results')
    ordered = [ident for ident in current if ident in endpoint] + sorted(set(endpoint) - set(current))
    new_models, new_cache, pending, actions = [], {}, [], Counter()
    for ident in ordered:
        cur = current.get(ident, {'id': ident})
        previous = entries.get(ident)
        entry = previous
        if ident in catalog_index:
            # Invalid types are NOT a reason to question facts or substitute web results.
            patch = catalog_patch(catalog_index[ident], warnings)
            model = apply_patch(cur, patch)
            entry = {'model': model, 'fallback': False}
            actions['cpa'] += 1
            if not patch:
                warnings.append('catalog has no supplied parameters: ' + ident)
            unknown = set((catalog_index[ident].get('thinking') or {}).get('levels') or []) - set(LEVELS) - {'extra-low'}
            if unknown:
                warnings.append('unmapped thinking levels for ' + ident + ': ' + ', '.join(sorted(unknown)))
        else:
            custom = bool(set(cur) - STANDARD) or (previous is not None and previous['model'] != cur)
            managed = not custom and (previous is not None or set(cur) == {'id'})
            if custom or not managed:
                model = cur
                actions['preserved'] += 1
                if previous is None and not custom:
                    entry = {'model': cur, 'fallback': False}
            elif previous and not previous['fallback'] and not full:
                model = cur
                actions['cached'] += 1
            elif ident in candidates:
                model = cur
                entry = {'model': model, 'fallback': False}
                actions['skip_old'] += 1
            elif ident not in results:
                pending.append({'id': ident, 'query': normalized(ident)})
                model = cur
            elif results[ident] is None:
                model = cur  # Keep known values; new unknown models remain id-only.
                entry = {'model': model, 'fallback': True}
                actions['research_failed'] += 1
            else:
                model = apply_patch(cur, research_patch(results[ident]))
                entry = {'model': model, 'fallback': False}
                actions['researched'] += 1
        new_models.append(model)
        if entry is not None:
            new_cache[ident] = entry
    updated = deepcopy(config)
    tu = updated.setdefault('providers', {}).setdefault('tu', {})
    tu.update(baseUrl=BASE + '/v1', api='openai-completions', apiKey='tutu', models=new_models)
    tu.setdefault('compat', {}).update(supportsDeveloperRole=False, supportsReasoningEffort=True)
    report = {'models': len(endpoint), 'added': sorted(set(endpoint) - set(current)),
              'deleted': sorted(set(current) - set(endpoint)),
              'updated': [m['id'] for m in new_models if m['id'] in current and m != current[m['id']]],
              'actions': dict(actions), 'research': pending, 'warnings': warnings}
    return updated, new_cache, report


def run(home, endpoint=None, catalog=None, *, full=False, dry_run=False, results=None, live=False):
    home = Path(home)
    with locked(home):
        models_path, cache_path = home / 'models.json', home / 'tutu-pi-update.cache.json'
        original, cache_raw = read_bytes(models_path), read_bytes(cache_path)
        config = {} if original is None else object_value(decode(original, 'models.json'), 'models.json')
        warnings = []
        entries, cache_repaired = cache_entries(cache_raw, warnings)
        if live:
            try:
                catalog = fetch_json(CATALOG)
            except SyncError as error:
                warnings.append('catalog_unavailable: ' + str(error))
            endpoint = fetch_json(ENDPOINT, token=True)  # Failure aborts before any data write.
        updated, new_entries, report = build(config, entries, endpoint, catalog, results, full)
        report['warnings'] = warnings + report['warnings']
        if report['research']:
            report['status'] = 'needs_research'
            return report
        models_changed = updated != config
        cache_changed = (new_entries != entries or cache_raw is None or cache_repaired
                         or any(warning.startswith('cache_invalid:') for warning in warnings))
        report.update(status='dry_run' if dry_run else 'updated' if models_changed or cache_changed else 'unchanged',
                      models_changed=models_changed, cache_changed=cache_changed)
        if dry_run or not (models_changed or cache_changed):
            return report
        # Serialize both before publication. Re-read only here to detect non-cooperating writers.
        models_data = encode(updated)
        cache_data = encode({'syncedAt': datetime.now(timezone.utc).isoformat(), 'models': new_entries})
        if read_bytes(models_path) != original or read_bytes(cache_path) != cache_raw:
            raise SyncError('configuration changed during sync; rerun instead of overwriting')
        if models_changed:
            if original is not None:
                fd, backup = tempfile.mkstemp(prefix='models.json.bak-', dir=home)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(original)
                    stream.flush()
                    os.fsync(stream.fileno())
                report['backup'] = backup
            atomic_write(models_path, models_data)
        if cache_changed:
            try:
                atomic_write(cache_path, cache_data)
            except OSError:
                report['status'] = 'partial'
                report['warnings'].append('cache_write_failed: models published=%s; rerun sync' % models_changed)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--results', type=Path, help='JSON object keyed by endpoint id; null means lookup failed')
    args = parser.parse_args()
    started = time.monotonic()
    try:
        results = decode(args.results.read_bytes(), 'research results') if args.results else None
        report = run(Path.home() / '.pi/agent', full=args.full, dry_run=args.dry_run,
                     results=results, live=True)
        report['elapsed_ms'] = round((time.monotonic() - started) * 1000)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2 if report['status'] == 'needs_research' else 1 if report['status'] == 'partial' else 0
    except (SyncError, OSError) as error:
        # OSError can contain sensitive full paths; do not print a traceback/config values.
        message = str(error) if isinstance(error, SyncError) else 'filesystem/command failure: ' + type(error).__name__
        print(json.dumps({'status': 'error', 'message': message}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
