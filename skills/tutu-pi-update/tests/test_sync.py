import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import os

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'sync.py'
spec = importlib.util.spec_from_file_location('sync', SCRIPT)
assert spec is not None
sync = importlib.util.module_from_spec(spec)


class SyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert spec is not None and spec.loader is not None
        spec.loader.exec_module(sync)

    def test_cpa_sync_preserves_extras_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            original = {'providers': {'other': {'apiKey': 'private'}, 'tu': {
                'models': [{'id': 'keep', 'contextWindow': 50,
                            'samplingParams': {'temperature': 0}}, {'id': 'gone'}]}}}
            (home / 'models.json').write_text(json.dumps(original))
            endpoint = {'data': [{'id': 'keep'}, {'id': 'new'}]}
            catalog = {'models': [{'id': 'keep', 'context_window': 200,
                                  'max_output_tokens': 100, 'thinking': {'supported': False}},
                                 {'id': 'new', 'thinking': {'supported': True,
                                                          'levels': ['off', 'high']}}]}
            result = sync.run(home, endpoint, catalog)
            self.assertEqual(result['status'], 'updated')
            saved = json.loads((home / 'models.json').read_text())
            self.assertEqual(saved['providers']['other'], original['providers']['other'])
            models = saved['providers']['tu']['models']
            self.assertEqual([m['id'] for m in models], ['keep', 'new'])
            self.assertEqual(models[0]['samplingParams'], {'temperature': 0})
            self.assertEqual(models[0]['contextWindow'], 200)
            self.assertEqual(models[1]['thinkingLevelMap']['minimal'], None)
            before = {p.name: (p.stat().st_mtime_ns, p.read_bytes())
                      for p in home.iterdir() if p.is_file()}
            self.assertEqual(sync.run(home, endpoint, catalog)['status'], 'unchanged')
            self.assertEqual(before, {p.name: (p.stat().st_mtime_ns, p.read_bytes())
                                     for p in home.iterdir() if p.is_file()})

    def test_empty_endpoint_and_invalid_catalog_parameter_do_not_write(self):
        for endpoint, catalog in [({'data': []}, None),
                                  ({'data': [{'id': 'x'}, {'id': 'x'}]}, None),
                                  ({'data': [{'id': 'x'}]}, {'models': [
                                      {'id': 'x', 'context_window': 'bad'}]})]:
            with self.subTest(endpoint=endpoint), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                original = b'{"providers": {}}'
                (home / 'models.json').write_bytes(original)
                with self.assertRaises(sync.SyncError):
                    sync.run(home, endpoint, catalog)
                self.assertEqual((home / 'models.json').read_bytes(), original)
                self.assertFalse((home / 'tutu-pi-update.cache.json').exists())
                self.assertEqual(list(home.glob('models.json.bak-*')), [])

    def test_explicit_false_clears_map_but_missing_limits_preserve_existing(self):
        for thinking in [{'supported': False}, {'supported': True, 'levels': []},
                         {'supported': True}]:
            with self.subTest(thinking=thinking):
                cur = {'id': 'x', 'contextWindow': 100, 'thinkingLevelMap': {'max': 'max'}}
                model = sync.apply_patch(cur, sync.catalog_patch({'id': 'x', 'thinking': thinking}))
                self.assertNotIn('thinkingLevelMap', model)
                self.assertEqual(model['contextWindow'], 100)
        self.assertEqual(sync.catalog_patch({'id': 'x', 'thinking': None}), {})
        self.assertEqual(sync.thinking_map(['off', 'extra-low', 'high'])['minimal'], 'extra-low')
        self.assertIsNone(sync.thinking_map(['off', 'high'])['medium'])

    def test_research_handshake_no_partial_writes_and_failure_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            ep = {'data': [{'id': 'vendor/new-model'}]}
            result = sync.run(home, ep, None)
            self.assertEqual(result['status'], 'needs_research')
            self.assertEqual(result['research'], [{'id': 'vendor/new-model', 'query': 'new-model'}])
            self.assertFalse((home / 'models.json').exists())
            result = sync.run(home, ep, None, results={'vendor/new-model': None})
            self.assertEqual(result['status'], 'updated')
            cur = json.loads((home / 'models.json').read_text())['providers']['tu']['models'][0]
            self.assertEqual(cur, {'id': 'vendor/new-model'})
            self.assertEqual(sync.run(home, ep, None)['status'], 'needs_research')
            result = sync.run(home, ep, None, results={'vendor/new-model': {
                'contextWindow': 1234, 'reasoning': False, 'sources': ['https://example.com/docs']}})
            self.assertEqual(result['status'], 'updated')
            self.assertEqual(sync.run(home, ep, None)['status'], 'unchanged')
            self.assertEqual(sync.run(home, ep, None, full=True)['status'], 'needs_research')

    def test_cpa_beats_research_and_full_and_preserves_exact_ids(self):
        ep = {'data': [{'id': 'X/A'}, {'id': 'x/a'}]}
        cat = {'models': [{'id': 'X/A', 'context_window': 99999999},
                          {'id': 'x/a', 'context_window': 333}]}
        with tempfile.TemporaryDirectory() as tmp:
            result = sync.run(Path(tmp), ep, cat, full=True, results={'X/A': {'malicious': '!command'}})
            self.assertEqual(result['actions']['cpa'], 2)
            self.assertEqual(result['research'], [])
            rows = json.loads((Path(tmp) / 'models.json').read_text())['providers']['tu']['models']
            self.assertEqual([r['contextWindow'] for r in rows], [99999999, 333])

    def test_unknown_thinking_levels_and_no_parameters_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = sync.run(Path(tmp), {'data': [{'id': 'a'}, {'id': 'b'}]},
                              {'models': [{'id': 'a'}, {'id': 'b', 'thinking': {
                                  'supported': True, 'levels': ['novel']}}]})
            self.assertEqual(len(result['warnings']), 2)
            self.assertEqual(result['research'], [])

    def test_version_cap_uses_all_endpoint_models_and_distinct_versions(self):
        ids = ['p/gpt-5.5', 'gpt-5.5-mini', 'gpt-5.4', 'gpt-5.3',
               'deepseek-v4-pro', 'deepseek-v3', 'unknown-latest']
        self.assertEqual(sync.old_versions(ids), {'gpt-5.3'})
        config = {'providers': {'tu': {'models': [{'id': 'gpt-5.5', 'contextWindow': 100},
                                                  {'id': 'gpt-5.4', 'contextWindow': 100}]}}}
        updated, entries, result = sync.build(config, {}, {'data': [{'id': x} for x in ids[:4]]}, None)
        self.assertEqual(result['actions']['skip_old'], 1)
        self.assertEqual(result['research'], [{'id': 'gpt-5.5-mini', 'query': 'gpt-5.5-mini'},
                                            {'id': 'p/gpt-5.5', 'query': 'gpt-5.5'}])
        self.assertFalse(entries['gpt-5.3']['fallback'])

    def test_custom_parameters_preserved_when_cpa_missing_even_full(self):
        cur = {'id': 'x', 'contextWindow': 50, 'headers': {'custom': 'value'}}
        cfg = {'providers': {'tu': {'models': [cur]}}}
        updated, _, result = sync.build(cfg, {}, {'data': [{'id': 'x'}]}, None, full=True)
        self.assertEqual(updated['providers']['tu']['models'], [cur])
        self.assertEqual(result['research'], [])

    def test_dry_run_creates_no_data_or_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            result = sync.run(home, {'data': [{'id': 'x'}]}, {'models': [{'id': 'x'}]}, dry_run=True)
            self.assertEqual(result['status'], 'dry_run')
            self.assertEqual([p.name for p in home.iterdir()], ['tutu-pi-update.lock'])

    def test_symlink_target_and_simultaneous_sync_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            other = home / 'sensitive'
            other.write_text('{}')
            (home / 'models.json').symlink_to(other)
            with self.assertRaises(sync.SyncError):
                sync.run(home, {'data': [{'id': 'x'}]}, None)
            self.assertEqual(other.read_text(), '{}')
            with sync.locked(home):
                with self.assertRaises(sync.SyncError):
                    with sync.locked(home):
                        self.fail('second lock acquired')

    def test_atomic_replace_failure_leaves_original_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'models.json'
            path.write_bytes(b'original')
            with patch.object(sync.os, 'replace', side_effect=OSError('disk error')):
                with self.assertRaises(OSError):
                    sync.atomic_write(path, b'new')
            self.assertEqual(path.read_bytes(), b'original')
            self.assertEqual([p.name for p in path.parent.iterdir()], ['models.json'])

    def test_cache_publication_failure_is_explicit_and_next_run_repairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            original = sync.atomic_write

            def fail_cache(path, data):
                if path.name.endswith('.cache.json'):
                    raise OSError('full')
                original(path, data)

            with patch.object(sync, 'atomic_write', side_effect=fail_cache):
                result = sync.run(home, {'data': [{'id': 'x'}]}, {'models': [{'id': 'x'}]})
            self.assertEqual(result['status'], 'partial')
            self.assertTrue((home / 'models.json').exists())
            self.assertEqual(sync.run(home, {'data': [{'id': 'x'}]},
                                      {'models': [{'id': 'x'}]})['status'], 'updated')

    def test_external_edit_during_fetch_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            path = home / 'models.json'
            path.write_text('{}')

            def fetch(url, token=False):
                if token:
                    path.write_text('{"external": true}')
                    return {'data': [{'id': 'x'}]}
                return {'models': [{'id': 'x'}]}

            with patch.object(sync, 'fetch_json', side_effect=fetch):
                with self.assertRaises(sync.SyncError):
                    sync.run(home, live=True)
            self.assertEqual(path.read_text(), '{"external": true}')

    def test_http_failure_and_invalid_json_are_bounded_and_safe(self):
        for proc in [subprocess.CompletedProcess([], 0, b'302', b''),
                     subprocess.CompletedProcess([], 28, b'000', b'secret')]:
            with patch.object(sync.subprocess, 'run', return_value=proc):
                with self.assertRaises(sync.SyncError):
                    sync.fetch_json(sync.ENDPOINT, token=True)
        with patch.object(sync.subprocess, 'run', side_effect=subprocess.TimeoutExpired('curl', 10)):
            with self.assertRaises(sync.SyncError):
                sync.fetch_json(sync.CATALOG)
        for raw in [b'{"x":1,"x":2}', b'{"x":NaN}', b'no json']:
            with self.assertRaises(sync.SyncError):
                sync.decode(raw, 'test')

    def test_live_endpoint_failure_does_not_create_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(sync, 'fetch_json', side_effect=[{'models': []}, sync.SyncError('offline')]):
                with self.assertRaises(sync.SyncError):
                    sync.run(Path(tmp), live=True)
            self.assertFalse((Path(tmp) / 'models.json').exists())

    def test_cli_end_to_end_and_noop_with_fixture_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / 'bin'
            binary.mkdir()
            curl = binary / 'curl'
            curl.write_text('''#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
data = ({'data': [{'id': 'x'}]} if args[-1].endswith('/v1/models')
        else {'models': [{'id': 'x', 'context_window': 777}]})
pathlib.Path(args[args.index('--output') + 1]).write_text(json.dumps(data))
print('200', end='')
''')
            curl.chmod(0o700)
            env = dict(os.environ, HOME=str(root), PATH=str(binary) + os.pathsep + os.environ['PATH'])
            command = ['python3', '-B', str(SCRIPT)]
            first = subprocess.run(command, env=env, capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stderr.decode())
            self.assertEqual(json.loads(first.stdout)['status'], 'updated')
            saved = json.loads((root / '.pi/agent/models.json').read_text())
            self.assertEqual(saved['providers']['tu']['models'][0]['contextWindow'], 777)
            second = subprocess.run(command, env=env, capture_output=True, check=False)
            self.assertEqual(second.returncode, 0, second.stderr.decode())
            self.assertEqual(json.loads(second.stdout)['status'], 'unchanged')

    def test_modalities_map_to_pi_input_and_missing_preserves(self):
        base = {'id': 'x', 'input': ['text', 'image']}
        cases = [({'modalities': ['file', 'image', 'text']}, ['text', 'image']),
                 ({'modalities': ['text']}, ['text']),
                 ({'modalities': []}, ['text', 'image']),
                 ({}, ['text', 'image'])]
        for row, expected in cases:
            with self.subTest(row=row):
                model = sync.apply_patch(base, sync.catalog_patch(dict(row, id='x')))
                self.assertEqual(model['input'], expected)
        self.assertNotIn('input', sync.catalog_patch({'id': 'fresh'}))
        for bad in [3, 'text', ['image', None]]:
            with self.subTest(bad=bad), self.assertRaises(sync.SyncError):
                sync.catalog_patch({'id': 'x', 'modalities': bad})

    def test_modalities_written_end_to_end_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            ep = {'data': [{'id': 'a'}, {'id': 'b'}]}
            cat = {'models': [{'id': 'a', 'modalities': ['file', 'image', 'text']},
                              {'id': 'b', 'modalities': ['text']}]}
            result = sync.run(home, ep, cat)
            self.assertEqual(result['status'], 'updated')
            rows = json.loads((home / 'models.json').read_text())['providers']['tu']['models']
            self.assertEqual(rows[0]['input'], ['text', 'image'])
            self.assertEqual(rows[1]['input'], ['text'])
            cat['models'][0]['modalities'] = ['text']  # Upstream dropped image support.
            sync.run(home, ep, cat)
            rows = json.loads((home / 'models.json').read_text())['providers']['tu']['models']
            self.assertEqual(rows[0]['input'], ['text'])
            del cat['models'][0]['modalities']  # Field absent: keep current value.
            self.assertEqual(sync.run(home, ep, cat)['status'], 'unchanged')

    def test_name_and_cost_mapping_from_catalog(self):
        base = {'id': 'x', 'name': 'Old Name', 'cost': {'input': 1, 'tiers': [{'input': 9}]}}
        row = {'display_name': 'Vendor: X Pro',
               'pricing': {'currency': 'USD', 'input_per_mtok': 2, 'output_per_mtok': 10,
                           'cache_read_per_mtok': 0.19999999999999998}}
        model = sync.apply_patch(base, sync.catalog_patch(dict(row, id='x')))
        self.assertEqual(model['name'], 'Vendor: X Pro')
        self.assertEqual(model['cost'], {'input': 2, 'output': 10, 'cacheRead': 0.2,
                                         'cacheWrite': 0, 'tiers': [{'input': 9}]})
        self.assertEqual(sync.apply_patch(base, sync.catalog_patch({'id': 'x'})), base)
        warnings = []
        patch = sync.catalog_patch(
            {'id': 'x', 'pricing': {'currency': 'EUR', 'input_per_mtok': 1}}, warnings)
        self.assertNotIn('cost', patch)
        self.assertTrue(warnings)
        with self.assertRaises(sync.SyncError):
            sync.catalog_patch({'id': 'x', 'pricing': 'bad'})
        with self.assertRaises(sync.SyncError):
            sync.catalog_patch({'id': 'x', 'pricing': {'currency': 'USD', 'input_per_mtok': '2'}})
        with self.assertRaises(sync.SyncError):
            sync.catalog_patch({'id': 'x', 'pricing': {'currency': 'USD',
                                                       'cache_write_per_mtok': -1}})
        with self.assertRaises(sync.SyncError):
            sync.catalog_patch({'id': 'x', 'display_name': '   '})

    def test_name_cost_input_written_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            ep = {'data': [{'id': 'a'}]}
            cat = {'models': [{'id': 'a', 'display_name': 'Vendor: A',
                               'modalities': ['text', 'image'],
                               'pricing': {'currency': 'USD', 'input_per_mtok': 1.5,
                                           'output_per_mtok': 3, 'cache_read_per_mtok': 0.1,
                                           'cache_write_per_mtok': 2}}]}
            result = sync.run(home, ep, cat)
            self.assertEqual(result['status'], 'updated')
            row = json.loads((home / 'models.json').read_text())['providers']['tu']['models'][0]
            self.assertEqual(row['name'], 'Vendor: A')
            self.assertEqual(row['input'], ['text', 'image'])
            self.assertEqual(row['cost'], {'input': 1.5, 'output': 3,
                                           'cacheRead': 0.1, 'cacheWrite': 2})
            self.assertEqual(sync.run(home, ep, cat)['status'], 'unchanged')

    def test_partial_cost_repaired_even_on_cache_hit_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            broken = {'id': 'a', 'cost': {'input': 1}, 'contextWindow': 100}
            (home / 'models.json').write_text(json.dumps(
                {'providers': {'tu': {'models': [broken]}}}))
            (home / 'tutu-pi-update.cache.json').write_text(json.dumps(
                {'syncedAt': 't', 'models': {'a': {'model': broken, 'fallback': False}}}))
            ep = {'data': [{'id': 'a'}]}
            result = sync.run(home, ep, {'models': []})  # Catalog empty: cache-hit path.
            self.assertEqual(result['status'], 'updated')
            saved = json.loads((home / 'models.json').read_text())['providers']['tu']['models'][0]
            self.assertEqual(saved['cost'], {'input': 1, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0})
            cache = json.loads((home / 'tutu-pi-update.cache.json').read_text())['models']['a']['model']
            self.assertEqual(cache['cost']['cacheWrite'], 0)
            self.assertEqual(sync.run(home, ep, {'models': []})['status'], 'unchanged')

    def test_false_reasoning_with_malformed_levels_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(sync.SyncError):
                sync.run(Path(tmp), {'data': [{'id': 'x'}]}, {'models': [
                    {'id': 'x', 'thinking': {'supported': False, 'levels': [{}]}}]})
            self.assertFalse((Path(tmp) / 'models.json').exists())

    def test_invalid_cache_is_repaired_even_when_no_models_are_managed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            ep = {'data': [{'id': 'x'}]}
            cfg = {'providers': {'tu': {'models': [{'id': 'x', 'headers': {'custom': 'value'}}]}}}
            desired, _, _ = sync.build(cfg, {}, ep, None)
            (home / 'models.json').write_text(json.dumps(desired))
            (home / 'tutu-pi-update.cache.json').write_text('broken')
            result = sync.run(home, ep, None)
            self.assertTrue(result['cache_changed'])
            self.assertEqual(json.loads((home / 'tutu-pi-update.cache.json').read_text())['models'], {})

    def test_bad_cache_rebuilds_without_clobbering_custom_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / 'tutu-pi-update.cache.json').write_text('broken')
            (home / 'models.json').write_text(json.dumps({'providers': {'tu': {'models': [
                {'id': 'x', 'samplingParams': {'temperature': 0}}]}}}))
            result = sync.run(home, {'data': [{'id': 'x'}]}, {'models': [{'id': 'x'}]})
            self.assertIn('cache_invalid', result['warnings'][0])
            saved = json.loads((home / 'models.json').read_text())
            self.assertEqual(saved['providers']['tu']['models'][0]['samplingParams'], {'temperature': 0})
            self.assertEqual((home / 'models.json').stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
